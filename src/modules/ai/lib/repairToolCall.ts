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
        // A valid JSON escape passes through untouched. Anything else - most
        // often a Windows path emitted raw (`C:\project`, `\Users`, `\d` from a
        // regex) - is not JSON at all, and strict parse rejects it. Double the
        // backslash so the literal path the model meant survives parsing.
        const next = text[i + 1];
        if (
          next === '"' ||
          next === "\\" ||
          next === "/" ||
          next === "b" ||
          next === "f" ||
          next === "n" ||
          next === "r" ||
          next === "t" ||
          next === "u"
        ) {
          out += ch;
          escaped = true;
          continue;
        }
        out += "\\\\";
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
        const isStructural =
          next === undefined ||
          next === "," ||
          next === "}" ||
          next === "]" ||
          next === ":";
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
 * Edit distance between two strings (Levenshtein). Used to match a tool name
 * the model typed slightly wrong to the closest one we actually expose.
 */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Find the available tool name closest to `requested`. Accepts the match only
 * when the edit distance is small relative to the name length, so we fix a
 * near-miss typo (e.g. `ext_...-kool_...` → `ext_...-kit_...`) without ever
 * rewriting one real tool name into a different real tool.
 */
function bestToolMatch(
  requested: string,
  available: readonly string[],
): string | null {
  let best = "";
  let bestDistance = Infinity;
  for (const name of available) {
    const d = editDistance(requested, name);
    if (d < bestDistance) {
      bestDistance = d;
      best = name;
    }
  }
  if (best === "") return null;
  const longer = Math.max(requested.length, best.length);
  // Allow a couple of edits, growing with the name length, but never enough to
  // turn one genuinely different, similarly-named tool into another.
  const threshold = Math.max(2, Math.round(longer * 0.12));
  return bestDistance <= threshold ? best : null;
}

/**
 * The `experimental_repairToolCall` hook. Returns a repaired tool call whose
 * name is a real tool and whose `input` is clean JSON, or `null` to let the
 * original error surface.
 */
export async function repairToolCall({
  toolCall,
  tools,
}: {
  toolCall: {
    toolCallId: string;
    toolName: string;
    input?: string;
    args?: string;
  };
  tools?: Record<string, unknown>;
}): Promise<{
  toolCallId: string;
  toolName: string;
  input: string;
} | null> {
  // A tool the model named that we do not expose (a `NoSuchToolError`). The
  // model often mis-types a long, hyphenated extension tool name — fix it to
  // the nearest real tool instead of killing the whole run. Only possible when
  // we have the toolset to match against.
  const toolKeys = tools ? Object.keys(tools) : [];
  if (toolKeys.length > 0 && !toolKeys.includes(toolCall.toolName)) {
    const match = bestToolMatch(toolCall.toolName, toolKeys);
    if (match) {
      return {
        toolCallId: toolCall.toolCallId,
        toolName: match,
        input: String(toolCall.input ?? toolCall.args ?? "{}"),
      };
    }
    return null;
  }

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
