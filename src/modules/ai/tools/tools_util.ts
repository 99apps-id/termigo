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
  let s = seg.replace(/-/g, "+").replace(/_/g, "/");
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

const SECRET_RE_SOURCE =
  "(?:secret|api[_-]?key|token|password|passwd|auth|bearer)\\s*[=:]\\s*[^\\s'\"]+";
const SECRET_RE = new RegExp(SECRET_RE_SOURCE, "i");

function resolveToolPath(path: string, ctx?: ToolContext): string {
  const trimmed = path.trim();
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/.test(trimmed)
  ) {
    return trimmed.replace(/\\/g, "/");
  }
  const base = repoRootFor(
    ctx?.getWorkspaceRoot() ?? null,
    ctx?.getCwd() ?? null,
  ).replace(/\\/g, "/");
  return `${base.replace(/\/+$/, "")}/${trimmed.replace(/^\.\/+/, "")}`;
}

export function buildSecretScanTool(ctx?: ToolContext) {
  return {
    secret_scan: tool({
      description:
        "Scan a file or directory for lines that look like secrets (API keys, tokens, passwords). Returns the matching lines with line numbers. Not a substitute for a real secrets scanner.",
      inputSchema: z.object({
        path: z.string().describe("File or directory path to scan"),
      }),
      execute: async ({ path }) => {
        try {
          const resolved = resolveToolPath(path, ctx);
          try {
            const r = await native.readFile(resolved);
            if (r.kind !== "text" || !r.content) return { path: resolved, matches: [] };
            const lines = r.content.split(/\r?\n/);
            const matches: Array<{ line: number; text: string }> = [];
            for (let i = 0; i < lines.length; i++) {
              if (SECRET_RE.test(lines[i])) {
                matches.push({ line: i + 1, text: lines[i] });
              }
            }
            return { path: resolved, matches };
          } catch {
            const grepRes = await native.grep({
              pattern: SECRET_RE_SOURCE,
              root: resolved,
              caseInsensitive: true,
              maxResults: 200,
            });
            return {
              path: resolved,
              matches: grepRes.hits.map((m) => ({
                file: m.path,
                line: m.line,
                text: m.text,
              })),
              truncated: grepRes.truncated,
            };
          }
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

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

async function md5(message: string): Promise<string> {
  // MD5 is not available in WebCrypto; pure-JS RFC 1321 implementation.
  const msgUint8 = new TextEncoder().encode(message);
  const len = msgUint8.length;
  const paddedLen = (((len + 8) >>> 6) + 1) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(msgUint8);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, (len << 3) >>> 0, true);
  view.setUint32(paddedLen - 4, (len >>> 29) >>> 0, true);

  const rol = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;

  const K = new Uint32Array(64);
  for (let j = 0; j < 64; j++) {
    K[j] = Math.floor(Math.abs(Math.sin(j + 1)) * 0x1_0000_0000) >>> 0;
  }

  let A = 0x67452301;
  let B = 0xefcdab89;
  let C = 0x98badcfe;
  let D = 0x10325476;

  for (let j = 0; j < paddedLen; j += 64) {
    const M = new Uint32Array(16);
    for (let k = 0; k < 16; k++) {
      M[k] = view.getUint32(j + k * 4, true);
    }
    let a = A;
    let b = B;
    let c = C;
    let d = D;
    for (let k = 0; k < 64; k++) {
      let F: number;
      let idx: number;
      if (k < 16) {
        F = (b & c) | (~b & d);
        idx = k;
      } else if (k < 32) {
        F = (d & b) | (~d & c);
        idx = (5 * k + 1) % 16;
      } else if (k < 48) {
        F = b ^ c ^ d;
        idx = (3 * k + 5) % 16;
      } else {
        F = c ^ (b | ~d);
        idx = (7 * k) % 16;
      }
      const sum = (a + F + K[k] + M[idx]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rol(sum, MD5_SHIFTS[k])) >>> 0;
    }
    A = (A + a) >>> 0;
    B = (B + b) >>> 0;
    C = (C + c) >>> 0;
    D = (D + d) >>> 0;
  }
  const toHexLE = (n: number) =>
    [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  return `${toHexLE(A)}${toHexLE(B)}${toHexLE(C)}${toHexLE(D)}`;
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
        archive: z
          .string()
          .optional()
          .describe("Archive path (extract only)"),
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
          const out = output || archive || "archive.tar.gz";
          const src = paths && paths.length > 0 ? paths : ["."];
          command = `tar -czf ${quoteShellArg(out)} -- ${src.map((p) => quoteShellArg(p)).join(" ")}`;
        } else {
          const archivePath = archive || output;
          if (!archivePath?.trim()) {
            return { error: "archive path is required for extract action" };
          }
          const dest = destination || ".";
          command = `tar -xzf ${quoteShellArg(archivePath)} -C ${quoteShellArg(dest)}`;
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
