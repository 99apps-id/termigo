// Sub-agent tool catalog (TEDI shim). Termigo's agent tools include the
// sub-agent spawner; this mirrors TEDI's catalog helpers so the extension
// host can toggle sub-agent tools consistently.
export const SUBAGENT_TOOL_NAMES = ["run_subagent", "run_subagents"] as const;

/**
 * True when sub-agent tools are not disabled for this turn.
 *
 * Mirrors `withSubagentsDisabled`, which off-lists BOTH spawn tool names: asking
 * only about the plural left the singular still advertised when a caller disabled
 * the pair by its singular name.
 */
export function subagentsAvailable(disabled: ReadonlySet<string>): boolean {
  return SUBAGENT_TOOL_NAMES.every((name) => !disabled.has(name));
}

/** The off-list that switching sub-agents off implies (order-stable). */
export function withSubagentsDisabled(disabled: readonly string[]): string[] {
  return [...new Set([...disabled, ...SUBAGENT_TOOL_NAMES])].sort();
}
