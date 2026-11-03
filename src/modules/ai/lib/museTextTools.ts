/**
 * Muse (Meta) text tool protocol, used when a Muse Code subscription key
 * is refused native tool use. Meta answers any request that registers tools
 * from a non-official client with `403 client_attestation_denied`, and on
 * the chat-completions route it refuses a subscription key even without
 * tools, while a plain Responses request still answers. So when that
 * refusal arrives, the Muse fetch retries on the Responses route with no
 * tools field: the tools are listed in the instructions, the model
 * replies with `tool_call` blocks, and this module translates everything
 * back into the chat-completions shape the SDK expects, so the agent loop
 * executes the calls locally exactly as it does for native ones.
 *
 * Kept pure and free of Tauri so it is unit-testable. The fetch wiring
 * lives in `museStream.ts`.
 */

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Reports whether a response is Meta's client-attestation refusal. */
export function isAttestationDenial(status: number, bodyText: string): boolean {
  if (status !== 403) return false;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isObject(parsed) && isObject(parsed.error)) {
      if (parsed.error.code === "client_attestation_denied") return true;
      const message = asString(parsed.error.message).toLowerCase();
      return (
        message.includes("attestation") ||
        message.includes("muse code subscription")
      );
    }
  } catch {
    // A non-JSON body can still name the refusal in plain text.
  }
  const lower = bodyText.toLowerCase();
  return (
    lower.includes("client_attestation_denied") || lower.includes("attestation")
  );
}

/**
 * Maps the chat-completions URL the SDK posts to onto the Responses route
 * the text protocol runs on, or null when the URL is not a chat request.
 */
export function responsesUrl(chatUrl: string): string | null {
  if (!chatUrl.endsWith("/chat/completions")) return null;
  return `${chatUrl.slice(0, -"/chat/completions".length)}/responses`;
}

type ChatTool = { name: string; description: string; parameters: unknown };

function chatTools(body: JsonObject): ChatTool[] {
  if (!Array.isArray(body.tools)) return [];
  const tools: ChatTool[] = [];
  for (const entry of body.tools) {
    if (!isObject(entry)) continue;
    const fn = isObject(entry.function) ? entry.function : entry;
    const name = asString(fn.name);
    if (!name) continue;
    tools.push({
      name,
      description: asString(fn.description),
      parameters: fn.parameters ?? { type: "object", properties: {} },
    });
  }
  return tools;
}

function toolCallBlock(name: string, args: unknown): string {
  const argumentsText =
    typeof args === "string" ? args : JSON.stringify(args ?? {});
  return `\`\`\`tool_call\n${JSON.stringify({ name, arguments: safeJson(argumentsText) })}\n\`\`\``;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    return content == null ? "" : JSON.stringify(content);
  }
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
    } else if (isObject(part) && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("");
}

function userContent(content: unknown): JsonObject[] {
  if (!Array.isArray(content)) {
    return [{ type: "input_text", text: contentText(content) }];
  }
  const out: JsonObject[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      out.push({ type: "input_text", text: part });
    } else if (isObject(part) && part.type === "text") {
      out.push({ type: "input_text", text: asString(part.text) });
    } else if (isObject(part) && part.type === "image_url") {
      const image = isObject(part.image_url)
        ? asString(part.image_url.url)
        : asString(part.image_url);
      if (image) out.push({ type: "input_image", image_url: image });
    } else if (isObject(part) && typeof part.text === "string") {
      out.push({ type: "input_text", text: part.text });
    }
  }
  return out.length > 0 ? out : [{ type: "input_text", text: "" }];
}

/**
 * Translates one chat-completions request body into the Responses body the
 * text tool protocol sends: system text and the tool catalogue fold into
 * the instructions, stored tool calls and results render as protocol
 * blocks, and no tools field is ever registered. Returns null for a body
 * that is not a chat request this module can translate.
 */
export function chatToResponsesBody(body: unknown): JsonObject | null {
  if (!isObject(body) || !Array.isArray(body.messages)) return null;
  const tools = chatTools(body);
  const instructions: string[] = [];
  const input: JsonObject[] = [];

  for (const message of body.messages) {
    if (!isObject(message)) continue;
    const role = asString(message.role);
    if (role === "system" || role === "developer") {
      const text = contentText(message.content);
      if (text.trim()) instructions.push(text);
    } else if (role === "user") {
      input.push({
        type: "message",
        role: "user",
        content: userContent(message.content),
      });
    } else if (role === "assistant") {
      const parts: string[] = [];
      const text = contentText(message.content);
      if (text.trim()) parts.push(text);
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!isObject(call)) continue;
          const fn = isObject(call.function) ? call.function : call;
          const name = asString(fn.name);
          if (name) parts.push(toolCallBlock(name, fn.arguments ?? "{}"));
        }
      }
      if (parts.length === 0) continue;
      input.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: parts.join("\n\n") }],
      });
    } else if (role === "tool") {
      const block = JSON.stringify({
        call_id: asString(message.tool_call_id),
        output: contentText(message.content),
      });
      input.push({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: `\`\`\`tool_result\n${block}\n\`\`\`` },
        ],
      });
    }
  }

  if (tools.length > 0) {
    instructions.push(textToolProtocol(tools));
  }
  const out: JsonObject = {
    model: asString(body.model),
    stream: true,
    input,
  };
  if (instructions.length > 0) out.instructions = instructions.join("\n\n");
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (typeof maxTokens === "number") out.max_output_tokens = maxTokens;
  return out;
}

