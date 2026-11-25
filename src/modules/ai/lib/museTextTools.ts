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

/** The Muse Code CLI release whose identity Meta's backend gates native
 * tool calls on (verified against the installed CLI by capturing its
 * request to a local endpoint, the same evidence as the Go clients). */
export const MUSE_CLI_VERSION = "1.4.24";

export function museBuildUserAgent(): string {
  const platform = typeof navigator !== "undefined" ? navigator.platform : "";
  const os = /win/i.test(platform)
    ? "windows"
    : /mac/i.test(platform)
      ? "darwin"
      : /linux/i.test(platform)
        ? "linux"
        : "windows";
  return `muse-build/${MUSE_CLI_VERSION} (non-interactive; ${os}-x86_64)`;
}

/** The headers the official CLI sends on a Responses request. */
export function museIdentityHeaders(sessionId: string): Record<string, string> {
  return {
    "user-agent": museBuildUserAgent(),
    "x-client-id": "tbh:exec",
    "x-tbh-session-id": sessionId,
    "x-meta-ai-gateway-session-id": sessionId,
    "x-tbh-thread-id": sessionId,
    "x-tbh-root-session-id": sessionId,
    "x-tbh-agent-role": "main",
  };
}

function sanitizeResponsesName(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return clean || "unknown_tool";
}

/**
 * Returns the exact tool names declared on a chat-completions request body.
 * Used to ensure text-protocol `tool_call` blocks only execute tools the
 * request actually declared.
 */
export function declaredChatToolNames(body: unknown): Set<string> {
  if (!isObject(body)) return new Set();
  return new Set(chatTools(body).map((tool) => tool.name));
}

/**
 * Maps sanitized Responses wire names back to the original chat tool names
 * (for example MCP tools whose names carry dots or slashes).
 */
export function responseToolAliases(body: unknown): Record<string, string> {
  const aliases: Record<string, string> = {};
  if (!isObject(body)) return aliases;
  for (const tool of chatTools(body)) {
    const wire = sanitizeResponsesName(tool.name);
    if (!(wire in aliases)) aliases[wire] = tool.name;
  }
  return aliases;
}

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

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
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
      const toolResult: Record<string, string> = {
        call_id: asString(message.tool_call_id),
        output: contentText(message.content),
      };
      const toolName = asString(message.name);
      if (toolName) toolResult.name = toolName;
      const block = JSON.stringify(toolResult);
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
  return out;
}

/**
 * Translates one chat-completions request body into the native Responses
 * body the official Muse Code CLI sends: tools as one `muse` namespace
 * tool, stored calls and results as function_call items, reasoning summary
 * requested and encrypted content included. This is the first attempt for
 * every Muse request; the text protocol is only the attestation fallback.
 */
export function chatToNativeResponsesBody(
  body: unknown,
  sessionId: string,
): JsonObject | null {
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
      const hasToolCalls =
        Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
      const text = contentText(message.content);
      if (text.trim()) {
        input.push({
          type: "message",
          role: "assistant",
          phase: hasToolCalls ? "commentary" : "final_answer",
          content: [{ type: "output_text", text }],
        });
      }
      if (hasToolCalls) {
        for (const call of message.tool_calls as unknown[]) {
          if (!isObject(call)) continue;
          const fn = isObject(call.function) ? call.function : call;
          const name = asString(fn.name);
          if (!name) continue;
          const rawArgs =
            typeof fn.arguments === "string"
              ? fn.arguments
              : JSON.stringify(fn.arguments ?? {});
          const callId = asString(call.id) || `call_${input.length}`;
          input.push({
            type: "function_call",
            id: callId.startsWith("fc_") ? callId : `fc_${callId}`,
            call_id: callId,
            name: sanitizeResponsesName(name),
            arguments: isValidJson(rawArgs) ? rawArgs : "{}",
            status: "completed",
          });
        }
      }
    } else if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: asString(message.tool_call_id),
        output: contentText(message.content),
      });
    }
  }

  const out: JsonObject = {
    model: asString(body.model),
    stream: true,
    store: false,
    input,
  };
  if (instructions.length > 0) out.instructions = instructions.join("\n\n");
  if (tools.length > 0) {
    out.tools = [
      {
        type: "namespace",
        name: "muse",
        description: "Muse Code tool set.",
        tools: tools.map((tool) => ({
          type: "function",
          name: sanitizeResponsesName(tool.name),
          description: tool.description,
          parameters: tool.parameters,
          strict: false,
        })),
      },
    ];
  }
  const effort =
    typeof body.reasoning_effort === "string" &&
    ["low", "medium", "high"].includes(body.reasoning_effort)
      ? body.reasoning_effort
      : "high";
  out.reasoning = { effort, summary: "auto" };
  out.include = ["reasoning.encrypted_content"];
  out.prompt_cache_key = `tbh:main:${sessionId}`;
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

