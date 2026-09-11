import { usePreferencesStore } from "@/modules/settings/preferences";
import { generateText } from "ai";
import { useChatStore } from "../store/chatStore";
import { buildConfiguredLanguageModel } from "./agent";

/**
 * Context-aware side questions (`/btw`) — Hermes parity, one-shot path.
 *
 * Answers a question ABOUT the conversation without touching it: no synthetic
 * turns are appended, the transcript stays byte-identical, and the prompt
 * cache of the main run is never invalidated. The answer is rendered as a
 * dismissible notice (see SideQuestionNotice), not as a chat message.
 *
 * The transcript is rendered to a plain-text snapshot (newest-biased, budgeted)
 * and sent with the question in ONE tools-disabled `generateText` call, so a
 * side question can never mutate anything.
 *
 * This module is imported LAZILY from slashCommands (dynamic `import()`), so
 * the AI SDK never lands in the eager startup bundle.
 */

// Per-message and total character budgets (Hermes: side_question.py).
const PER_MESSAGE_CHAR_CAP = 2000;
const TRANSCRIPT_CHAR_BUDGET = 24000;

const INSTRUCTIONS = [
  "You are the same AI assistant that is currently working inside the conversation transcribed below.",
  "The user has asked a quick SIDE question with /btw while the main work continues.",
  "Rules:",
  "- Answer ONLY the side question. Do not continue, redo, or critique the main task.",
  "- Use the transcript as your primary context; it is a snapshot and may not include the very latest activity.",
  "- If the transcript does not contain enough information to answer, say so plainly instead of guessing.",
  "- Be concise and direct.",
].join("\n");

/** Minimal structural view of a UIMessage so the renderer stays testable
 *  without AI SDK generics. `UIMessage[]` is assignable to this. */
export type SideQuestionPart = {
  type: string;
  text?: unknown;
  toolName?: unknown;
  state?: unknown;
  output?: unknown;
};

export type SideQuestionMessage = {
  role: string;
  parts?: readonly SideQuestionPart[];
};

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}

/**
 * Render the transcript as plain text: newest-biased fit to `charBudget`,
 * tool calls summarised by name, tool results truncated, system messages
 * skipped. Port of Hermes' `render_history_for_side_question`.
 */
export function renderTranscript(
  messages: readonly SideQuestionMessage[],
  charBudget: number = TRANSCRIPT_CHAR_BUDGET,
): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (!m || m.role === "system") continue;
    const texts: string[] = [];
    const toolNames: string[] = [];
    const results: string[] = [];
    for (const p of m.parts ?? []) {
      if (!p || typeof p !== "object") continue;
      if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
        texts.push(p.text);
      } else if (
        typeof p.type === "string" &&
        (p.type.startsWith("tool-") || p.type === "dynamic-tool")
      ) {
        const name =
          typeof p.toolName === "string" && p.toolName
            ? p.toolName
            : p.type.replace(/^tool-/, "") || "?";
        toolNames.push(name);
        if (p.state === "output-available" && p.output != null) {
          results.push(`${name}: ${stringifyOutput(p.output)}`);
        }
      }
    }
    if (toolNames.length > 0) {
      lines.push(`ASSISTANT [called tools: ${toolNames.join(", ")}]`);
    }
    const label = m.role === "user" ? "USER" : "ASSISTANT";
    if (texts.length > 0) {
      lines.push(`${label}: ${texts.join("\n").slice(0, PER_MESSAGE_CHAR_CAP)}`);
    }
    for (const r of results) {
      lines.push(`TOOL RESULT: ${r.slice(0, PER_MESSAGE_CHAR_CAP)}`);
    }
  }

  // Newest-biased fit: walk from the end and keep what fits the budget.
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (used + line.length + 1 > charBudget && kept.length > 0) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (kept.length === 0) return "(no prior conversation)";
  kept.reverse();
  const prefix =
    kept.length < lines.length
      ? "[...older conversation omitted...]\n"
      : "";
  return prefix + kept.join("\n");
}

/**
 * Answer a side question from a transcript snapshot in one aux call.
 * Throws on failure or an empty answer — the caller surfaces the error.
 */
export async function answerSideQuestion(
  question: string,
  messages: readonly SideQuestionMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const q = question.trim();
  if (!q) throw new Error("answerSideQuestion requires a non-empty question");

  const { selectedModelId, apiKeys, customEndpointKeys } =
    useChatStore.getState();
  const prefs = usePreferencesStore.getState();
  const model = await buildConfiguredLanguageModel(selectedModelId, apiKeys, {
    lmstudioBaseURL: prefs.lmstudioBaseURL,
    lmstudioModelId: prefs.lmstudioModelId,
    mlxBaseURL: prefs.mlxBaseURL,
    mlxModelId: prefs.mlxModelId,
    ollamaBaseURL: prefs.ollamaBaseURL,
    ollamaModelId: prefs.ollamaModelId,
    openaiCompatibleBaseURL: prefs.openaiCompatibleBaseURL,
    openaiCompatibleModelId: prefs.openaiCompatibleModelId,
    openrouterModelId: prefs.openrouterModelId,
    customEndpoints: prefs.customEndpoints,
    customEndpointKeys,
    modelIdOverrides: prefs.modelIdOverrides,
  });

  const transcript = renderTranscript(messages);
  const { text } = await generateText({
    model,
    abortSignal: signal,
    maxOutputTokens: 2048,
    temperature: 0.3,
    system: INSTRUCTIONS,
    prompt: `Conversation transcript (snapshot):\n-----\n${transcript}\n-----\n\nSide question: ${q}`,
  });

  const answer = (text ?? "").trim();
  if (!answer) throw new Error("The side question returned an empty answer");
  return answer;
}
