import { Channel, invoke } from "@tauri-apps/api/core";
import { info as logInfo } from "@tauri-apps/plugin-log";

/** Streaming events emitted by the Rust `ai_http_stream` command. */
type AiStreamEvent =
  | { kind: "headers"; status: number; headers: Record<string, string> }
  | { kind: "chunk"; b64: string }
  | { kind: "end" }
  | { kind: "error"; message: string };

type RequestHeaders = Record<string, string>;

/**
 * How a body crosses to Rust.
 *
 * Both sides used to speak `number[]`, which JSON writes as decimal digits and
 * commas: about three bytes of transport for every byte of payload, built and
 * parsed twice per request. An agent re-sends the whole conversation on every
 * step, so that multiplier landed on the largest thing in the app and grew
 * with the session.
 *
 * A JSON request body is already text and now travels as itself. Binary bodies
 * are rare on this path, so they pay base64's 1.33x instead of making the
 * common case pay 3x.
 */
type RequestBody =
  | { kind: "text"; text: string }
  | { kind: "base64"; data: string };

// Spreading a whole array into fromCharCode overflows the argument limit on
// anything large, so it goes a window at a time.
const B64_CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode(
      ...(bytes.subarray(i, i + B64_CHUNK) as unknown as number[]),
    );
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function headerInitToRecord(
  init: HeadersInit | undefined,
): RequestHeaders | undefined {
  if (!init) return undefined;
  const out: RequestHeaders = {};
  if (init instanceof Headers) {
    init.forEach((value, key) => {
      out[key] = value;
    });
  } else if (Array.isArray(init)) {
    for (const [k, v] of init) out[k] = v;
  } else {
    for (const [k, v] of Object.entries(init)) out[k] = String(v);
  }
  return out;
}

export async function bodyToPayload(
  body: BodyInit | null | undefined,
): Promise<RequestBody | undefined> {
  if (body == null) return undefined;
  // The common case, and the whole point: an AI request body is a JSON string,
  // so it crosses as text with no encoding step on either side.
  if (typeof body === "string") return { kind: "text", text: body };
  if (body instanceof ArrayBuffer) {
    return { kind: "base64", data: bytesToBase64(new Uint8Array(body)) };
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    return {
      kind: "base64",
      data: bytesToBase64(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      ),
    };
  }
  if (body instanceof Blob) {
    return {
      kind: "base64",
      data: bytesToBase64(new Uint8Array(await body.arrayBuffer())),
    };
  }
  // FormData / URLSearchParams / ReadableStream — uncommon for AI SDK calls,
  // and all of them read back as text.
  return { kind: "text", text: await new Response(body as BodyInit).text() };
}

export function createProxyFetch(
  opts: { allowPrivateNetwork?: boolean } = {},
): typeof fetch {
  const allowPrivate = opts.allowPrivateNetwork === true;
  return async (input, init) => proxyFetchImpl(input, init, allowPrivate);
}

/** Backwards-compatible default — refuses private networks unless the caller
 *  explicitly opts in via {@link createProxyFetch}. */
export const proxyFetch: typeof fetch = (input, init) =>
  proxyFetchImpl(input, init, false);

async function proxyFetchImpl(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  allowPrivateNetwork: boolean,
): Promise<Response> {
  const url = input instanceof URL ? input.toString() : String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = headerInitToRecord(init?.headers);
  const body = await bodyToPayload(init?.body);

  const signal = init?.signal;
  if (signal?.aborted) {
    throw makeAbortError();
  }

  const started = performance.now();
  return new Promise<Response>((resolve, reject) => {
    let resolved = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    let cancelled = false;

    const onAbort = () => {
      cancelled = true;
      if (!resolved) {
        reject(makeAbortError());
      } else if (streamController) {
        try {
          streamController.error(makeAbortError());
        } catch {
          /* already closed */
        }
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const channel = new Channel<AiStreamEvent>();
    channel.onmessage = (event) => {
      if (cancelled) return;
      switch (event.kind) {
        case "headers": {
          // Connect, TLS and the provider's own time-to-first-byte, together.
          // Splitting "the agent is slow" from "the network is slow" needs
          // this number next to the context timing, not a guess about which
          // one it was.
          void logInfo(
            `provider responded in ${Math.round(performance.now() - started)}ms ` +
              `(status ${event.status})`,
          ).catch(() => {});
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
            cancel() {
              cancelled = true;
            },
          });
          resolved = true;
          resolve(
            new Response(stream, {
              status: event.status,
              headers: new Headers(event.headers),
            }),
          );
          break;
        }
        case "chunk": {
          streamController?.enqueue(base64ToBytes(event.b64));
          break;
        }
        case "end": {
          streamController?.close();
          break;
        }
        case "error": {
          if (!resolved) {
            reject(fetchFailure(event.message));
          } else {
            streamController?.error(fetchFailure(event.message));
          }
          break;
        }
      }
    };

    invoke("ai_http_stream", {
      url,
      method,
      headers,
      body,
      allowPrivateNetwork,
      onEvent: channel,
    }).catch((e) => {
      if (resolved) return; // headers already arrived; chunk-side error wins
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

function makeAbortError(): DOMException {
  return new DOMException("Request aborted", "AbortError");
}

/**
 * Fail the way a real `fetch` fails, so the AI SDK can recognise it.
 *
 * The SDK retries a network failure twice, but only after
 * `@ai-sdk/provider-utils` rewrites it as a retryable `APICallError` - and that
 * rewrite fires only for a `TypeError` whose message is "fetch failed" or
 * "failed to fetch" and which carries a `cause`. This transport used to reject
 * with a plain `Error` holding reqwest's text, so it matched none of those and
 * the SDK's own resilience never applied: a single blip on a flaky link ended
 * the run outright.
 *
 * The detail is not thrown away - it moves to `cause`, which is exactly where
 * the SDK reads it from to build "Cannot connect to API: …".
 */
export function fetchFailure(detail: string): TypeError {
  const error = new TypeError("fetch failed");
  // `Error.cause` is ES2022 and this project's lib is ES2020, so the field is
  // set through a cast. The webview is Chromium and has had `cause` for years;
  // widening the whole project's lib is a decision of its own, not a side
  // effect of this fix.
  (error as TypeError & { cause?: unknown }).cause = new Error(detail);
  return error;
}
