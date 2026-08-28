import { usePreferencesStore } from "@/modules/settings/preferences";
import { generateText } from "ai";
import { useChatStore } from "../store/chatStore";
import { buildConfiguredLanguageModel } from "./agent";

/**
 * Opt-in AI autosuggestion for the block terminal input.
 *
 * This module is imported LAZILY from the shell input (dynamic `import()`),
 * exactly so the AI SDK never lands in the terminal's eager startup bundle —
 * the whole reason the terminal stays cheap to boot. It is only reached when
 * the user has turned the setting on and local history had no match.
 *
 * The call is debounced, deduplicated by a monotonic sequence (only the latest
 * keystroke's request may resolve with a value), aborts the previous in-flight
 * request, and caches results per line so re-typing the same prefix is free.
 */

type SuggestContext = {
  cwd: string | null;
  /** Recent / known command first-words, most-recent first. */
  commands: string[];
};

const DEBOUNCE_MS = 300;
const CACHE_MAX = 300;
const MIN_LEN = 2;

let seq = 0;
let inflight: AbortController | null = null;
// line -> completion (or null when the model declined). A single flat cache
// bounded by size; cleared wholesale when it grows too large.
const cache = new Map<string, string | null>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A model reply is only usable as a ghost suggestion when it EXTENDS the current
 * line: it must begin with exactly what the user typed and add at least one
 * character. Anything else (a reworded command, the bare prefix echoed back, a
 * shorter string) is dropped. Exported for testing.
 */
export function usableSuggestion(
  line: string,
  raw: string | null,
): string | null {
  if (!raw) return null;
  return raw.startsWith(line) && raw.length > line.length ? raw : null;
}

function buildPrompt(line: string, ctx: SuggestContext): string {
  const recent = ctx.commands.slice(0, 40).join(", ");
  return [
    "You are a shell command autocompletion engine, like fish shell's autosuggestions.",
    "Given the working directory, the commands the user runs often, and a partial command line, output the SINGLE most likely FULL command line the user is about to run.",
    "",
    "Rules:",
    "- The output MUST begin with exactly the partial text, character for character.",
    "- Output ONLY the command. No markdown, no backticks, no quotes, no explanation, no trailing newline.",
    "- Infer the shell (bash/zsh/pwsh/cmd) from the recent commands.",
    "- Prefer a real, runnable command over a guess. If you cannot confidently complete it, output the partial text unchanged.",
    "",
    ctx.cwd ? `cwd: ${ctx.cwd}` : "cwd: (unknown)",
    recent ? `frequent commands: ${recent}` : "",
    "",
    `partial: ${line}`,
    "completion:",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

async function callModel(
  line: string,
  ctx: SuggestContext,
  signal: AbortSignal,
): Promise<string | null> {
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
  });
  const { text } = await generateText({
    model,
    abortSignal: signal,
    maxOutputTokens: 48,
    temperature: 0,
    prompt: buildPrompt(line, ctx),
  });
  // The model may add a trailing newline or stray whitespace; take the first
  // non-empty line only.
  const first = text.split("\n").find((l) => l.trim().length > 0);
  return first ? first.trimEnd() : null;
}

/**
 * Returns the full suggested command line (which the ghost widget then trims to
 * the tail after the caret), or null when there is nothing worth showing. Safe
 * to call on every keystroke: debounced and superseded internally.
 */
export async function aiTerminalSuggest(
  line: string,
  ctx: SuggestContext,
): Promise<string | null> {
  if (line.trim().length < MIN_LEN) return null;
  if (cache.has(line)) return cache.get(line) ?? null;

  const my = ++seq;
  await sleep(DEBOUNCE_MS);
  // A newer keystroke arrived while we waited — let its request win.
  if (my !== seq) return null;

  inflight?.abort();
  inflight = new AbortController();
  const signal = inflight.signal;

  try {
    const raw = await callModel(line, ctx, signal);
    if (my !== seq) return null;
    const valid = usableSuggestion(line, raw);
    cache.set(line, valid);
    if (cache.size > CACHE_MAX) cache.clear();
    return valid;
  } catch {
    return null;
  }
}
