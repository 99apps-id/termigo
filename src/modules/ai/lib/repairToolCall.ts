// Repair tool-call arguments that a model emitted as near-JSON.
//
// Some providers — StepFun via the OpenAI-compatible endpoint in particular —
// emit tool-call `arguments` as a JSON string that is *almost* valid: a literal
// newline inside a string value, or an unescaped double quote in prose
// (`audit "route.ts"`), or a trailing comma. The AI SDK's strict `JSON.parse`
// then fails with "Invalid input for tool ... JSON parsing failed", and the
// whole batch dies. This module is the `experimental_repairToolCall` hook: it
// makes a best-effort repair so a recoverable input runs instead of failing.

import { parsePartialJson } from "ai";

/** Strip a markdown code fence (` ```json ... ``` `) around the args. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fence ? fence[1] : trimmed;
}

/**
 * Repair common JSON malformations from model output. The hardest is an
 * unescaped double quote inside a string value; we decide per-quote whether it
 * closes the string (followed by `,` `}` `]` `:` or end) or is literal
 * (followed by ordinary text) and escape it accordingly.
 */
export function repairJsonText(text: string): string {
  text = stripCodeFence(text);
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        // Look ahead past any whitespace: a closing quote is followed by a
        // structural char (`,`, `}`, `]`, `:`) or the end of the text. If it is
        // followed by ordinary text, it is an unescaped quote in prose and must
        // be escaped.
        let j = i + 1;
        while (j < text.length && /[ \t]/.test(text[j])) j++;
        const next = text[j];
        const isStructural = next === undefined || next === "," || next === "}" || next === "]" || next === ":";
        if (isStructural) {
          inString = false;
          out += ch;
        } else {
          out += "\\" + '"';
        }
        continue;
      }
      if (ch === "\n" || ch === "\r") {
        out += "\\n";
        continue;
      }
      out += ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    out += ch;
  }
  // Remove a trailing comma before a closing brace/bracket.
  return out.replace(/,\s*([}\]])/g, "$1");
}

/**
 * The `experimental_repairToolCall` hook. Returns a repaired tool call whose
 * `input` is clean JSON, or `null` to let the original error surface.
 */
export async function repairToolCall({
  toolCall,
}: {
  toolCall: { toolCallId: string; toolName: string; input?: string; args?: string };
}): Promise<{
  toolCallId: string;
  toolName: string;
  input: string;
} | null> {
  const raw = stripCodeFence(String(toolCall.input ?? toolCall.args ?? ""));
  if (raw.length === 0) return null;

  // Already valid — let the SDK re-parse as usual.
  try {
    JSON.parse(raw);
    return null;
  } catch {
    // fall through to repair
  }

  const repaired = repairJsonText(raw);
  // Try strict, then the SDK's lenient partial parser as a final fallback. We
  // always return `input` as a JSON *string* because the SDK re-parses it.
  try {
    JSON.parse(repaired);
    return { ...toolCall, input: repaired };
  } catch {
    try {
      const { value } = await parsePartialJson(repaired);
      if (value !== undefined) {
        return { ...toolCall, input: JSON.stringify(value) };
      }
    } catch {
      // ignore
    }
  }
  return null;
}
