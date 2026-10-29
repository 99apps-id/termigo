import type { LanguageModel } from "ai";

import {
  AG_HOST,
  AG_HOST_FALLBACK,
  agUserAgent,
  buildAntigravityBody,
  isObject,
  newSessionId,
  platformCode,
  projectIdFrom,
  randomHex,
  unwrapAntigravitySseLine,
  type JsonObject,
} from "./antigravityProtocol";
import { onOAuthAuthChanged } from "./oauthAuth";
import { createProxyFetch } from "./proxyFetch";

/**
 * Google Antigravity inference over the Cloud Code backend.
 *
 * Antigravity is NOT chat-completions and not the plain Gemini REST surface.
 * The request is a Cloud Code envelope (`v1internal:streamGenerateContent`)
 * whose `request` field holds a Gemini generateContent body plus a session id,
 * and each SSE event comes back wrapped as `{"response": {...}}`. This mirrors
 * the termixgo client (cli/internal/provider/antigravity.go) so the app and the
 * Go companion speak to the same endpoint the same way.
 *
 * The Vercel AI SDK has no Cloud Code provider, so the model is built with the
 * Google provider and its `fetch` is intercepted here: rewrite the URL and body
 * on the way out, unwrap the envelopes on the way back. Everything above this
 * layer (streaming, tool calls, thought signatures) stays the SDK's job.
 */

const proxyFetch = createProxyFetch({ allowPrivateNetwork: true });

// ── Project onboarding ────────────────────────────────────────────────────────
//
// The backend keys a request by `project`. loadCodeAssist answers with the
// account's existing Cloud Code project; onboarding creates one on first use.
// Both are best effort: a failure falls back to a generated id, exactly as the
// termixgo client does, so inference still has something to send.

async function agPostJson(
  token: string,
  url: string,
  payload: unknown,
): Promise<JsonObject | null> {
  try {
    const response = await proxyFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": agUserAgent(),
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function resolveProject(token: string): Promise<string> {
  const metadata = { ideType: 9, platform: platformCode(), pluginType: 2 };
  const loaded = await agPostJson(
    token,
    `${AG_HOST_FALLBACK}/v1internal:loadCodeAssist`,
    { metadata },
  );
  const project =
    projectIdFrom(loaded?.cloudaicompanionProject) ||
    projectIdFrom(loaded?.project) ||
    projectIdFrom(loaded?.projectId);
  if (project) return project;

  let tier = "legacy-tier";
  const tiers = loaded?.allowedTiers;
  if (Array.isArray(tiers)) {
    for (const candidate of tiers) {
      if (isObject(candidate) && candidate.isDefault === true) {
        if (typeof candidate.id === "string") tier = candidate.id;
        break;
      }
    }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const onboarded = await agPostJson(
      token,
      `${AG_HOST_FALLBACK}/v1internal:onboardUser`,
      { tierId: tier, metadata },
    );
    const response = onboarded?.response;
    const fromOnboard =
      projectIdFrom(
        isObject(response) ? response.cloudaicompanionProject : undefined,
      ) ||
      projectIdFrom(onboarded?.cloudaicompanionProject) ||
      projectIdFrom(response) ||
      projectIdFrom(onboarded);
    if (fromOnboard) return fromOnboard;
    if (onboarded?.done === true) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return `termixgo-${randomHex(8)}`;
}

let cachedProject: string | null = null;
let projectFlight: Promise<string> | null = null;

export function ensureAntigravityProject(token: string): Promise<string> {
  if (cachedProject && !cachedProject.startsWith("termixgo-")) {
    return Promise.resolve(cachedProject);
  }
  if (projectFlight) return projectFlight;
  projectFlight = resolveProject(token)
    .then((project) => {
      // Only cache valid Google Cloud projects. A fallback generated id
      // must not be permanently pinned, otherwise a temporary resolution
      // failure causes persistent quota/permission rejection on all future turns.
      if (project && !project.startsWith("termixgo-")) {
        cachedProject = project;
      }
      return project;
    })
    .finally(() => {
      projectFlight = null;
    });
  return projectFlight;
}

export function clearAntigravityProjectCache(): void {
  cachedProject = null;
  projectFlight = null;
}

if (typeof window !== "undefined") {
  onOAuthAuthChanged(() => {
    clearAntigravityProjectCache();
  });
}

// ── Response unwrapping ───────────────────────────────────────────────────────

function unwrapSseStream(
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const emit = (
    controller: TransformStreamDefaultController<Uint8Array>,
    text: string,
  ) => {
    controller.enqueue(encoder.encode(text));
  };
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          emit(
            controller,
            unwrapAntigravitySseLine(buffer.slice(0, index + 1)),
          );
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) emit(controller, unwrapAntigravitySseLine(buffer));
      },
    }),
  );
}

