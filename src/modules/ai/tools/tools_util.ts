import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { remoteUnsupported } from "../lib/remoteFs";
import { checkShellCommand } from "../lib/security";
import { getSessionShell, sessionShellKey } from "../lib/sessionShell";
import { repoRootFor } from "./git";
import type { ToolContext } from "./context";

// ---------------------------------------------------------------------------
// http_request
// ---------------------------------------------------------------------------

export function buildHttpRequestTools(ctx: ToolContext) {
  return {
    http_request: tool({
      description:
        "Send an HTTP request and return the response body, status, and headers. Accepts GET/POST/PUT/DELETE etc. Prefer this over guessing shell curl when you need a raw HTTP response.",
      inputSchema: z.object({
        url: z.string().url().describe("Target URL"),
        method: z.string().default("GET").describe("HTTP method"),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Optional request headers"),
        body: z
          .string()
          .optional()
          .describe("Optional raw request body (string)"),
        allow_private_network: z
          .boolean()
          .default(false)
          .describe("Allow loopback / private network targets"),
      }),
      execute: async ({
        url,
        method,
        headers,
        body,
        allow_private_network,
      }) => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "http_request",
            "Use bash_run with curl on the remote host.",
          );
        }
        try {
          const resp = await invoke<{
            status: number;
            headers: Record<string, string>;
            body: number[];
          }>("ai_http_request", {
            url,
            method,
            headers,
            body: body ? new TextEncoder().encode(body) : undefined,
            allowPrivateNetwork: allow_private_network,
            proxyUrl: undefined,
          });
          const text = new TextDecoder().decode(new Uint8Array(resp.body));
          return {
            status: resp.status,
            headers: resp.headers,
            body: text,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  } as const;
}

// ---------------------------------------------------------------------------
// jwt_inspect
// ---------------------------------------------------------------------------

function decodeBase64UrlSegment(seg: string): string {
  let s = seg.replace(/-/g, "+").replace(/_/g, "+");
  while (s.length % 4) s += "=";
  try {
    return decodeURIComponent(
      atob(s)
        .split("")
        .map((c) => `%${(`00${c.charCodeAt(0).toString(16)}`).slice(-2)}`)
        .join(""),
    );
  } catch {
    return "";
  }
}

export function buildJwtInspectTool() {
  return {
    jwt_inspect: tool({
      description:
        "Inspect a JWT token without verifying the signature. Decodes header and payload, returns claims as JSON. Does not accept unsigned JWTs; pass the full compact serialization.",
      inputSchema: z.object({
        token: z.string().describe("Full JWT compact serialization"),
      }),
      execute: async ({ token }) => {
        try {
          const parts = token.split(".");
          if (parts.length !== 3)
            return { error: "expected 3 dot-separated segments" };
          const header = JSON.parse(decodeBase64UrlSegment(parts[0]) || "{}");
          const payload = JSON.parse(decodeBase64UrlSegment(parts[1]) || "{}");
          return {
            header,
            payload,
            signature: parts[2],
          };
        } catch (e) {
          return { error: `invalid jwt: ${e}` };
        }
      },
    }),
  } as const;
}

// ---------------------------------------------------------------------------
// secret_scan
// ---------------------------------------------------------------------------

const SECRET_RE =
  /(?:secret|api[_-]?key|token|password|passwd|auth|bearer)\s*[=:]\s*[^\s'"]+/i;

export function buildSecretScanTool() {
  return {
    secret_scan: tool({
      description:
        "Scan a file for lines that look like secrets (API keys, tokens, passwords). Returns the matching lines with line numbers. Not a substitute for a real secrets scanner.",
      inputSchema: z.object({
        path: z.string().describe("File path to scan"),
      }),
      execute: async ({ path }) => {
        try {
          const resolved =
            path.startsWith("/") || /^[a-zA-Z]:\\/.test(path)
              ? path
              : `${repoRootFor(null, null)}/${path}`;
          const r = await native.readFile(resolved);
          if (r.kind !== "text" || !r.content) return { matches: [] };
          const lines = r.content.split(/\r?\n/);
          const matches: Array<{ line: number; text: string }> = [];
          for (let i = 0; i < lines.length; i++) {
            if (SECRET_RE.test(lines[i])) {
              matches.push({ line: i + 1, text: lines[i] });
            }
          }
          return { path: resolved, matches };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  } as const;
}

// ---------------------------------------------------------------------------
// hash_calc
// ---------------------------------------------------------------------------

async function sha256(message: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuf = await crypto.subtle.digest("SHA-256", msgUint8);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function md5(message: string): Promise<string> {
  // MD5 is not available in WebCrypto; use a tiny pure-JS implementation.
  // This is only for tool use, not cryptography.
  const msgUint8 = new TextEncoder().encode(message);
  const len = msgUint8.length;
  const bits = len * 8;
  // Padding
  const padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
  padded.set(msgUint8);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bits, true);

  const s = (n: number) => n >>> 0;
  const f = (x: number, y: number, z: number) => (x & y) | (~x & z);
  const _G = (x: number, y: number, z: number) => (x & z) | (y & ~z);
  const h = (x: number, y: number, z: number) => x ^ y ^ z;
  const i = (x: number, y: number, z: number) => y ^ (x | ~z);
  const rol = (x: number, n: number) => s((x << n) | (x >>> (32 - n)));

  const K = new Uint32Array(64);
  for (let j = 0; j < 64; j++) {
    K[j] = s(Math.floor(Math.abs(Math.sin(j + 1)) * 0x1_0000_0000));
  }

  let A = 0x67452301;
  let B = 0xefcdab89;
  let C = 0x98badcfe;
  let D = 0x10325476;

  for (let j = 0; j < padded.length; j += 64) {
    const M = new Uint32Array(16);
    for (let k = 0; k < 16; k++) {
      M[k] = view.getUint32(j + k * 4, true);
    }
    let a = A,
      b = B,
      c = C,
      d = D;
    for (let k = 0; k < 64; k++) {
      let F: number, idx: number;
      if (k < 16) {
        F = f(b, c, d);
        idx = k;
      } else if (k < 32) {
        F = _G(b, c, d);
        idx = (5 * k + 1) % 16;
      } else if (k < 48) {
        F = h(b, c, d);
        idx = (3 * k + 5) % 16;
      } else {
        F = i(b, c, d);
        idx = (7 * k) % 16;
      }
      const temp = s(s(rol(a, 5)) + F + d + K[k] + M[idx]);
      a = d;
      d = c;
      c = s(rol(b, 30));
      b = temp;
    }
    A = s(A + a);
    B = s(B + b);
    C = s(C + c);
    D = s(D + d);
  }
  const toHex = (n: number) => ((n >>> 0) >>> 0).toString(16).padStart(8, "0");
  return `${toHex(A)}${toHex(B)}${toHex(C)}${toHex(D)}`;
}

export function buildHashCalcTool() {
  return {
    hash_calc: tool({
      description:
        "Compute a hash of the given string. Supported algorithms: md5, sha256. Returns the hex digest.",
      inputSchema: z.object({
        text: z.string().describe("Input text to hash"),
        algorithm: z.enum(["md5", "sha256"]).default("sha256"),
      }),
      execute: async ({ text, algorithm }) => {
        try {
          const hash =
            algorithm === "md5" ? await md5(text) : await sha256(text);
          return { algorithm, hash };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  } as const;
}

// ---------------------------------------------------------------------------
// encoding_tool
// ---------------------------------------------------------------------------

export function buildEncodingTool() {
  return {
    encoding_tool: tool({
      description:
        "Encode or decode a string using base64 or hex. Useful for inspecting binary payloads, tokens, or blob data.",
      inputSchema: z.object({
        text: z.string().describe("Input text"),
        operation: z
          .enum(["encode_base64", "decode_base64", "encode_hex", "decode_hex"])
          .describe("What to do"),
      }),
      execute: async ({ text, operation }) => {
        try {
          let result = "";
          switch (operation) {
            case "encode_base64":
              result = btoa(unescape(encodeURIComponent(text)));
              break;
            case "decode_base64":
              result = decodeURIComponent(
                escape(atob(text.replace(/\s/g, ""))),
              );
              break;
            case "encode_hex":
              result = Array.from(new TextEncoder().encode(text))
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");
              break;
            case "decode_hex": {
              const hex = text.replace(/\s/g, "");
              if (hex.length % 2 !== 0)
                return { error: "odd-length hex string" };
              const bytes = new Uint8Array(hex.length / 2);
              for (let j = 0; j < bytes.length; j++) {
                bytes[j] = parseInt(hex.slice(j * 2, j * 2 + 2), 16);
              }
              result = new TextDecoder().decode(bytes);
              break;
            }
          }
          return { operation, result };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  } as const;
}

// ---------------------------------------------------------------------------
// archive_tool
// ---------------------------------------------------------------------------

export function buildArchiveTool(ctx: ToolContext) {
  return {
    archive_tool: tool({
      description:
        "Create or extract archives using system tar/zip. For create, pass `paths` and an optional `output`. For extract, pass `archive` and an optional `destination`.",
      inputSchema: z.object({
        action: z.enum(["create", "extract"]).describe("create or extract"),
        paths: z
          .array(z.string())
          .optional()
          .describe("Files/dirs to archive (create only)"),
        output: z
          .string()
          .optional()
          .describe("Output archive path (create only)"),
        archive: z.string().describe("Archive path (extract only)"),
        destination: z
          .string()
          .optional()
          .describe("Extraction destination (extract only)"),
      }),
      needsApproval: true,
      execute: async ({ action, paths, output, archive, destination }) => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "archive_tool",
            "Use bash_run with tar/zip on the remote host.",
          );
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = repoRootFor(ctx.getWorkspaceRoot(), ctx.getCwd());
        let command = "";
        if (action === "create") {
          const out = output || "archive.tar.gz";
          const src = paths && paths.length > 0 ? paths : ["."];
          command = `tar -czf ${src.map((p) => quoteShellArg(p)).join(" ")} -f ${quoteShellArg(out)}`;
        } else {
          const dest = destination || ".";
          command = `tar -xzf ${quoteShellArg(archive)} -C ${quoteShellArg(dest)}`;
        }
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        try {
          const shellId = await getSessionShell(
            sessionShellKey("archive", sid, ctx.getWorkspaceRoot()),
            cwd,
          );
          const r = await native.shellSessionRun(shellId, command, cwd, 300);
          return {
            action,
            command,
            stdout: r.stdout,
            stderr: r.stderr,
            exit_code: r.exit_code,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  } as const;
}

function quoteShellArg(arg: string): string {
  if (/^[A-Za-z0-9_.\-/]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
