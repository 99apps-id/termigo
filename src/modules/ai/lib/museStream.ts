import { sanitizeMuseSseLine } from "./museSse";
import {
  chatToResponsesBody,
  isAttestationDenial,
  responsesStreamToChatSse,
  responsesUrl,
} from "./museTextTools";

/**
 * Muse stream normalisation, applied as a `fetch` wrapper around the shared
 * proxy fetch. See `museSse.ts` for why the SSE lines need rewriting. Only a
 * successful SSE response is touched; errors and JSON bodies pass through so
 * the SDK's own error handling still sees them.
 *
 * The wrapper also carries the attestation fallback (see
 * `museTextTools.ts`): when Meta refuses the request with
 * `client_attestation_denied`, the credential is remembered and the call is
 * retried on the Responses route under the text tool protocol, with the
 * Responses stream translated back into chat-completions chunks. Later
 * calls with the same credential go straight to the text protocol, so the
 * refusal is paid once per login, not on every step. A pay-as-you-go Model
 * API key is never refused, so it never leaves the native path.
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

export function createMuseFetch(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const authorization = authorizationOf(input, init);
    if (authorization && textToolCredentials.has(authorization)) {
      const viaText = await textToolRequest(base, input, init);
      if (viaText) return viaText;
    }
    const response = await base(input, init);
    if (response.status === 403) {
      const bodyText = await response
        .clone()
        .text()
        .catch(() => "");
      if (isAttestationDenial(response.status, bodyText)) {
        if (authorization) textToolCredentials.add(authorization);
        const viaText = await textToolRequest(base, input, init);
        if (viaText) return viaText;
      }
      return response;
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
}
