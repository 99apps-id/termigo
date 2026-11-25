import { PLATFORM } from "@/lib/platform";
import { arch } from "@tauri-apps/plugin-os";
import { sanitizeMuseSseLine } from "./museSse";
import {
  chatToResponsesBody,
  chatToResponsesNativeBody,
  isAttestationDenial,
  responsesNativeStreamToChatSse,
  responsesStreamToChatSse,
  responsesUrl,
} from "./museTextTools";

/**
 * Muse stream normalisation, applied as a `fetch` wrapper around the shared
 * proxy fetch. See `museSse.ts` for why the SSE lines need rewriting. Only a
 * successful SSE response is touched; errors and JSON bodies pass through so
 * the SDK's own error handling still sees them.
 *
 * Like termixgo's client, every Muse call goes to the Responses route
 * first, with tools registered as the one `muse` namespace tool (see
 * `museTextTools.ts`): that is the official client's shape, and the one
 * Meta serves native tool calls to. When Meta refuses a credential with
 * `client_attestation_denied` -- the subscription-key case -- the
 * credential is remembered and the call is retried on the same route
 * under the text tool protocol instead. Later calls with the same
 * credential go straight to the text protocol, so the refusal is paid
 * once per login, not on every step. Either way the Responses stream is
 * translated back into chat-completions chunks for the SDK. The plain
 * chat route remains only for bodies neither translation takes.
 *
 * Around both routes sits termixgo's recovery shape: transient statuses
 * and transport errors retry with `Retry-After` honoured, and a stale-key
 * rejection (401, 404, a non-attestation 403) triggers one remint through
 * `opts.remint` and one retry with the fresh credential, which later calls
 * then reuse. Without a remint wired, errors pass through as before.
 *
 * Every request also carries the official Muse build identity
 * (`muse-build/1.4.24`, the `tbh:exec` client id and a stable per-credential
 * session header set), matching termixgo's museidentity; a remint starts a
 * fresh session identity.
 */

function isEventStream(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("text/event-stream");
}

function sanitizeSseStream(
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          controller.enqueue(
            encoder.encode(sanitizeMuseSseLine(buffer.slice(0, index + 1))),
          );
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer)
          controller.enqueue(encoder.encode(sanitizeMuseSseLine(buffer)));
      },
    }),
  );
}

/** Credentials Meta has refused native tool use for. Keys stay in memory
 * only; the set is the sticky switch, never a log or a store. */
const textToolCredentials = new Set<string>();

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function authorizationOf(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): string {
  const headers =
    init?.headers ?? (input instanceof Request ? input.headers : undefined);
  if (!headers) return "";
  if (headers instanceof Headers) return headers.get("authorization") ?? "";
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === "authorization") return value;
    }
    return "";
  }
  for (const [key, value] of Object.entries(
    headers as Record<string, string>,
  )) {
    if (key.toLowerCase() === "authorization") return value;
  }
  return "";
}

/**
 * Retries one chat request on the Responses route under the text tool
 * protocol and translates the reply back into chat-completions SSE.
 * Returns null when the request is not a translatable chat body, so the
 * caller can surface the original response instead.
 */
