// OAuth model-call fetch adapters for the three account-based providers.
//
// The stock AI SDK providers authenticate with a plain API key and a vendor
// request shape; the signed-in providers need a short-lived OAuth access token
// plus vendor-specific wire formats the SDKs do not produce:
//
// - Codex (chatgpt.com/backend-api) rejects the SDK's default `store: true`
//   (it would write every response into the user's ChatGPT history) and needs
//   the identity headers the CLI sends: OpenAI-Beta, a session id, and the
//   ChatGPT account id from the JWT.
// - Claude needs nothing extra at call time: `Authorization: Bearer` plus the
//   anthropic-* headers the preset already carries. The adapter only re-resolves
//   a fresh token so a long agent run never sends an expired one.
// - Antigravity is Cloud Code, not the public Gemini API. The SDK would POST
//   `/v1internal/models/{model}:streamGenerateContent` with an unwrapped body,
//   but Cloud Code wants `{ project, model, request }` at
//   `/v1internal:streamGenerateContent?alt=sse` and wraps every SSE payload in
//   `{"response": {...}}`. The adapter rewrites the request and unwraps the
//   stream back to the plain GenerateContentResponse the SDK parser expects.
//
// Every request still goes through the Rust HTTP proxy, so none of this is
// subject to webview CORS.

import { ensureFreshOAuthToken } from "@/modules/oauth/bridge";
import { OAUTH_PRESETS, type OAuthProfile } from "@/modules/oauth/presets";
import { headerInitToRecord, proxyFetch } from "./proxyFetch";

export const CLOUD_CODE_BASE_URL =
  "https://cloudcode-pa.googleapis.com/v1internal";

// `/v1internal/models/{model}:streamGenerateContent` or `:generateContent`.
const CLOUD_CODE_PATH_RE =
  /^\/v1internal\/models\/([^/]+):(streamGenerateContent|generateContent)$/;

/** ChatGPT account id from the Codex access-token JWT claims. */
export function extractChatgptAccountId(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(
      b64.length + ((4 - (b64.length % 4)) % 4),
      "=",
    );
    const payload = JSON.parse(atob(padded)) as {
      "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
    };
    const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" && id.trim() ? id.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Codex stores every response in ChatGPT history when `store` is unset, and the
 * SDK defaults it to true. The CLI always sends `store: false`; force it onto
 * whatever body the SDK built. Non-JSON bodies pass through untouched.
 */
export function forceStoreFalse(bodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      (parsed as Record<string, unknown>).store = false;
      return JSON.stringify(parsed);
    }
  } catch {
    // not JSON — nothing to force
  }
  return bodyText;
}

export type CloudCodeTarget = {
  url: string;
  body: string;
  streaming: boolean;
};

/**
 * Rewrite an SDK request aimed at the Cloud Code model endpoints into the wire
 * format Cloud Code actually serves. Returns null for anything that is not a
 * Cloud Code model call (the caller passes it through unchanged).
 */
export function buildCloudCodeTarget(
  url: string,
  bodyText: string,
  projectId: string | null,
): CloudCodeTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = CLOUD_CODE_PATH_RE.exec(parsed.pathname);
  if (!match) return null;
  const model = decodeURIComponent(match[1]);
  const operation = match[2];
  const streaming = operation === "streamGenerateContent";
  if (!projectId) {
    throw new Error(
      "Antigravity needs a Cloud Code project id. Re-connect the account.",
    );
  }
  let request: unknown = {};
  if (bodyText.trim()) {
    try {
      request = JSON.parse(bodyText);
    } catch {
      return null;
    }
  }
  const target = new URL(`${CLOUD_CODE_BASE_URL}:${operation}`);
  if (streaming) target.searchParams.set("alt", "sse");
  return {
    url: target.toString(),
    body: JSON.stringify({ project: projectId, model, request }),
    streaming,
  };
}

/** Cloud Code wraps non-stream responses as `{ response: { ... } }`. */
export function unwrapCloudCodeJson(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as { response?: unknown }).response &&
      typeof (parsed as { response: unknown }).response === "object"
    ) {
      return JSON.stringify((parsed as { response: unknown }).response);
    }
  } catch {
    // keep the payload as-is
  }
  return text;
}

const sseDecoder = new TextDecoder();
const sseEncoder = new TextEncoder();

function rewriteCloudCodeEvent(event: string): string {
  const lines = event.split("\n");
  let changed = false;
  const out = lines.map((line) => {
    if (!line.startsWith("data:")) return line;
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") return line;
    try {
      const parsed: unknown = JSON.parse(data);
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as { response?: unknown }).response &&
        typeof (parsed as { response: unknown }).response === "object"
      ) {
        changed = true;
        return `data: ${JSON.stringify(
          (parsed as { response: unknown }).response,
        )}`;
      }
    } catch {
      // keep the line
    }
    return line;
  });
  return changed ? out.join("\n") : event;
}

