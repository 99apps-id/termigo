//
// Unified web fetch tool for Termigo.
//
// Routed through the Rust `ai_http_request` command, which already validates
// the URL, resolves the host (with automatic DoH fallback), refuses private /
// loopback / link-local addresses and pins the connection to the addresses it checked.
//
// Unifies the former separate `fetch` and `web_fetch` tools:
// - Supports both raw body inspection (`raw: true`) and readable markdown/text extraction.
// - Supports reader mode (`use_reader: true`) via r.jina.ai for single-page apps.
// - Allows user-approved local dev server verification on loopback (localhost, 127.0.0.1, ::1).
// - Both `fetch` and `web_fetch` names map to this unified implementation.

import { tool } from "ai";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import {
  capText,
  extractTitle,
  htmlToMarkdown,
  isTextual,
  looksLikeHtml,
} from "../lib/htmlText";
import { isLoopbackIpv4 } from "../lib/browserGuard";
import { usePreferencesStore } from "@/modules/settings/preferences";

type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: number[];
};

/** Header lookup that does not care about case, as HTTP does not. */
function header(headers: Record<string, string>, name: string): string {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return "";
}

const FETCH_TIMEOUT_MS = 20_000;

function withFetchTimeout<T>(
  promise: Promise<T>,
  ms: number,
  url: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `HTTP request timed out after ${Math.round(ms / 1000)}s for ${url}`,
            ),
          ),
        ms,
      );
    }),
  ]);
}

function isLoopbackTarget(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    return (
      host === "localhost" ||
      isLoopbackIpv4(host) ||
      host === "[::1]" ||
      host === "::1"
    );
  } catch {
    return false;
  }
}

export function createUnifiedWebFetchTool() {
  return tool({
    description:
      "Fetch a URL over HTTP(S) and extract clean readable text or markdown from the page. Always fetches from THIS machine, never from a connected SSH host. Supports raw response inspection with `raw: true`, and SPA markdown rendering with `use_reader: true`. Loopback/localhost is supported for local dev server verification. Private network and cloud metadata addresses are blocked. Asks for approval.",
    inputSchema: z.object({
      url: z.string().describe("Absolute HTTP or HTTPS URL to fetch."),
      raw: z
        .boolean()
        .optional()
        .describe(
          "Return the body unmodified (raw HTML, JSON, or text) instead of reducing HTML to clean markdown. Default false.",
        ),
      use_reader: z
        .boolean()
        .optional()
        .describe(
          "If true, use reader service (r.jina.ai) to render JavaScript SPAs into clean markdown.",
        ),
    }),
    needsApproval: true,
    execute: async ({ url, raw, use_reader }) => {
      const fetchUrl = use_reader ? `https://r.jina.ai/${encodeURI(url)}` : url;
      let resp: HttpResponse;
      const proxyUrl = usePreferencesStore.getState().aiHttpProxyUrl;
      try {
        resp = await withFetchTimeout(
          invoke<HttpResponse>("ai_http_request", {
            url: fetchUrl,
            method: "GET",
            headers: {
              "User-Agent":
                "Mozilla/5.0 (compatible; TermigoBot/1.0; +https://github.com/99apps-id/termigo)",
            },
            body: null,
            // User-approved dev server verification allows loopback addresses (localhost, 127.0.0.1, ::1).
            // Non-loopback private networks and cloud metadata (169.254.169.254) are strictly disallowed.
            allowPrivateNetwork: isLoopbackTarget(url),
            proxyUrl: proxyUrl || null,
          }),
          FETCH_TIMEOUT_MS,
          fetchUrl,
        );
      } catch (e) {
        const errStr = String(e);
        const isOffline =
          /getaddrinfo|econnrefused|enetunreach|offline|dns|unreachable|fetch failed|timed out|network/i.test(
            errStr,
          );
        return {
          error: errStr,
          url,
          ...(isOffline
            ? {
                isOffline: true,
                hint: "Network request failed because the machine is offline or host DNS resolution failed. Check your network or consider using DoH / doh-mcp.",
              }
            : {
                hint: "Request failed or timed out. If the site is down, slow, or blocks automated requests, consider using web_search or curl via bash_run.",
              }),
        };
      }

      const contentType = header(resp.headers, "content-type");
      const bytes = new Uint8Array(resp.body);

      if (bytes.length === 0) {
        return {
          url,
          status: resp.status,
          content: "",
          note: `Response body was empty (HTTP ${resp.status}). The server returned no content, or is blocking automated requests.`,
        };
      }

      if (!isTextual(contentType)) {
        return {
          url,
          status: resp.status,
          contentType,
          bytes: bytes.length,
          error: "response is not text; nothing to read",
        };
      }

      const body = new TextDecoder("utf-8").decode(bytes);
      if (use_reader) {
        const capped = capText(body);
        return {
          url,
          readerMode: true,
          status: resp.status,
          content: capped.text,
          ...(capped.truncated ? { truncated: true } : {}),
        };
      }

      const isHtml = looksLikeHtml(contentType, body);
      const text = !raw && isHtml ? htmlToMarkdown(body) : body;
      const capped = capText(text);

      return {
        url,
        fetchedFrom: "local machine",
        status: resp.status,
        contentType,
        ...(isHtml ? { title: extractTitle(body) } : {}),
        content: capped.text,
        ...(capped.truncated
          ? { truncated: true, hint: "response was longer than the cap" }
          : {}),
      };
    },
  });
}

export function buildFetchTools() {
  const unified = createUnifiedWebFetchTool();
  return {
    fetch: unified,
    web_fetch: unified,
  };
}
