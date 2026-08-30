// Executes an HTTP request from the API client through the Rust `ai_http_request`
// command.
//
// Reusing the AI-provider proxy command means the request bypasses the webview's
// CORS / Mixed-Content restrictions. Unlike the agent's `fetch` tool we pass
// `allowPrivateNetwork: true` — the user typed the URL, so hitting a local dev
// server or a private network API is intentional, not a prompt-injection.

import { invoke } from "@tauri-apps/api/core";

type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: number[];
};

export type SendRequestOptions = {
  url: string;
  method: string;
  headers?: Record<string, string> | null;
  body?: string | null;
};

export type SendResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  sizeBytes: number;
  durationMs: number;
  contentType: string;
  error?: string;
};

function header(headers: Record<string, string>, name: string): string {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return "";
}

export async function sendRequest(
  opts: SendRequestOptions,
): Promise<SendResponse> {
  const started = Date.now();
  try {
    const resp = await invoke<HttpResponse>("ai_http_request", {
      url: opts.url,
      method: opts.method,
      headers: opts.headers ?? null,
      body:
        opts.body != null
          ? Array.from(new TextEncoder().encode(opts.body))
          : null,
      allowPrivateNetwork: true,
    });
    const bytes = new Uint8Array(resp.body);
    const text = new TextDecoder("utf-8").decode(bytes);
    const contentType = header(resp.headers, "content-type");
    return {
      status: resp.status,
      statusText: statusText(resp.status),
      headers: resp.headers,
      body: text,
      sizeBytes: bytes.length,
      durationMs: Date.now() - started,
      contentType,
    };
  } catch (e) {
    return {
      status: 0,
      statusText: "error",
      headers: {},
      body: "",
      sizeBytes: 0,
      durationMs: Date.now() - started,
      contentType: "",
      error: String(e),
    };
  }
}

function statusText(status: number): string {
  const known: Record<number, string> = {
    200: "OK",
    201: "Created",
    202: "Accepted",
    204: "No Content",
    301: "Moved Permanently",
    302: "Found",
    304: "Not Modified",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    408: "Request Timeout",
    409: "Conflict",
    422: "Unprocessable Entity",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
  };
  return known[status] ?? "";
}
