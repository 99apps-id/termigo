// Approval policy for agent tool calls.
//
// Read-only tools (read_file, grep, list_directory, bash_logs, ...) never ask:
// they carry no `needsApproval`, so they are not part of this decision at all.
// What reaches here is only the mutating set, and the modes below decide which
// of those may proceed without stopping for a click.
//
// The safety rails are NOT part of this decision. Every tool re-checks its own
// input inside `execute` (checkWritableCanonical, checkShellCommand), after
// approval has already been granted. Auto-approval therefore skips the prompt,
// never the check: a command that security.ts refuses is still refused in
// every mode.

/** Tools that change files inside the workspace. */
const EDIT_TOOLS = new Set([
  "write_file",
  "create_directory",
  "edit",
  "multi_edit",
]);

/** Tools that run commands or hand work to another agent. */
const EXEC_TOOLS = new Set([
  "bash_run",
  "bash_background",
  "spawn_coding_agent",
  "send_to_agent",
]);

export type ApprovalMode =
  /** Every mutating tool waits for a click. The default. */
  | "ask"
  /** File edits inside the workspace proceed; commands still wait. */
  | "edits"
  /** Nothing waits. The safety checks still run. */
  | "all";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["ask", "edits", "all"];

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "ask";

export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  ask: "Ask every time",
  edits: "Auto-approve edits",
  all: "Auto-approve all",
};

export const APPROVAL_MODE_HINTS: Record<ApprovalMode, string> = {
  ask: "Every file change and command waits for your approval.",
  edits:
    "File edits in the workspace run automatically. Commands and agent hand-offs still ask.",
  all: "Nothing waits for approval. Safety checks still block unsafe paths and commands.",
};

/**
 * Whether a tool call may proceed without asking.
 *
 * Unknown tool names are treated as exec-tier: a tool added later should
 * default to asking rather than inherit a blanket allowance.
 */
export function isAutoApproved(
  toolName: string,
  mode: ApprovalMode,
): boolean {
  if (mode === "all") return true;
  if (mode === "edits") return EDIT_TOOLS.has(toolName);
  return false;
}

/** Tool-name tier, for explaining a decision in the UI. */
export function approvalTier(toolName: string): "edit" | "exec" {
  return EDIT_TOOLS.has(toolName) ? "edit" : EXEC_TOOLS.has(toolName) ? "exec" : "exec";
}
