import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCloudCodeTarget,
  cloudCodeSseUnwrap,
  createOAuthModelFetch,
  extractChatgptAccountId,
  forceStoreFalse,
  unwrapCloudCodeJson,
} from "./oauthFetch";

const { ensureFreshOAuthToken, proxyFetch } = vi.hoisted(() => ({
  ensureFreshOAuthToken: vi.fn(),
  proxyFetch: vi.fn(),
}));

vi.mock("@/modules/oauth/bridge", () => ({
  ensureFreshOAuthToken,
}));

vi.mock("./proxyFetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./proxyFetch")>();
  return { ...actual, proxyFetch };
});

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt(claims: Record<string, unknown>): string {
  return `${b64url("{}")}.${b64url(JSON.stringify(claims))}.${b64url("{}")}`;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("extractChatgptAccountId", () => {
  it("reads the chatgpt account id from the JWT claims", () => {
    const token = makeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "user-abc123" },
    });
    expect(extractChatgptAccountId(token)).toBe("user-abc123");
  });

  it("returns undefined for malformed tokens or missing claims", () => {
    expect(extractChatgptAccountId("not-a-jwt")).toBeUndefined();
    expect(extractChatgptAccountId(makeJwt({ sub: "someone" }))).toBeUndefined();
  });
});

describe("forceStoreFalse", () => {
  it("forces store:false while preserving the rest of the body", () => {
    const out = forceStoreFalse(
      JSON.stringify({ model: "gpt-5.6", store: true, input: "hi" }),
    );
    expect(JSON.parse(out)).toEqual({ model: "gpt-5.6", store: false, input: "hi" });
  });

  it("passes non-JSON or empty bodies through untouched", () => {
    expect(forceStoreFalse("")).toBe("");
    expect(forceStoreFalse("<html>")).toBe("<html>");
  });
});

describe("buildCloudCodeTarget", () => {
  const body = JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] });

  it("rewrites the streaming endpoint and wraps the request body", () => {
    const target = buildCloudCodeTarget(
      "https://cloudcode-pa.googleapis.com/v1internal/models/gemini-3-flash:streamGenerateContent?alt=sse",
      body,
      "proj-1",
    );
    expect(target).not.toBeNull();
    const t = target as NonNullable<typeof target>;
    expect(t.url).toBe(
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    );
    expect(t.streaming).toBe(true);
    expect(JSON.parse(t.body)).toEqual({
      project: "proj-1",
      model: "gemini-3-flash",
      request: { contents: [{ parts: [{ text: "hi" }] }] },
    });
  });

  it("rewrites the non-streaming endpoint without alt=sse", () => {
    const target = buildCloudCodeTarget(
      "https://cloudcode-pa.googleapis.com/v1internal/models/gemini-3-flash:generateContent",
      body,
      "proj-1",
    );
    const t = target as NonNullable<typeof target>;
    expect(t.url).toBe(
      "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
    );
    expect(t.streaming).toBe(false);
  });

  it("returns null for anything that is not a Cloud Code model call", () => {
    expect(
      buildCloudCodeTarget(
        "https://chatgpt.com/backend-api/codex/responses",
        body,
        "proj-1",
      ),
    ).toBeNull();
  });

  it("throws a clear error when no project id is available", () => {
    expect(() =>
      buildCloudCodeTarget(
        "https://cloudcode-pa.googleapis.com/v1internal/models/gemini-3-flash:streamGenerateContent?alt=sse",
        body,
        null,
      ),
    ).toThrow(/Cloud Code project id/);
  });
});

describe("cloudCodeSseUnwrap", () => {
  it("unwraps wrapped SSE payloads across chunk boundaries", async () => {
    const input =
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}\n\n' +
      "data: [DONE]\n\n";
    const body = new Response(input).body;
    if (!body) throw new Error("no body");
    // Split mid-payload to prove chunk-boundary handling.
    const mid = Math.floor(input.length / 2);
    const split = new Blob([input.slice(0, mid), input.slice(mid)]).stream();
    const out = await collect(split.pipeThrough(cloudCodeSseUnwrap()));
    expect(out).toBe(
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\ndata: [DONE]\n\n',
    );
  });

  it("passes plain payloads through unchanged", async () => {
    const input = 'data: {"candidates":[]}\n\n';
    const body = new Response(input).body;
    if (!body) throw new Error("no body");
    const out = await collect(body.pipeThrough(cloudCodeSseUnwrap()));
    expect(out).toBe(input);
  });

  it("normalizes CRLF line endings", async () => {
    const input =
      'data: {"response":{"candidates":[]}}\r\n\r\ndata: [DONE]\r\n\r\n';
    const body = new Response(input).body;
    if (!body) throw new Error("no body");
    const out = await collect(body.pipeThrough(cloudCodeSseUnwrap()));
    expect(out).toBe('data: {"candidates":[]}\n\ndata: [DONE]\n\n');
  });
});