function textToolProtocol(tools: ChatTool[]): string {
  const lines = [
    "Tool use (text protocol): the tools below are available, but they are not registered with this API request. Termigo executes them on the operator's machine and returns their output to you.",
    "To call a tool, end your reply with one block per call, in exactly this shape and with no text after the last block:",
    '```tool_call\n{"name":"tool_name","arguments":{"arg":value}}\n```',
    "Tool outputs come back as tool_result blocks; read them and continue. When the task is finished, answer in plain text with no tool_call block.",
    "",
    "Available tools:",
  ];
  for (const tool of tools) {
    lines.push(
      `- ${tool.name}: ${tool.description}`,
      `  arguments JSON schema: ${JSON.stringify(tool.parameters)}`,
    );
  }
  return lines.join("\n");
}

export type TextToolCall = { id: string; name: string; arguments: string };

let textToolSeq = 0;

/**
 * Splits a model reply into the prose around the tool_call blocks and the
 * calls themselves. A block that does not parse is not a call: the whole
 * reply then stays prose, so a model that talks about the protocol in a
 * code sample is not mistaken for one using it.
 */
export function parseTextToolCalls(text: string): {
  prose: string;
  calls: TextToolCall[];
} {
  const fence = "```tool_call";
  let prose = "";
  const calls: TextToolCall[] = [];
  let rest = text;
  for (;;) {
    const start = rest.indexOf(fence);
    if (start < 0) {
      prose += rest;
      break;
    }
    const tail = rest.slice(start + fence.length);
    const end = tail.indexOf("```");
    if (end < 0) return { prose: text, calls: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(tail.slice(0, end).trim());
    } catch {
      return { prose: text, calls: [] };
    }
    if (!isObject(parsed) || !asString(parsed.name).trim()) {
      return { prose: text, calls: [] };
    }
    let args: unknown = parsed.arguments ?? {};
    if (typeof args === "string") args = safeJson(args);
    prose += rest.slice(0, start);
    calls.push({
      id: `call_muse_${++textToolSeq}`,
      name: asString(parsed.name).trim(),
      arguments: JSON.stringify(args),
    });
    rest = tail.slice(end + "```".length);
  }
  if (calls.length === 0) return { prose: text, calls: [] };
  return { prose, calls };
}

type ResponsesOutcome = {
  text: string;
  usage: { prompt: number; completion: number; total: number } | null;
  error: string | null;
};

function readResponsesStream(sseText: string): ResponsesOutcome {
  let text = "";
  let usage: ResponsesOutcome["usage"] = null;
  let error: string | null = null;
  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!isObject(event)) continue;
    if (event.type === "response.output_text.delta") {
      if (typeof event.delta === "string") text += event.delta;
    } else if (
      event.type === "response.completed" ||
      event.type === "response.incomplete"
    ) {
      const response = isObject(event.response) ? event.response : null;
      const raw = response && isObject(response.usage) ? response.usage : null;
      if (raw) {
        const prompt = Number(raw.input_tokens ?? 0) || 0;
        const completion = Number(raw.output_tokens ?? 0) || 0;
        usage = {
          prompt,
          completion,
          total: Number(raw.total_tokens ?? prompt + completion) || 0,
        };
      }
    } else if (event.type === "response.failed" || event.type === "error") {
      const nested = isObject(event.error) ? event.error : null;
      const response = isObject(event.response) ? event.response : null;
      const responseError =
        response && isObject(response.error) ? response.error : null;
      error =
        asString(nested?.message) ||
        asString(responseError?.message) ||
        "Muse request failed";
    }
  }
  return { text, usage, error };
}

/**
 * Turns a buffered Responses stream into the chat-completions SSE the SDK
 * consumes: the prose and the parsed tool calls become ordinary chunks,
 * so the SDK surfaces them as text and native-looking tool calls. The
 * reply is necessarily whole rather than token-streamed, because a
 * tool_call block is only a call once its closing fence has arrived.
 */
export function responsesStreamToChatSse(
  sseText: string,
  model: string,
): string {
  const outcome = readResponsesStream(sseText);
  if (outcome.error) {
    return `data: ${JSON.stringify({ error: { message: outcome.error, code: "muse_response_failed" } })}\n\ndata: [DONE]\n\n`;
  }
  const base = {
    id: "chatcmpl-muse",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  };
  const usage = outcome.usage
    ? {
        prompt_tokens: outcome.usage.prompt,
        completion_tokens: outcome.usage.completion,
        total_tokens: outcome.usage.total,
      }
    : undefined;
  const lines: string[] = [];
  const chunk = (choice: JsonObject, withUsage = false) => {
    lines.push(
      `data: ${JSON.stringify({ ...base, choices: [choice], ...(withUsage && usage ? { usage } : {}) })}\n\n`,
    );
  };
  const { prose, calls } = parseTextToolCalls(outcome.text);
  if (calls.length === 0) {
    if (outcome.text) {
      chunk({
        index: 0,
        delta: { role: "assistant", content: outcome.text },
        finish_reason: null,
      });
    }
    chunk({ index: 0, delta: {}, finish_reason: "stop" }, true);
  } else {
    if (prose.trim()) {
      chunk({
        index: 0,
        delta: { role: "assistant", content: prose.trim() },
        finish_reason: null,
      });
    }
    calls.forEach((call, index) => {
      chunk({
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            },
          ],
        },
        finish_reason: null,
      });
    });
    chunk({ index: 0, delta: {}, finish_reason: "tool_calls" }, true);
  }
  lines.push("data: [DONE]\n\n");
  return lines.join("");
}