async function textToolRequest(
  base: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response | null> {
  if (typeof init?.body !== "string") return null;
  let chatBody: unknown;
  try {
    chatBody = JSON.parse(init.body);
  } catch {
    return null;
  }
  const responsesBody = chatToResponsesBody(chatBody);
  if (!responsesBody) return null;
  const url = responsesUrl(urlOf(input));
  if (!url) return null;
  const response = await base(url, {
    ...init,
    body: JSON.stringify(responsesBody),
  });
  if (!response.ok || !response.body) return response;
  const model =
    typeof responsesBody.model === "string" && responsesBody.model
      ? responsesBody.model
      : "muse";
  const sseText = await response.text();
  return new Response(responsesStreamToChatSse(sseText, model), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * One attempt on the native Responses route: tools registered as the one
 * `muse` namespace tool, the reply's real function_call items translated
 * back into chat-completions chunks. Returns null when the request is not
 * a translatable chat body, and the raw response when Meta answered with
 * an error, so the caller can classify it (attestation, stale key, or a
 * plain failure to surface).
 */
async function nativeResponsesRequest(
  base: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  sessionId: string,
): Promise<Response | null> {
  if (typeof init?.body !== "string") return null;
  let chatBody: unknown;
  try {
    chatBody = JSON.parse(init.body);
  } catch {
    return null;
  }
  const responsesBody = chatToResponsesNativeBody(chatBody, sessionId);
  if (!responsesBody) return null;
  const url = responsesUrl(urlOf(input));
  if (!url) return null;
  const response = await base(url, {
    ...init,
    body: JSON.stringify(responsesBody),
  });
  if (!response.ok || !response.body) return response;
  const model =
    typeof responsesBody.model === "string" && responsesBody.model
      ? responsesBody.model
      : "muse";
  const sseText = await response.text();
  return new Response(responsesNativeStreamToChatSse(sseText, model), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export type MuseFetchOptions = {
  /** Mint a fresh credential after the API rejects the current one as stale
   *  (401, 404, or a 403 that is not the attestation refusal). Returns the
   *  new access token, or null when renewal is impossible. */
  remint?: () => Promise<string | null>;
};

/** Credentials Meta retired, mapped to the credential that replaced them.
 *  The model is built once per login, so without this every later call
 *  would pay the rejection-plus-remint round trip again. In memory only,
 *  like the text-protocol set above. */
const refreshedCredentials = new Map<string, string>();

/** Credentials whose native Responses route Meta has accepted. The
 *  native route is every unclassified credential's first attempt anyway;
 *  the set exists so a remint can carry the classification over to the
 *  fresh credential. In memory only. */
const nativeResponsesCredentials = new Set<string>();

/** The official Muse build identity, termixgo's museidentity shape: the
 *  gateway routes subscription traffic by it, and a generic client
 *  User-Agent is part of what marks a request as third-party. */
function museUserAgent(): string {
  let slug = "unknown";
  try {
    const os = PLATFORM === "macos" ? "darwin" : PLATFORM;
    let cpu = "";
    try {
      cpu = arch();
    } catch {
      cpu = "";
    }
    const archSlug =
      cpu === "x86_64" ? "amd64" : cpu === "aarch64" ? "arm64" : cpu;
    if (os) slug = archSlug ? `${os}-${archSlug}` : os;
  } catch {
    // Outside the Tauri host the slug stays "unknown"; the header is an
    // identity string, not a capability claim.
  }
  return `muse-build/1.4.24 (non-interactive; ${slug})`;
}

/** One stable session identity per credential, termixgo's shape: the same
 *  ids ride every request until the credential is reminted, which is the
 *  reset point -- a fresh credential gets a fresh session rather than
 *  inheriting the one Meta just rejected. */
type MuseSessionIdentity = {
  sessionId: string;
  gatewaySessionId: string;
  threadId: string;
  rootSessionId: string;
};

const sessionByCredential = new Map<string, MuseSessionIdentity>();

function newSessionIdentity(): MuseSessionIdentity {
  return {
    sessionId: crypto.randomUUID(),
    gatewaySessionId: crypto.randomUUID(),
    threadId: crypto.randomUUID(),
    rootSessionId: crypto.randomUUID(),
  };
}

function sessionIdentityFor(credential: string): MuseSessionIdentity {
  let identity = sessionByCredential.get(credential);
  if (!identity) {
    identity = newSessionIdentity();
    sessionByCredential.set(credential, identity);
  }
  return identity;
}

function withIdentityHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  identity: MuseSessionIdentity,
): RequestInit {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set("user-agent", museUserAgent());
  headers.set("x-client-id", "tbh:exec");
  headers.set("x-tbh-session-id", identity.sessionId);
  headers.set("x-meta-ai-gateway-session-id", identity.gatewaySessionId);
  headers.set("x-tbh-thread-id", identity.threadId);
  headers.set("x-tbh-root-session-id", identity.rootSessionId);
  headers.set("x-tbh-agent-role", "main");
  return { ...init, headers };
}

/** Statuses worth retrying as-is: rate limits and transient overload. 404
 *  joins them in the remint path below, not here, because for Muse a 404
 *  usually means a stale key rather than a missing resource. */
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
const MAX_TRANSIENT_RETRIES = 3;

function retryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 20_000);
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return Math.min(Math.max(date - Date.now(), 0), 20_000);
    }
  }
  return Math.min(600 * 2 ** attempt, 4_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One sender with termixgo's retry shape: transient statuses and transport
 *  errors are retried with `Retry-After` honoured (capped at 20 s) and a
 *  short exponential backoff. Retrying at the fetch layer is safe because
 *  nothing has consumed the response body yet. An aborted signal stops the
 *  ladder immediately. */
async function sendWithTransientRetry(
  base: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response> {
  let attempt = 0;
  for (;;) {
    let response: Response;
    try {
      response = await base(input, init);
    } catch (error) {
      if (init?.signal?.aborted || attempt >= MAX_TRANSIENT_RETRIES) {
        throw error;
      }
      await sleep(retryDelayMs(null, attempt));
      attempt += 1;
      continue;
    }
    if (
      !TRANSIENT_STATUSES.has(response.status) ||
      init?.signal?.aborted ||
      attempt >= MAX_TRANSIENT_RETRIES
    ) {
      return response;
    }
    await response.body?.cancel().catch(() => {});
    await sleep(retryDelayMs(response, attempt));
    attempt += 1;
  }
}

function withAuthorization(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  value: string,
): RequestInit {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set("authorization", value);
  return { ...init, headers };
}

export function createMuseFetch(
  base: typeof fetch,
  opts?: MuseFetchOptions,
): typeof fetch {
  return async (input, init) => {
    let authorization = authorizationOf(input, init);
    // A credential Meta already retired once: go straight to its
    // replacement instead of paying the rejection again on every call.
    const replacement = authorization
      ? refreshedCredentials.get(authorization)
      : undefined;
    if (replacement && replacement !== authorization) {
      init = withAuthorization(input, init, replacement);
      authorization = replacement;
    }
    // Every Muse request carries the official build identity and this
    // credential's stable session headers, on both routes.
    if (authorization) {
      init = withIdentityHeaders(
        input,
        init,
        sessionIdentityFor(authorization),
      );
    }
    const send = (i: RequestInfo | URL, ini: RequestInit | undefined) =>
      sendWithTransientRetry(base, i, ini);

    // Attestation fallback: on Meta's refusal, remember the credential and
    // retry under the text tool protocol. Returns null when the 403 is
    // something else, so the remint path below can see it.
    const attestationFallback = async (
      res: Response,
      auth: string,
      ini: RequestInit | undefined,
    ): Promise<Response | null> => {
      if (res.status !== 403) return null;
      const bodyText = await res
        .clone()
        .text()
        .catch(() => "");
      if (!isAttestationDenial(res.status, bodyText)) return null;
      if (auth) textToolCredentials.add(auth);
      return textToolRequest(send, input, ini);
    };

    // One attempt for one credential, termixgo's route order: the native
    // Responses route first (tools as the one `muse` namespace tool), the
    // text protocol for a credential Meta attestation-refused, and the
    // plain chat route only for a body neither translation takes (the
    // SDK's non-chat calls). A native success marks the credential so the
    // route choice is remembered, though the native route is the default
    // for every unclassified credential anyway.
    const runAttempt = async (
      ini: RequestInit | undefined,
      auth: string,
    ): Promise<Response> => {
      if (auth && textToolCredentials.has(auth)) {
        const viaText = await textToolRequest(send, input, ini);
        if (viaText) return viaText;
      } else if (auth) {
        const native = await nativeResponsesRequest(
          send,
          input,
          ini,
          sessionIdentityFor(auth).sessionId,
        );
        if (native) {
          if (native.status === 403) {
            const viaAtt = await attestationFallback(native, auth, ini);
            if (viaAtt) return viaAtt;
          }
          if (native.ok) nativeResponsesCredentials.add(auth);
          return native;
        }
      }
      const response = await send(input, ini);
      if (response.status === 403 && auth) {
        const viaAtt = await attestationFallback(response, auth, ini);
        if (viaAtt) return viaAtt;
      }
      if (!response.ok || !response.body || !isEventStream(response)) {
        return response;
      }
      return new Response(sanitizeSseStream(response.body), {
        status: response.status,
        statusText: response.statusText,
        headers: { "content-type": "text/event-stream" },
      });
    };

    let response = await runAttempt(init, authorization);

    // Auth recovery, termixgo's ladder: a stale-key rejection (401, 404, or
    // a 403 that was not attestation) earns one remint and one retry with
    // the fresh credential, re-running the same route logic. This now also
    // covers the text route, whose error responses used to return before
    // the ladder could see them. A pay-as-you-go key has no remint behind
    // it; opts.remint is only wired for the OAuth login.
    if (
      opts?.remint &&
      authorization &&
      (response.status === 401 ||
        response.status === 404 ||
        response.status === 403)
    ) {
      const freshToken = await opts.remint().catch(() => null);
      if (freshToken) {
        const freshAuth = `Bearer ${freshToken}`;
        if (freshAuth !== authorization) {
          refreshedCredentials.set(authorization, freshAuth);
          // A remint is a session reset: the fresh credential starts a
          // fresh session identity rather than reusing the rejected one.
          sessionByCredential.set(freshAuth, newSessionIdentity());
          // A credential already known to need the text protocol (or
          // confirmed native) keeps its route under its replacement; the
          // classification is keyed by credential.
          if (textToolCredentials.has(authorization)) {
            textToolCredentials.add(freshAuth);
          }
          if (nativeResponsesCredentials.has(authorization)) {
            nativeResponsesCredentials.add(freshAuth);
          }
          const retryInit = withIdentityHeaders(
            input,
            withAuthorization(input, init, freshAuth),
            sessionIdentityFor(freshAuth),
          );
          response = await runAttempt(retryInit, freshAuth);
        }
      }
    }

    return response;
  };
}