/**
 * Transform the Cloud Code SSE stream back to the plain GenerateContentResponse
 * payloads the SDK parser expects, unwrapping `{"response": {...}}` data lines.
 */
export function cloudCodeSseUnwrap(): TransformStream<Uint8Array, Uint8Array> {
  let buffer = "";
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += sseDecoder.decode(chunk, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      // Re-scan each pass: computing the index once and testing it in the
      // condition never terminates, because consuming the event does not change
      // the stale index.
      for (
        let idx = buffer.indexOf("\n\n");
        idx >= 0;
        idx = buffer.indexOf("\n\n")
      ) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        controller.enqueue(
          sseEncoder.encode(rewriteCloudCodeEvent(event) + "\n\n"),
        );
      }
    },
    flush(controller) {
      const rest = buffer.replace(/\r\n/g, "\n");
      if (rest.trim()) {
        controller.enqueue(
          sseEncoder.encode(rewriteCloudCodeEvent(rest) + "\n\n"),
        );
      }
    },
  });
}

async function readBodyText(
  body: BodyInit | null | undefined,
): Promise<string | null> {
  if (body == null) return null;
  if (typeof body === "string") return body;
  return new Response(body).text();
}

/** Set a header, removing any existing case-insensitive spelling first. */
function setHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
  }
  headers[name] = value;
}

function headersWithoutLength(response: Response): Headers {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return headers;
}

async function codexRequest(
  url: string,
  init: RequestInit | undefined,
  token: string,
): Promise<Response> {
  const headers = headerInitToRecord(init?.headers) ?? {};
  setHeader(headers, "authorization", `Bearer ${token}`);
  setHeader(headers, "OpenAI-Beta", "responses=experimental");
  setHeader(headers, "session_id", crypto.randomUUID());
  const accountId = extractChatgptAccountId(token);
  if (accountId) setHeader(headers, "ChatGPT-Account-ID", accountId);
  const body = await readBodyText(init?.body);
  return proxyFetch(url, {
    ...init,
    headers,
    body: body === null ? undefined : forceStoreFalse(body),
  });
}

async function claudeRequest(
  url: string,
  init: RequestInit | undefined,
  token: string,
): Promise<Response> {
  const headers = headerInitToRecord(init?.headers) ?? {};
  setHeader(headers, "authorization", `Bearer ${token}`);
  return proxyFetch(url, { ...init, headers });
}

async function cloudCodeRequest(
  url: string,
  init: RequestInit | undefined,
  token: string,
  projectId: string | null,
): Promise<Response> {
  const body = await readBodyText(init?.body);
  const target = buildCloudCodeTarget(url, body ?? "", projectId);
  if (!target) {
    // Not a Cloud Code model call; pass the SDK request through unchanged.
    return proxyFetch(url, init);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    accept: target.streaming ? "text/event-stream" : "application/json",
    ...OAUTH_PRESETS.antigravity.upstreamHeaders,
  };
  // After the spread, and through setHeader like the other two profiles: a
  // preset must never be able to displace the credential, and the three
  // adapters should agree on casing.
  setHeader(headers, "authorization", `Bearer ${token}`);
  const response = await proxyFetch(target.url, {
    method: init?.method ?? "POST",
    headers,
    body: target.body,
    signal: init?.signal,
  });
  if (!response.ok || !response.body) return response;
  if (target.streaming) {
    return new Response(response.body.pipeThrough(cloudCodeSseUnwrap()), {
      status: response.status,
      headers: headersWithoutLength(response),
    });
  }
  const text = await response.text();
  return new Response(unwrapCloudCodeJson(text), {
    status: response.status,
    headers: headersWithoutLength(response),
  });
}

export type OAuthModelFetchOptions = {
  profile: OAuthProfile;
  /** Token captured when the model was built; fallback when refresh fails. */
  bakedToken: string;
  /** Project id captured at build time; the fresh session can also supply one. */
  projectId?: string | null;
};

/**
 * Build a fetch for an OAuth-signed provider model call. Re-resolves a fresh
 * access token before each request (the Rust side renews it when close to
 * expiry) and applies the provider-specific wire-format fixes above.
 */
export function createOAuthModelFetch(opts: OAuthModelFetchOptions): typeof fetch {
  return async (input, init) => {
    const fresh = await ensureFreshOAuthToken(opts.profile).catch(() => null);
    const token = fresh?.access_token || opts.bakedToken;
    const url = input instanceof URL ? input.toString() : String(input);
    switch (opts.profile) {
      case "antigravity":
        return cloudCodeRequest(
          url,
          init,
          token,
          fresh?.project_id ?? opts.projectId ?? null,
        );
      case "codex":
        return codexRequest(url, init, token);
      default:
        return claudeRequest(url, init, token);
    }
  };
}
