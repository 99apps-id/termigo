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

/**
 * Detect whether a returned subagent summary is actually an unfinished
 * sentence (e.g. pre-tool thought cut off by step exhaustion) or a garbled
 * stream of pseudo tool-calls emitted by an interrupted model.
 */
export function isUnfinishedOrGarbledSummary(
  summary: string,
  result: {
    steps?: Array<{
      toolCalls?: Array<unknown>;
      finishReason?: string;
      text?: string;
    }>;
  },
  maxSteps: number,
): boolean {
  const trimmed = (summary ?? "").trim();
  if (!trimmed) return true;

  const steps = result.steps ?? [];
  const lastStep = steps[steps.length - 1];
  const lastStepHasToolCalls = Boolean(
    lastStep?.toolCalls && lastStep.toolCalls.length > 0,
  );
  const hitStepLimit = steps.length >= maxSteps;

  // If the run ended with an active tool call or step cap, check if the text
  // was merely a brief pre-tool sentence (e.g. "Let me check ...:")
  if (lastStepHasToolCalls || hitStepLimit) {
    if (/:$/.test(trimmed) || trimmed.length < 120) {
      return true;
    }
  }

  // Hallucinated pseudo tool tags or simulated tool outputs
  if (
    /<(?:tool_call|function|tool_code)[\s>]/i.test(trimmed) ||
    /<\/(?:tool_call|function|tool_code)>/i.test(trimmed) ||
    /\bread_file\s*\(\s*\{/i.test(trimmed) ||
    /\b(?:list_directory|bash_run|grep|glob)\s*\(\s*\{/i.test(trimmed)
  ) {
    return true;
  }

  return false;
}

/**
 * Remove raw pseudo-tool tags from text if synthesis fallback is needed.
 */
export function sanitizeGarbledSummary(text: string): string {
  if (!text) return "";
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<function[\s\S]*?<\/function>/gi, "")
    .replace(/<\/?(?:tool_call|function|tool_code)>/gi, "")
    .trim();
}
