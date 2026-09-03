// Learn which models reject a PINNED tool choice, and stop pinning for them.
//
// Two places hand the provider a non-default `tool_choice`: the forced
// fan-out pin (step 0 → `{ type: "tool", toolName: "run_subagents" }`) and
// the synthesis step (`"none"`). The static metadata in config.ts
// (`modelAllowsForcedToolChoice`) only knows the built-in registry — a
// user-defined OpenAI-compatible endpoint (`compat-*`) has no tags at all,
// so it is assumed capable. Qwen-style "thinking mode" endpoints answer a
// required/object tool_choice with HTTP 400
//
//   "The tool_choice parameter does not support being set to required or
//    object in thinking mode"
//
// which killed the whole request on exactly the broad "audit this repo"
// prompts the fan-out is meant to serve. The provider's own rejection is
// the ground truth for a model we carry no metadata for: record it, drop
// the pin, and the same request succeeds (the model still has
// `run_subagents` — pinning was an optimisation, not a requirement).
//
// In-memory on purpose, like contextLimitLearning: a wrong guess costs one
// failed round, and persisting it would keep a model un-pinned across
// restarts even after the endpoint was fixed or swapped.

/** The rejection is about the request shape, not the transcript: "none" is
 *  accepted by thinking-mode endpoints (they reject only required/object),
 *  so only the object pin learns from it. */
export function isToolChoiceRejectionError(message: string): boolean {
  const m = String(message ?? "").toLowerCase();
  return (
    m.includes("tool_choice") ||
    (m.includes("tool choice") &&
      /(not support|unsupported|does not support|cannot|invalid)/i.test(m))
  );
}

const rejected = new Set<string>();

/** Remember that this model's endpoint refused a pinned tool choice. */
export function recordToolChoiceRejection(modelId: string): void {
  if (modelId) rejected.add(modelId);
}

/** Whether we have seen this model reject the pin. */
export function modelRejectsForcedToolChoice(modelId: string): boolean {
  return rejected.has(modelId);
}

/** Test hook: forget everything learned. */
export function resetToolChoiceLearning(): void {
  rejected.clear();
}