const TEXT_TOOL_BLOCK_RE =
  /```(?:tool_call|tool-call|json)\s*([\s\S]*?)```|<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

function extractParsedToolArguments(parsed: JsonObject): string | null {
  let rawArgs: unknown;
  if ("arguments" in parsed) {
    rawArgs = parsed.arguments;
  } else if ("args" in parsed) {
    rawArgs = parsed.args;
  } else if ("parameters" in parsed) {
    rawArgs = parsed.parameters;
  } else if ("input" in parsed) {
    rawArgs = parsed.input;
  } else {
    // Some models place tool parameters directly on the call object
    // (e.g. {"name":"find_tools","query":"mcp"}). Collect any non-metadata keys.
    const metaKeys = new Set(["name", "id", "call_id", "type"]);
    const inlineArgs: JsonObject = {};
    let hasInline = false;
    for (const [k, v] of Object.entries(parsed)) {
      if (!metaKeys.has(k)) {
        inlineArgs[k] = v;
        hasInline = true;
      }
    }
    rawArgs = hasInline ? inlineArgs : {};
  }

  if (rawArgs == null) return "{}";
  if (typeof rawArgs === "string") {
    const trimmed = rawArgs.trim();
    if (!trimmed) return "{}";
    if (!isValidJson(trimmed)) return null;
    return trimmed;
  }
  return JSON.stringify(rawArgs);
}

/**
 * Splits a model reply into the prose around the tool_call blocks and the
 * calls themselves. Accepts the documented ```tool_call fence as well as
 * ```tool-call, ```json, and <tool_call>...</tool_call> wrappers (matching
 * Meta Muse's observed output variants). When `allowedTools` is supplied, a
 * block naming a tool the request did not declare stays prose so quoted
 * examples are never executed. A block that does not parse as a tool call
 * stays prose without discarding other valid blocks in the same reply.
 */
export function parseTextToolCalls(
  text: string,
  allowedTools?: ReadonlySet<string>,
  toolAliases?: Readonly<Record<string, string>>,
): {
  prose: string;
  calls: TextToolCall[];
} {
  let prose = "";
  const calls: TextToolCall[] = [];
  let cursor = 0;

  for (const match of text.matchAll(TEXT_TOOL_BLOCK_RE)) {
    const matchIndex = match.index ?? 0;
    const rawBlock = match[0];
    const body = (match[1] ?? match[2] ?? "").trim();

    prose += text.slice(cursor, matchIndex);

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      prose += rawBlock;
      cursor = matchIndex + rawBlock.length;
      continue;
    }

    const rawName = isObject(parsed) ? asString(parsed.name).trim() : "";
    const resolvedName = rawName ? (toolAliases?.[rawName] ?? rawName) : "";
    if (!resolvedName || (allowedTools && !allowedTools.has(resolvedName))) {
      prose += rawBlock;
      cursor = matchIndex + rawBlock.length;
      continue;
    }

    const argsJson = extractParsedToolArguments(parsed as JsonObject);
    if (argsJson === null) {
      prose += rawBlock;
      cursor = matchIndex + rawBlock.length;
      continue;
    }

    calls.push({
      id: `call_muse_${++textToolSeq}`,
      name: resolvedName,
      arguments: argsJson,
    });
    cursor = matchIndex + rawBlock.length;
  }

  prose += text.slice(cursor);
  if (calls.length === 0) return { prose: text, calls: [] };
  return { prose, calls };
}

export type ResponsesOutcome = {
  text: string;
  calls: TextToolCall[];
  usage: { prompt: number; completion: number; total: number } | null;
  error: string | null;
  incompleteReason: string | null;
};

