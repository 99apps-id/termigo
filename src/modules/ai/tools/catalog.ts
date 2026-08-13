// Sub-agent tool catalog (TEDI shim). Termigo's agent tools include the
// sub-agent spawner; this mirrors TEDI's catalog helpers so the extension
// host can toggle sub-agent tools consistently.
export const SUBAGENT_TOOL_NAMES = ["run_subagent", "run_subagents"] as const;

/** True when sub-agent tools are not disabled for this turn. */
export function subagentsAvailable(disabled: ReadonlySet<string>): boolean {
  return !disabled.has("run_subagents");
}

/** The off-list that switching sub-agents off implies (order-stable). */
export function withSubagentsDisabled(disabled: readonly string[]): string[] {
  return [...new Set([...disabled, ...SUBAGENT_TOOL_NAMES])].sort();
}
