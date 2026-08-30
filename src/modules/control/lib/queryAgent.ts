// Headless single-shot Q&A for scripting — the frontend half of
// `termigo query "<question>"`. Sends a read-only-wrapped prompt to the in-app
// agent, waits for the run to settle, and returns just the final assistant
// text, so a terminal can use the agent like a function.
//
// The chat runtime (@ai-sdk/react + the AI SDK) is imported lazily: it must
// never enter the eager startup bundle (app/eager-budget.test.ts).

import { extractMessageText } from "@/modules/ai/lib/sessions";
import { useChatStore } from "@/modules/ai/store/chatStore";

/** The control response is capped at 64 KiB; keep the answer well under it. */
const QUERY_MAX_TEXT = 60 * 1024;
const POLL_MS = 150;

export type QueryResult =
  | { ok: true; text: string }
  | { ok: false; message: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wrap the question with a read-only directive so a scripting call never asks
 *  to mutate anything. Read-only tools auto-run; anything mutating would still
 *  need approval, which a headless caller cannot give. */
function wrapQuery(prompt: string): string {
  return `<termigo-query>\n${prompt}\n</termigo-query>\nAnswer read-only: you may use read-only tools (read_file, list_directory, grep, glob, git_status, git_diff, git_log, context_report) but must not edit or write files, run mutating or destructive commands, or spawn sub-agents. Answer concisely with the final result only.`;
}

export async function runQuery(
  prompt: string,
  timeoutMs = 300_000,
): Promise<QueryResult> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return { ok: false, message: "query prompt is required" };
  }
  const { sendMessage, getOrCreateChat } = await import(
    "@/modules/ai/store/chatRuntime"
  );
  const sessionId = useChatStore.getState().activeSessionId;
  if (!sessionId) {
    return {
      ok: false,
      message:
        "no active chat session; open a workspace and pick a model first",
    };
  }
  const beforeCount = getOrCreateChat(sessionId).messages.length;
  const ok = await sendMessage(wrapQuery(trimmed));
  if (!ok) {
    return {
      ok: false,
      message:
        "no active chat session; open a workspace and pick a model first",
    };
  }

  // Wait for the run to produce a new assistant message and settle.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const meta = useChatStore.getState().agentMeta;
    const busy =
      meta.status === "thinking" ||
      meta.status === "streaming" ||
      meta.status === "awaiting-approval";
    const chat = getOrCreateChat(sessionId);
    if (!busy && chat.messages.length > beforeCount) {
      const lastAssistant = [...chat.messages]
        .reverse()
        .find((m) => m.role === "assistant");
      const text = lastAssistant ? extractMessageText([lastAssistant]) : "";
      return {
        ok: true,
        text:
          text.length > QUERY_MAX_TEXT
            ? `${text.slice(0, QUERY_MAX_TEXT)}\n… (truncated)`
            : text,
      };
    }
    if (meta.status === "error") {
      return { ok: false, message: meta.error ?? "the agent run failed" };
    }
    await sleep(POLL_MS);
  }
  return { ok: false, message: "timed out waiting for the agent answer" };
}