describe("unwrapCloudCodeJson", () => {
  it("unwraps a wrapped non-stream response", () => {
    expect(unwrapCloudCodeJson('{"response":{"candidates":[]}}')).toBe(
      '{"candidates":[]}',
    );
  });

  it("passes plain JSON through unchanged", () => {
    expect(unwrapCloudCodeJson('{"candidates":[]}')).toBe('{"candidates":[]}');
  });
});

describe("createOAuthModelFetch", () => {
  beforeEach(() => {
    ensureFreshOAuthToken.mockReset();
    proxyFetch.mockReset();
    proxyFetch.mockResolvedValue(new Response("ok", { status: 200 }));
  });

  it("codex: forces store:false and sends CLI identity headers", async () => {
    ensureFreshOAuthToken.mockResolvedValue({
      access_token: "fresh-token",
      expires_at: null,
      scope: null,
    });
    const fetcher = createOAuthModelFetch({
      profile: "codex",
      bakedToken: "baked",
    });
    await fetcher("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      headers: { authorization: "Bearer baked" },
      body: JSON.stringify({ model: "gpt-5.6", store: true, input: "hi" }),
    });
    expect(ensureFreshOAuthToken).toHaveBeenCalledWith("codex");
    const [url, init] = proxyFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer fresh-token");
    expect(headers["OpenAI-Beta"]).toBe("responses=experimental");
    expect(headers.session_id).toBeTruthy();
    const body = JSON.parse(init.body as string);
    expect(body.store).toBe(false);
    expect(body.model).toBe("gpt-5.6");
  });

  it("claude: re-resolves the bearer token, keeping anthropic headers", async () => {
    ensureFreshOAuthToken.mockResolvedValue({
      access_token: "fresh-token",
      expires_at: null,
      scope: null,
    });
    const fetcher = createOAuthModelFetch({
      profile: "claude",
      bakedToken: "baked",
    });
    await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer baked",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
    });
    const [, init] = proxyFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer fresh-token");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("falls back to the baked token when refresh fails", async () => {
    ensureFreshOAuthToken.mockResolvedValue(null);
    const fetcher = createOAuthModelFetch({
      profile: "claude",
      bakedToken: "baked",
    });
    await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: "{}",
    });
    const [, init] = proxyFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer baked",
    );
  });

  it("antigravity: rewrites to Cloud Code wire format and unwraps the stream", async () => {
    ensureFreshOAuthToken.mockResolvedValue({
      access_token: "fresh-token",
      expires_at: null,
      scope: null,
      project_id: "proj-from-fresh",
    });
    proxyFetch.mockResolvedValue(
      new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}\n\ndata: [DONE]\n\n',
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
    );
    const fetcher = createOAuthModelFetch({
      profile: "antigravity",
      bakedToken: "baked",
      projectId: null,
    });
    const resp = await fetcher(
      "https://cloudcode-pa.googleapis.com/v1internal/models/gemini-3-flash:streamGenerateContent?alt=sse",
      {
        method: "POST",
        headers: {},
        body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
      },
    );
    const [url, init] = proxyFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer fresh-token");
    expect(headers.accept).toBe("text/event-stream");
    expect(headers["Client-Metadata"]).toBeTruthy();
    const body = JSON.parse(init.body as string);
    expect(body.project).toBe("proj-from-fresh");
    expect(body.model).toBe("gemini-3-flash");
    expect(body.request.contents).toEqual([{ parts: [{ text: "hi" }] }]);
    const out = await collect(resp.body as ReadableStream<Uint8Array>);
    expect(out).toBe(
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\ndata: [DONE]\n\n',
    );
  });
});