/**
 * Reports whether a Muse SSE `response.failed` / `error` message is a
 * transient backend failure worth retrying (such as Meta's intermittent
 * "The model failed to generate a response." on HTTP 200).
 */
export function isTransientMuseResponseError(message: string | null): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes("failed to generate a response") ||
    lower.includes("overloaded") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("internal error") ||
    lower.includes("server error") ||
    lower.includes("try again") ||
    lower.includes("timeout") ||
    lower.includes("timed out")
  );
}

export function readResponsesStream(sseText: string): ResponsesOutcome {
  let text = "";
  const calls: TextToolCall[] = [];
  const finalArgs = new Map<string, string>();
  const deltaArgs = new Map<string, string>();
  let usage: ResponsesOutcome["usage"] = null;
  let error: string | null = null;
  let incompleteReason: string | null = null;
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
    } else if (event.type === "response.output_text.done") {
      if (!text && typeof event.text === "string") text = event.text;
    } else if (event.type === "response.function_call_arguments.delta") {
      const itemId = asString(event.item_id);
      if (itemId && typeof event.delta === "string") {
        deltaArgs.set(itemId, (deltaArgs.get(itemId) ?? "") + event.delta);
      }
    } else if (event.type === "response.function_call_arguments.done") {
      const itemId = asString(event.item_id);
      if (itemId) {
        const doneArgs = asString(event.arguments).trim();
        finalArgs.set(
          itemId,
          doneArgs || deltaArgs.get(itemId)?.trim() || "{}",
        );
      }
    } else if (event.type === "response.output_item.done") {
      const item = isObject(event.item) ? event.item : null;
      if (item?.type === "function_call" && asString(item.name)) {
        const itemId = asString(item.id);
        const args =
          asString(item.arguments).trim() ||
          finalArgs.get(itemId)?.trim() ||
          deltaArgs.get(itemId)?.trim() ||
          "{}";
        calls.push({
          id: asString(item.call_id) || itemId || `call_muse_${++textToolSeq}`,
          name: asString(item.name),
          arguments: isValidJson(args) ? args : "{}",
        });
      } else if (
        item?.type === "message" &&
        !text &&
        Array.isArray(item.content)
      ) {
        const parts: string[] = [];
        for (const part of item.content) {
          if (
            isObject(part) &&
            part.type === "output_text" &&
            typeof part.text === "string"
          ) {
            parts.push(part.text);
          }
        }
        if (parts.length > 0) text = parts.join("");
      }
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
      if (event.type === "response.incomplete" && response) {
        const details = isObject(response.incomplete_details)
          ? response.incomplete_details
          : null;
        incompleteReason = asString(details?.reason) || "unspecified";
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
  return { text, calls, usage, error, incompleteReason };
}

/**
 * Turns a buffered Responses stream into the chat-completions SSE the SDK
 * consumes: the prose and the parsed tool calls become ordinary chunks,
 * so the SDK surfaces them as text and native-looking tool calls. The
 * reply is necessarily whole rather than token-streamed, because a
 * tool_call block is only a call once its closing fence has arrived.
 */
export type ResponsesToChatOptions = {
  allowedTools?: ReadonlySet<string>;
  toolAliases?: Record<string, string>;
};

export function responsesStreamToChatSse(
  sseText: string,
  model: string,
  options?: ResponsesToChatOptions,
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
  // Native function_call items win; the text protocol is the fallback
  // parse for a reply that arrived without them.
  const aliases = options?.toolAliases;
  const nativeCalls = aliases
    ? outcome.calls.map((call) => ({
        ...call,
        name: aliases[call.name] ?? call.name,
      }))
    : outcome.calls;
  const parsed =
    nativeCalls.length > 0
      ? { prose: outcome.text, calls: nativeCalls }
      : parseTextToolCalls(outcome.text, options?.allowedTools, aliases);
  const { prose, calls } = parsed;
  if (calls.length === 0) {
    if (outcome.text) {
      chunk({
        index: 0,
        delta: { role: "assistant", content: outcome.text },
        finish_reason: null,
      });
    }
    const finishReason =
      outcome.incompleteReason === "max_output_tokens" ? "length" : "stop";
    chunk({ index: 0, delta: {}, finish_reason: finishReason }, true);
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
