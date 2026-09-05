import { generateText } from "ai";

export const SUMMARY_TIMEOUT_MS = 90_000;

export function safeJson(v: unknown): string {
  try {
    return typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
  } catch {
    return String(v);
  }
}

/**
 * Recover a summary when the model produced no final text. Reconstructs what it
 * gathered across the run (each step's text and tool results) and asks once more
 * - with NO tools offered - for a prose answer. Returns "" when there is nothing
 * to summarize or the follow-up fails. Ported from TEDI: this is what stops a
 * completed sub-agent from returning "(no output)".
 */
export async function synthesizeSummary(
  model: Parameters<typeof generateText>[0]["model"],
  systemPrompt: string,
  prompt: string,
  result: Awaited<ReturnType<typeof generateText>>,
  abortSignal: AbortSignal,
): Promise<string> {
  const lines: string[] = [];
  for (const s of result.steps ?? []) {
    const t = s.text?.trim();
    if (t) lines.push(t);
    for (const tr of (s.toolResults ?? []) as Array<{
      toolName?: string;
      input?: unknown;
      output?: unknown;
      result?: unknown;
    }>) {
      const out = tr.output ?? tr.result;
      const outStr = typeof out === "string" ? out : safeJson(out);
      lines.push(
        `${tr.toolName ?? "tool"}(${safeJson(tr.input)}) -> ${outStr.slice(0, 800)}`,
      );
    }
  }
  if (lines.length === 0) return "";
  const findings = lines.join("\n").slice(0, 12000);
  try {
    const fu = await generateText({
      model,
      system: systemPrompt,
      prompt: `${prompt}\n\nHere is what you gathered while working:\n${findings}\n\nNow write your final summary in prose. Do not call tools; do not mention tools.`,
      abortSignal,
    } as Parameters<typeof generateText>[0]);
    return fu.text?.trim() ?? "";
  } catch {
    return "";
  }
}
