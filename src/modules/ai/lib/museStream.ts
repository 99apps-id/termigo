import { sanitizeMuseSseLine } from "./museSse";

/**
 * Muse stream normalisation, applied as a `fetch` wrapper around the shared
 * proxy fetch. See `museSse.ts` for why the SSE lines need rewriting. Only a
 * successful SSE response is touched; errors and JSON bodies pass through so the
 * SDK's own error handling still sees them.
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
        if (buffer) controller.enqueue(encoder.encode(sanitizeMuseSseLine(buffer)));
      },
    }),
  );
}

export function createMuseFetch(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
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
