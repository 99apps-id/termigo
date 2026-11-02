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
  return { base: base as typeof fetch, calls, chatHits: () => chatHits };
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
    expect(fake.chatHits()).toBe(1);
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
    expect(fake.chatHits()).toBe(1);
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

  it("still sanitises a native stream that was not refused", async () => {
    const base = (async () =>
      new Response(
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
          'data: {"usage":{"total_tokens":12}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as typeof fetch;
    const museFetch = createMuseFetch(base);
    const response = await museFetch(
      "https://api.meta.ai/v1/chat/completions",
      chatInit([{ role: "user", content: "hi" }], undefined, "key-native"),
    );
    expect(await response.text()).toContain('"choices":[]');
  });
});
