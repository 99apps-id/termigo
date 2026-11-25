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

import { recordMuseSubscription } from "./museQuota";

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
  // Tool results in the chat shape carry only a call id; the name lives on
  // the assistant call that produced it. Termixgo's result blocks carry
  // name + call_id + output, which is what the model reads back, so map
  // ids to names as the calls go past.
  const callNames = new Map<string, string>();

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
          const callId = asString(call.id);
          if (name && callId) callNames.set(callId, name);
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
      const callId = asString(message.tool_call_id);
      const name = callNames.get(callId);
      const block = JSON.stringify({
        ...(name ? { name } : {}),
        call_id: callId,
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

  // A forced tool-less step (the agent loop's synthesis step) arrives as
  // tool_choice "none". The chat body carries it, but a Responses request
  // has no tools field to switch off, so without this the model never
  // learns tools are off: it emits tool_call blocks anyway, the loop reads
  // that as the model ignoring the forced choice, and the model is marked
  // as one that ignores synthesis -- after which every stuck-guard stops
  // the run instantly. Say it in the instructions instead, and leave the
  // tool catalogue out so nothing contradicts it.
  const toolChoice = body.tool_choice;
  const toolsDisabled =
    toolChoice === "none" ||
    (isObject(toolChoice) && toolChoice.type === "none");
  if (toolsDisabled) {
    instructions.push(
      "Tool use is disabled for this reply. Do not emit any tool_call block. Answer now in plain text only, summarising what you found and what remains to be done.",
    );
  } else if (tools.length > 0) {
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

/** Arguments for a replayed function_call item: Meta validates them and
 *  answers 400 when they are not valid JSON, so a blank or broken string
 *  degrades to an empty object (termixgo's responsesArguments). */
function responsesArguments(raw: unknown): string {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "{}";
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    return "{}";
  }
}

/** Meta's reasoning effort for a chat body, termixgo's mapping: the
 *  official client defaults to high, and its ultra tier is a client-side
 *  mode on top of the endpoint's max. */
function museEffort(body: JsonObject): string {
  const raw = asString(body.reasoning_effort).toLowerCase();
  if (raw === "ultra") return "max";
  if (["low", "medium", "high", "xhigh", "max"].includes(raw)) return raw;
  return "high";
}

/**
 * Translates one chat-completions request body into the NATIVE Responses
 * body, termixgo's payload shape: tools registered as ONE namespace tool
 * named `muse` (the official client's registration, and the only shape
 * Meta serves native calls to), stored calls replayed as function_call
 * items stamped with `fc_` ids and a completed status, results as
 * function_call_output items, assistant messages phase-tagged
 * (commentary before a call, final_answer otherwise) -- the three replay
 * repairs Meta's backend validates with a misleading 404 or a 400.
 *
 * Reasoning items are the one thing this translation cannot carry: the
 * chat-shaped history the SDK keeps has nowhere to store them, so a
 * step's encrypted reasoning is dropped between steps (termixgo's own
 * client keeps and replays them). The request still asks for them, as
 * the official client does.
 */
export function chatToResponsesNativeBody(
  body: unknown,
  sessionId: string,
): JsonObject | null {
  if (!isObject(body) || !Array.isArray(body.messages)) return null;
  const tools = chatTools(body);
  const instructions: string[] = [];
  const input: JsonObject[] = [];
  const seenOutputs = new Set<string>();
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
      const text = contentText(message.content);
      if (text.trim()) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!isObject(call)) continue;
          const fn = isObject(call.function) ? call.function : call;
          const name = asString(fn.name);
          const callId = asString(call.id);
          if (!name || !callId) continue;
          input.push({
            type: "function_call",
            id: `fc_${callId}`,
            call_id: callId,
            name,
            arguments: responsesArguments(fn.arguments ?? "{}"),
            status: "completed",
          });
        }
      }
    } else if (role === "tool") {
      const callId = asString(message.tool_call_id);
      if (callId && seenOutputs.has(callId)) continue;
      if (callId) seenOutputs.add(callId);
      input.push({
        type: "function_call_output",
        call_id: callId,
        output: contentText(message.content),
      });
    }
  }
  for (let i = 0; i < input.length; i += 1) {
    const item = input[i];
    if (item && item.type === "message" && item.role === "assistant") {
      item.phase =
        input[i + 1]?.type === "function_call" ? "commentary" : "final_answer";
    }
  }
  const out: JsonObject = {
    model: asString(body.model),
    stream: true,
    store: false,
    input,
    reasoning: { summary: "auto", effort: museEffort(body) },
    include: ["reasoning.encrypted_content"],
  };
  if (instructions.length > 0) out.instructions = instructions.join("\n\n");
  const toolChoiceNone =
    body.tool_choice === "none" ||
    (isObject(body.tool_choice) && body.tool_choice.type === "none");
  if (tools.length > 0 && !toolChoiceNone) {
    out.tools = [
      {
        type: "namespace",
        name: "muse",
        description: "Muse Code tool set.",
        tools: tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }
  if (sessionId) out.prompt_cache_key = `tbh:main:${sessionId}`;
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
/**
 * Split a reply into the prose around tool-call blocks and the calls
 * themselves, termixgo's tolerant shape: Muse models have emitted several
 * equivalent wrappers, so the documented fence, a `tool-call` or `json`
 * fence, and an XML-style tag are all accepted, and tolerance is per block
 * -- a block whose body is not a valid call-shaped JSON object stays prose
 * and the scan continues, instead of the old all-or-nothing rule where one
 * bad or unclosed block discarded every valid call in the reply.
 */
export function parseTextToolCalls(text: string): {
  prose: string;
  calls: TextToolCall[];
} {
  const blockRe =
    /```(?:tool_call|tool-call|json)\s*([\s\S]*?)```|<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const calls: TextToolCall[] = [];
  let prose = "";
  let cursor = 0;
  let sawBlock = false;
  for (const match of text.matchAll(blockRe)) {
    sawBlock = true;
    const start = match.index;
    const end = start + match[0].length;
    const body = (match[1] ?? match[2] ?? "").trim();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
    const name = isObject(parsed) ? asString(parsed.name).trim() : "";
    let argsJson: string | null = null;
    if (isObject(parsed)) {
      const rawArgs = parsed.arguments;
      if (rawArgs === undefined || rawArgs === null) {
        argsJson = "{}";
      } else if (typeof rawArgs === "string") {
        // The arguments may themselves be a JSON string; unquote one level
        // and require the result to be valid JSON, as termixgo does.
        const inner = rawArgs.trim();
        if (inner) {
          try {
            const once = JSON.parse(inner) as unknown;
            argsJson =
              typeof once === "string" ? once : (JSON.stringify(once) ?? null);
            if (argsJson !== null) JSON.parse(argsJson);
          } catch {
            argsJson = null;
          }
        }
      } else {
        argsJson = JSON.stringify(rawArgs) ?? null;
      }
    }
    if (!name || argsJson === null) {
      // Not a valid call: the block stays prose and the scan moves past it.
      prose += text.slice(cursor, end);
      cursor = end;
      continue;
    }
    prose += text.slice(cursor, start);
    calls.push({
      id: `call_muse_${++textToolSeq}`,
      name,
      arguments: argsJson,
    });
    cursor = end;
  }
  if (!sawBlock || calls.length === 0) return { prose: text, calls: [] };
  prose += text.slice(cursor);
  return { prose: prose.trim(), calls };
}

type ResponsesOutcome = {
  text: string;
  usage: { prompt: number; completion: number; total: number } | null;
  error: string | null;
  /** Why a `response.incomplete` ended the reply ("max_output_tokens" when
   *  the backend cut the answer), or null for a completed response. */
  incompleteReason: string | null;
  /** Native function calls carried by the stream (namespace route), in
   *  arrival order. Empty on the text-protocol route. */
  nativeCalls: { id: string; name: string; arguments: string }[];
};

function readResponsesStream(sseText: string): ResponsesOutcome {
  let text = "";
  let usage: ResponsesOutcome["usage"] = null;
  let error: string | null = null;
  let incompleteReason: string | null = null;
  const nativeCalls: ResponsesOutcome["nativeCalls"] = [];
  // Muse finalizes a call's arguments in a dedicated done event, and the
  // output_item.done item can carry them empty; track both the finalized
  // value and the accumulated deltas per item id (termixgo's decoder).
  const finalArgs = new Map<string, string>();
  const deltaArgs = new Map<string, string>();
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
    } else if (event.type === "response.function_call_arguments.delta") {
      const itemId = asString(event.item_id);
      if (itemId && typeof event.delta === "string") {
        deltaArgs.set(itemId, (deltaArgs.get(itemId) ?? "") + event.delta);
      }
    } else if (event.type === "response.function_call_arguments.done") {
      const itemId = asString(event.item_id);
      if (itemId) {
        const args = asString(event.arguments) || deltaArgs.get(itemId) || "";
        if (args) finalArgs.set(itemId, args);
      }
    } else if (event.type === "response.output_item.done") {
      const item = isObject(event.item) ? event.item : null;
      if (item && item.type === "function_call") {
        const name = asString(item.name);
        const callId = asString(item.call_id);
        if (name && callId) {
          const itemId = asString(item.id);
          const args =
            asString(item.arguments) ||
            finalArgs.get(itemId) ||
            deltaArgs.get(itemId) ||
            "{}";
          nativeCalls.push({ id: callId, name, arguments: args });
        }
      }
    } else if (event.type === "response.subscription_usage") {
      // The quota reading rides the stream; stash it for the account UI.
      recordMuseSubscription(event.subscription);
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
      if (event.type === "response.incomplete") {
        const details =
          response && isObject(response.incomplete_details)
            ? response.incomplete_details
            : null;
        incompleteReason = asString(details?.reason) || "unknown";
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
  return { text, usage, error, incompleteReason, nativeCalls };
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
  // An incomplete response that is not the output limit is a failure with a
  // name (content filter, refusal, ...): surface it like termixgo does
  // instead of passing the partial text off as a finished answer.
  if (
    outcome.incompleteReason &&
    outcome.incompleteReason !== "max_output_tokens"
  ) {
    return `data: ${JSON.stringify({ error: { message: `Muse response incomplete: ${outcome.incompleteReason}`, code: "muse_response_incomplete" } })}\n\ndata: [DONE]\n\n`;
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
    // A reply the backend cut at its output limit ends as "length", never
    // as a clean "stop": the partial text is real, but filing it as
    // finished is how truncated answers passed as complete. The agent loop
    // names the pause and auto-continues it, as termixgo does.
    chunk(
      {
        index: 0,
        delta: {},
        finish_reason:
          outcome.incompleteReason === "max_output_tokens" ? "length" : "stop",
      },
      true,
    );
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

/**
 * The native-route twin of `responsesStreamToChatSse`: the stream's text
 * and its real function_call items become chat-completions chunks, with
 * the call ids Meta issued (the next request replays them as `fc_` items).
 * Same incomplete and failure semantics as the text route.
 */
export function responsesNativeStreamToChatSse(
  sseText: string,
  model: string,
): string {
  const outcome = readResponsesStream(sseText);
  if (outcome.error) {
    return `data: ${JSON.stringify({ error: { message: outcome.error, code: "muse_response_failed" } })}\n\ndata: [DONE]\n\n`;
  }
  if (
    outcome.incompleteReason &&
    outcome.incompleteReason !== "max_output_tokens"
  ) {
    return `data: ${JSON.stringify({ error: { message: `Muse response incomplete: ${outcome.incompleteReason}`, code: "muse_response_incomplete" } })}\n\ndata: [DONE]\n\n`;
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
  const calls = outcome.nativeCalls;
  if (outcome.text) {
    chunk({
      index: 0,
      delta: { role: "assistant", content: outcome.text },
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
  chunk(
    {
      index: 0,
      delta: {},
      finish_reason:
        calls.length > 0
          ? "tool_calls"
          : outcome.incompleteReason === "max_output_tokens"
            ? "length"
            : "stop",
    },
    true,
  );
  lines.push("data: [DONE]\n\n");
  return lines.join("");
}
