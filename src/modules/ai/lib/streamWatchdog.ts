/**
 * What a stream chunk means for the run's silence watchdog.
 *
 * The watchdog exists to catch a provider that goes quiet: the run stays
 * "streaming" forever, the UI shows a spinner, and messages typed meanwhile are
 * queued behind a run that will never finish. Observed in the field as ~20
 * minutes of `sdk=streaming app=streaming` with no further log line.
 *
 * It failed because it was cleared on the FIRST chunk of any kind and never
 * re-armed, so it protected only the opening moment of a run. A reasoning model
 * made that worse: a `reasoning-delta` is a chunk, so it cleared the watchdog
 * before the model had answered anything - and when the provider then stalled,
 * nothing was watching.
 *
 * The fix is to measure silence FROM NOW rather than time-to-first-response, and
 * to be explicit about which chunks legitimately mean "nobody is expected to be
 * sending": while a tool executes, a provider is silent by design and can be so
 * for minutes. Hence a three-way decision instead of a boolean.
 *
 * Pure so the policy is asserted by a test: only a real stalled provider can
 * exercise it otherwise.
 */
export type WatchdogDirective =
  /** The model is producing. Restart the silence clock. */
  | "rearm"
  /**
   * A tool is about to run. Stop watching: tool execution sends no chunks by
   * design, and a long one is normal (a build, a scan). `onStepFinish` re-arms
   * once the tool is done.
   */
  | "disarm"
  /** No opinion either way: leave the watchdog exactly as it is. */
  | "ignore";

/**
 * The chunk types that mean the model itself is still talking.
 *
 * `reasoning-delta` is included deliberately. It is easy to dismiss thinking as
 * "not an answer", but it IS the provider sending data - and treating it as
 * silence would abort a model that thinks for a while before answering, which is
 * a supported style rather than a fault.
 */
const MODEL_PRODUCING = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-input-start",
  "tool-input-delta",
  "source",
]);

/** The chunk that hands control to a tool, which then runs without sending. */
const HANDING_OFF = new Set(["tool-call"]);

/** The tool finished and the model is being asked again. */
const MODEL_AGAIN = new Set(["tool-result"]);

export function watchdogDirective(chunkType: string): WatchdogDirective {
  if (MODEL_PRODUCING.has(chunkType)) return "rearm";
  if (HANDING_OFF.has(chunkType)) return "disarm";
  if (MODEL_AGAIN.has(chunkType)) return "rearm";
  return "ignore";
}