async function unwrapJsonResponse(response: Response): Promise<Response> {
  const text = await response.text();
  let body = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObject(parsed) && "response" in parsed) {
      body = JSON.stringify(parsed.response);
    }
  } catch {
    // Leave a non-JSON body (an error page) for the SDK's error handler.
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: { "content-type": "application/json" },
  });
}

// ── Fetch interception ────────────────────────────────────────────────────────

const MODEL_IN_URL =
  /\/models\/([^:/?]+):(streamGenerateContent|generateContent)/;

export function createAntigravityFetch(
  token: string,
  project: string,
  session: string,
): typeof fetch {
  let currentToken = token;
  return async (input, init) => {
    const url =
      input instanceof URL
        ? input.toString()
        : typeof input === "string"
          ? input
          : input.url;
    const match = MODEL_IN_URL.exec(url);
    if (!match || typeof init?.body !== "string") {
      return proxyFetch(input, init);
    }
    const modelId = match[1];
    const method = match[2];
    const streaming = method === "streamGenerateContent";
    const useDaily = url.includes("daily-cloudcode-pa");
    const build = (host: string) => {
      const headers = new Headers(init.headers);
      headers.delete("x-goog-api-key");
      headers.set("authorization", `Bearer ${currentToken}`);
      headers.set("user-agent", agUserAgent());
      headers.set("x-machine-session-id", session);
      headers.set("content-type", "application/json");
      return {
        url: `${host}/v1internal:${method}${streaming ? "?alt=sse" : ""}`,
        headers,
        body: buildAntigravityBody(
          init.body as string,
          project,
          session,
          modelId,
        ),
      };
    };

    const first = build(useDaily ? AG_HOST : AG_HOST_FALLBACK);
    let response = await proxyFetch(first.url, {
      method: "POST",
      headers: first.headers,
      body: first.body,
      signal: init.signal,
    });
    // The daily host is the chat host; only retry on the prod host for genuine
    // server/gateway failures (502, 503, 504), never for 4xx client errors (400,
    // 401, 403, 404) where prod either fails identically or falsely returns 429
    // RESOURCE_EXHAUSTED for consumer accounts.
    if (
      useDaily &&
      (response.status === 502 ||
        response.status === 503 ||
        response.status === 504)
    ) {
      const fallback = build(AG_HOST_FALLBACK);
      const fallbackResponse = await proxyFetch(fallback.url, {
        method: "POST",
        headers: fallback.headers,
        body: fallback.body,
        signal: init.signal,
      });
      if (fallbackResponse.ok || fallbackResponse.status < 500) {
        response = fallbackResponse;
      }
    }
    // If token expired (HTTP 401), attempt an OAuth refresh and retry once.
    if (response.status === 401) {
      try {
        const { getOAuthAccess } = await import("./oauthAuth");
        const freshAuth = await getOAuthAccess("antigravity");
        if (freshAuth && freshAuth.accessToken !== currentToken) {
          currentToken = freshAuth.accessToken;
          const retryBuild = build(useDaily ? AG_HOST : AG_HOST_FALLBACK);
          response = await proxyFetch(retryBuild.url, {
            method: "POST",
            headers: retryBuild.headers,
            body: retryBuild.body,
            signal: init.signal,
          });
        }
      } catch {
        // Fall through with original response
      }
    }
    if (!response.ok || !response.body) return response;
    if (!streaming) return unwrapJsonResponse(response);
    return new Response(unwrapSseStream(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

/** Builds an Antigravity language model for the given OAuth access token. */
export async function createAntigravityLanguageModel(
  token: string,
  modelId: string,
): Promise<LanguageModel> {
  const project = await ensureAntigravityProject(token);
  const session = newSessionId();
  const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
  return createGoogleGenerativeAI({
    apiKey: token,
    baseURL: AG_HOST,
    fetch: createAntigravityFetch(token, project, session),
  })(modelId);
}
