import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, streamText, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMuseFetch } from "./museStream";

type RecordedCall = { url: string; body: Record<string, unknown> | null };

const ATTESTATION_BODY = JSON.stringify({
  error: {
    code: "client_attestation_denied",
    message:
      "This API key is billed to a Muse Code subscription. Muse Code subscriptions cover requests from the Muse Code client only.",
    type: "permission_error",
  },
});

function fakeMeta(reply: { toolBlock: string; finalText: string }) {
  const calls: RecordedCall[] = [];
  let chatHits = 0;
  let responsesHits = 0;
  const base = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    calls.push({ url, body });
    if (url.endsWith("/chat/completions")) {
      chatHits++;
      // Meta refuses a Muse Code subscription key on this route, with
      // tools and (unlike the Responses route) even without them.
      return new Response(ATTESTATION_BODY, {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/responses")) {
      responsesHits++;
      // The same subscription key is refused when it registers tools
      // natively, and served on this route when it does not (the text
      // tool protocol).
      if (body?.tools) {
        return new Response(ATTESTATION_BODY, {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      const text = raw.includes("```tool_result")
        ? reply.finalText
        : reply.toolBlock;
      const delta = JSON.stringify(text);
      const sse =
        `data: {"type":"response.output_text.delta","delta":${delta}}\n\n` +
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n';
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("not found", { status: 404 });
  };
  return {
    base: base as typeof fetch,
    calls,
    chatHits: () => chatHits,
    responsesHits: () => responsesHits,
  };
}

/** A Meta that ACCEPTS the native namespace registration (the pay-as-you-go
 *  shape): function calls arrive as real Responses items, with the
 *  arguments finalized in their own event and the item carrying them
 *  empty, the way Muse actually streams them. */
function fakeMetaNative(reply: { finalText: string }) {
  const calls: RecordedCall[] = [];
  const base = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    calls.push({ url, body });
    if (!url.endsWith("/responses")) {
      return new Response("not found", { status: 404 });
    }
    const usage =
      '"response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}';
    if (raw.includes("function_call_output")) {
      const delta = JSON.stringify(reply.finalText);
      const sse =
        `data: {"type":"response.output_text.delta","delta":${delta}}\n\n` +
        `data: {"type":"response.completed",${usage}}\n\n`;
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    const sse =
      'data: {"type":"response.output_text.delta","delta":"Checking."}\n\n' +
      'data: {"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":"{\\"command\\":\\"ls\\"}"}\n\n' +
      'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"bash_run","arguments":""}}\n\n' +
      `data: {"type":"response.completed",${usage}}\n\n`;
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { base: base as typeof fetch, calls };
}

function chatInit(
  messages: unknown[],
  tools?: unknown[],
  authorization = "key-subscription",
): RequestInit {
  return {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "muse-spark-1.3",
      stream: true,
      messages,
      ...(tools ? { tools, tool_choice: "auto" } : {}),
    }),
  };
}

const BASH_TOOL = {
  type: "function",
  function: {
    name: "bash_run",
    description: "Run a command.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
    },
  },
};

describe("createMuseFetch attestation fallback", () => {
  it("switches a refused muse login to the text tool protocol and keeps it there", async () => {
    const fake = fakeMeta({
      toolBlock:
        '```tool_call\n{"name":"bash_run","arguments":{"command":"ls"}}\n```',
      finalText: "done listing",
    });
    const museFetch = createMuseFetch(fake.base);

    const first = await museFetch(
      "https://api.meta.ai/v1/chat/completions",
      chatInit(
        [
          { role: "system", content: "be brief" },
          { role: "user", content: "list files" },
        ],
        [BASH_TOOL],
      ),
    );
    const firstText = await first.text();
    expect(first.status).toBe(200);
    expect(firstText).toContain('"tool_calls"');
    expect(firstText).toContain('"name":"bash_run"');
    expect(firstText).toContain('"{\\"command\\":\\"ls\\"}"');
    expect(firstText).toContain('"finish_reason":"tool_calls"');
    expect(firstText).not.toContain("tool_call\\n");

    const retry = fake.calls[fake.calls.length - 1];
    expect(retry.url.endsWith("/responses")).toBe(true);
    expect(retry.body?.tools).toBeUndefined();
    const instructions = String(retry.body?.instructions ?? "");
    expect(instructions).toContain("tool_call");
    expect(instructions).toContain("bash_run");
    const input = JSON.stringify(retry.body?.input ?? "");
    expect(input).toContain("list files");

    // The next step carries the stored call and its result; it must go
    // straight to the text protocol instead of paying the refusal again.
    const second = await museFetch(
      "https://api.meta.ai/v1/chat/completions",
      chatInit(
        [
          { role: "user", content: "list files" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_muse_1",
                type: "function",
                function: {
                  name: "bash_run",
                  arguments: '{"command":"ls"}',
                },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_muse_1", content: "file.txt" },
        ],
        [BASH_TOOL],
      ),
    );
    const secondText = await second.text();
    // The chat route is never used at all now: the refusal and both text
    // steps all happened on /responses (native attempt + text retry on
    // step one, straight text on step two).
    expect(fake.chatHits()).toBe(0);
    expect(fake.responsesHits()).toBe(3);
    expect(secondText).toContain("done listing");
    expect(secondText).toContain('"finish_reason":"stop"');
    const last = fake.calls[fake.calls.length - 1];
    const lastInput = JSON.stringify(last.body?.input ?? "");
    expect(lastInput).toContain("tool_result");
    expect(lastInput).toContain("file.txt");
    expect(lastInput).toContain("tool_call");
  });

  it("drives a real SDK tool loop: the SDK executes the parsed call and the next step answers", async () => {
    const fake = fakeMeta({
      toolBlock:
        '```tool_call\n{"name":"bash_run","arguments":{"command":"ls"}}\n```',
      finalText: "done listing",
    });
    const provider = createOpenAICompatible({
      name: "muse",
      baseURL: "https://api.meta.ai/v1",
      apiKey: "key-sdk-loop",
      fetch: createMuseFetch(fake.base),
    });
    const executed: string[] = [];
    const result = streamText({
      model: provider("muse-spark-1.3"),
      messages: [{ role: "user", content: "list files" }],
      tools: {
        bash_run: tool({
          description: "Run a command.",
          inputSchema: z.object({ command: z.string() }),
          execute: async ({ command }) => {
            executed.push(command);
            return "file.txt";
          },
        }),
      },
      stopWhen: stepCountIs(5),
    });
    const text = await result.text;
    expect(executed).toEqual(["ls"]);
    expect(text).toContain("done listing");
    expect(fake.chatHits()).toBe(0);
  });

  it("passes a non-attestation error through untouched", async () => {
    const base = (async () =>
      new Response(
        JSON.stringify({
          error: { code: "invalid_api_key", message: "Unauthorized" },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const museFetch = createMuseFetch(base);
    const response = await museFetch(
      "https://api.meta.ai/v1/chat/completions",
      chatInit([{ role: "user", content: "hi" }], [BASH_TOOL], "key-other"),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("invalid_api_key");
  });

  it("serves a native Responses call when Meta accepts the namespace registration", async () => {
    const fake = fakeMetaNative({ finalText: "done listing" });
    const museFetch = createMuseFetch(fake.base);

    const first = await museFetch(
      "https://api.meta.ai/v1/chat/completions",
      chatInit(
        [{ role: "user", content: "list files" }],
        [BASH_TOOL],
        "key-native-ok",
      ),
    );
    const firstText = await first.text();
    expect(first.status).toBe(200);
    expect(firstText).toContain("Checking.");
    expect(firstText).toContain('"tool_calls"');
    expect(firstText).toContain('"id":"call_1"');
    expect(firstText).toContain('"name":"bash_run"');
    expect(firstText).toContain('"{\\"command\\":\\"ls\\"}"');
    expect(firstText).toContain('"finish_reason":"tool_calls"');

    // The request itself is termixgo's payload shape: one namespace tool,
    // no stored state, the session cache key, encrypted reasoning asked.
    const sent = fake.calls[0];
    expect(sent.url.endsWith("/responses")).toBe(true);
    expect(sent.body?.store).toBe(false);
    expect(String(sent.body?.prompt_cache_key)).toMatch(/^tbh:main:/);
    expect(sent.body?.include).toEqual(["reasoning.encrypted_content"]);
    const tools = sent.body?.tools as {
      type?: string;
      name?: string;
      tools?: unknown[];
    }[];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.type).toBe("namespace");
    expect(tools[0]?.name).toBe("muse");
    expect(tools[0]?.tools).toHaveLength(1);

    // The next step replays the call in native shape: the function_call
    // item stamped with its fc_ id and completed status, the commentary
    // phase on the prose that preceded it, the result as an output item.
    const second = await museFetch(
      "https://api.meta.ai/v1/chat/completions",
      chatInit(
        [
          { role: "user", content: "list files" },
          {
            role: "assistant",
            content: "Checking.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "bash_run", arguments: '{"command":"ls"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "file.txt" },
        ],
        [BASH_TOOL],
        "key-native-ok",
      ),
    );
    expect(await second.text()).toContain("done listing");
    const replay = fake.calls[fake.calls.length - 1];
    const items = (replay.body?.input ?? []) as Record<string, unknown>[];
    const callItem = items.find((i) => i.type === "function_call");
    expect(callItem?.id).toBe("fc_call_1");
    expect(callItem?.call_id).toBe("call_1");
    expect(callItem?.status).toBe("completed");
    const proseItem = items.find(
      (i) => i.type === "message" && i.role === "assistant",
    );
    expect(proseItem?.phase).toBe("commentary");
    const outputItem = items.find((i) => i.type === "function_call_output");
    expect(outputItem?.call_id).toBe("call_1");
    expect(outputItem?.output).toBe("file.txt");
  });
});

describe("createMuseFetch recovery ladder", () => {
  const OK_SSE =
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' + "data: [DONE]\n\n";

  it("remints once on a stale-key 401 and retries with the fresh credential", async () => {
    const seenAuth: string[] = [];
    const base = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const auth =
        init?.headers instanceof Headers
          ? (init.headers.get("authorization") ?? "")
          : ((init?.headers as Record<string, string>)?.Authorization ?? "");
      seenAuth.push(auth);
      if (auth === "Bearer fresh-key") {
        return new Response(OK_SSE, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(
        JSON.stringify({ error: { code: "invalid_api_key" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    let remints = 0;
    const museFetch = createMuseFetch(base, {
      remint: async () => {
        remints += 1;
        return "fresh-key";
      },
    });

    const first = await museFetch(
      "https://api.meta.ai/v1/chat/completions",
      chatInit(
        [{ role: "user", content: "hi" }],
        undefined,
        "Bearer stale-key",
      ),
    );
    expect(first.status).toBe(200);
    expect(remints).toBe(1);
    expect(seenAuth).toEqual(["Bearer stale-key", "Bearer fresh-key"]);

    // The retired credential is substituted up front on later calls, so
    // the rejection is not paid again.
    const second = await museFetch(
      "https://api.meta.ai/v1/chat/completions",
      chatInit(
        [{ role: "user", content: "hi" }],
        undefined,
        "Bearer stale-key",
      ),
    );
    expect(second.status).toBe(200);
    expect(remints).toBe(1);
    expect(seenAuth[seenAuth.length - 1]).toBe("Bearer fresh-key");
  });

  it("sends the official build identity and a stable per-credential session", async () => {
    const seen: { ua: string; session: string; client: string }[] = [];
    const base = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const headers = new Headers(init?.headers);
      seen.push({
        ua: headers.get("user-agent") ?? "",
        session: headers.get("x-tbh-session-id") ?? "",
        client: headers.get("x-client-id") ?? "",
      });
      return new Response(OK_SSE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const museFetch = createMuseFetch(base);
    const call = (auth: string) =>
      museFetch(
        "https://api.meta.ai/v1/chat/completions",
        chatInit([{ role: "user", content: "hi" }], undefined, auth),
      );
    await call("Bearer identity-key-a");
    await call("Bearer identity-key-a");
    await call("Bearer identity-key-b");
    expect(seen[0]?.ua).toMatch(/^muse-build\/1\.4\.24 \(non-interactive; /);
    expect(seen[0]?.client).toBe("tbh:exec");
    expect(seen[0]?.session).not.toBe("");
    // Same credential, same session; another credential, its own session.
    expect(seen[1]?.session).toBe(seen[0]?.session);
    expect(seen[2]?.session).not.toBe(seen[0]?.session);
  });

  it("retries a transient 429 and succeeds", async () => {
    let hits = 0;
    const base = (async (): Promise<Response> => {
      hits += 1;
      if (hits === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "Wed, 01 Jan 2025 00:00:00 GMT" },
        });
      }
      return new Response(OK_SSE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const museFetch = createMuseFetch(base);
    const response = await museFetch(
      "https://api.meta.ai/v1/chat/completions",
      chatInit([{ role: "user", content: "hi" }], undefined, "key-native"),
    );
    expect(response.status).toBe(200);
    expect(hits).toBe(2);
  });
});
