// Start a plain agent task through the in-app agent — the frontend half of
// `termigo run "<task>"`. Unlike the pentest helpers there is no scope or run
// store: the task is generic, and the chat transcript is its own record.
//
// `sendMessage` (chatRuntime) is imported lazily: it pulls the AI SDK, which
// must never enter the eager startup bundle (app/eager-budget.test.ts).

export async function runAgentTask(
  prompt: string,
): Promise<{ ok: boolean; message?: string }> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return { ok: false, message: "agent prompt is required" };
  }
  const { sendMessage } = await import("@/modules/ai/store/chatRuntime");
  const ok = await sendMessage(trimmed);
  if (!ok) {
    return {
      ok: false,
      message:
        "no active chat session; open a workspace and pick a model first",
    };
  }
  return { ok: true };
}
