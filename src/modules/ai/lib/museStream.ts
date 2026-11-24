import { sanitizeMuseSseLine } from "./museSse";
import {
  chatToNativeResponsesBody,
  chatToResponsesBody,
  declaredChatToolNames,
  isAttestationDenial,
  museIdentityHeaders,
  type ResponsesToChatOptions,
  responsesStreamToChatSse,
  responsesUrl,
  responseToolAliases,
} from "./museTextTools";

/**
 * Muse fetch wrapper around the shared proxy fetch. A chat-completions
 * post is translated onto Meta's Responses route under the Muse Code CLI
 * identity (see `museTextTools.ts`): the `muse-build` user agent, the tbh
 * session headers and the tools as one `muse` namespace tool are what Meta
 * serves native tool calls to; the old `muse-code/1.0.2` identity on the
 * chat route was answered with plain chat only. The Responses stream is
 * buffered and translated back into chat-completions chunks, because a
 * function_call item is only complete once it has arrived whole.
 *
 * The wrapper also carries the attestation fallback: when Meta still
 * refuses the native request with `client_attestation_denied`, the
 * credential is remembered and the call is retried under the text tool
 * protocol, and later calls with the same credential go straight there, so
 * the refusal is paid once per login, not on every step. Requests that are
 * not chat posts pass through untouched, with Muse's SSE tail sanitised
 * (see `museSse.ts`).
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

function withIdentityHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  sessionId: string,
): Headers {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  for (const [key, value] of Object.entries(museIdentityHeaders(sessionId))) {
    headers.set(key, value);
  }
  headers.set("content-type", "application/json");
  return headers;
}

async function bufferedChatResponse(
  response: Response,
  model: string,
  options?: ResponsesToChatOptions,
): Promise<Response> {
  const sseText = await response.text();
  return new Response(responsesStreamToChatSse(sseText, model, options), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
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
  sessionId: string,
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
    headers: withIdentityHeaders(input, init, sessionId),
    body: JSON.stringify(responsesBody),
  });
  if (!response.ok || !response.body) return response;
  const model =
    typeof responsesBody.model === "string" && responsesBody.model
      ? responsesBody.model
      : "muse";
  return bufferedChatResponse(response, model, {
    allowedTools: declaredChatToolNames(chatBody),
    toolAliases: responseToolAliases(chatBody),
  });
}

export function createMuseFetch(base: typeof fetch): typeof fetch {
  const sessionId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : "termigo-muse";
  return async (input, init) => {
    const authorization = authorizationOf(input, init);
    const url = urlOf(input);
    // Only chat-completions posts are translated; everything else keeps
    // the original pass-through with SSE sanitising.
    if (!url.endsWith("/chat/completions") || typeof init?.body !== "string") {
      const response = await base(input, init);
      if (!response.ok || !response.body || !isEventStream(response)) {
        return response;
      }
      return new Response(sanitizeSseStream(response.body), {
        status: response.status,
        statusText: response.statusText,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (authorization && textToolCredentials.has(authorization)) {
      const viaText = await textToolRequest(base, input, init, sessionId);
      if (viaText) return viaText;
    }
    let chatBody: unknown;
    try {
      chatBody = JSON.parse(init.body);
    } catch {
      return base(input, init);
    }
    const nativeBody = chatToNativeResponsesBody(chatBody, sessionId);
    const responsesURL = responsesUrl(url);
    if (!nativeBody || !responsesURL) return base(input, init);
    const response = await base(responsesURL, {
      ...init,
      headers: withIdentityHeaders(input, init, sessionId),
      body: JSON.stringify(nativeBody),
    });
    if (response.status === 403) {
      const bodyText = await response
        .clone()
        .text()
        .catch(() => "");
      if (isAttestationDenial(response.status, bodyText)) {
        if (authorization) textToolCredentials.add(authorization);
        const viaText = await textToolRequest(base, input, init, sessionId);
        if (viaText) return viaText;
      }
      return response;
    }
    if (!response.ok || !response.body) return response;
    const model =
      typeof nativeBody.model === "string" && nativeBody.model
        ? nativeBody.model
        : "muse";
    return bufferedChatResponse(response, model, {
      allowedTools: declaredChatToolNames(chatBody),
      toolAliases: responseToolAliases(chatBody),
    });
  };
}
