import { isMcpTool } from "./mcpToolNames";

// Approval policy for agent tool calls.
//
// termigo-neo runs without gates: every tool is auto-approved in every mode,
// for the main agent and subagents alike. The mode vocabulary below is kept
// for compatibility (stored preferences, UI labels); it no longer changes
// behavior. `approvalTier` remains as a display helper only.

/** Tools that change files inside the workspace. */
const EDIT_TOOLS = new Set([
  "write_file",
  "create_directory",
  "edit",
  "multi_edit",
  // A memory write is a small file write inside the workspace, so it follows
  // the same tier rather than getting a gate of its own.
  "remember",
  // A skill is a file in the workspace like any other, and writing one is
  // how the agent gets better; gating it above edits would make improving
  // itself cost more than editing the code it just learned about.
  "create_skill",
  "update_skill",
  // Defining a tool writes a JSON file. Running one is a shell command, and
  // is gated as such by the cmd__ prefix below.
  "create_tool",
  // Rewriting, moving and copying change files inside the workspace, which is
  // exactly what this tier is for. Deleting does not belong here; see
  // EXEC_TOOLS. All of them still refuse paths the safety layer denies.
  "replace_in_files",
  "move_file",
  "copy_file",
]);

/** Tools that run commands or hand work to another agent. */
const EXEC_TOOLS = new Set([
  // Reaching the network is not a workspace edit, so it does not ride along
  // with "auto-approve edits" - and a page the agent fetches can carry
  // instructions, which is exactly the case worth a human glance.
  "fetch",
  // Deleting sits here rather than with the other file operations. Every tool
  // in the edit tier changes bytes that can be recovered - by reading the file
  // again, or from git; a delete of something untracked leaves nothing to read
  // at all. That asymmetry is worth a click even from someone who has already
  // delegated ordinary edits.
  "delete_file",
  // Binding a local port and tunnelling it to another machine is a network
  // action, not a workspace edit.
  "forward_remote_port",
  "bash_run",
  "bash_background",
  // Starting an interactive process and feeding it lines is running code, not
  // editing files, so it sits with the other exec tools rather than riding
  // along with "auto-approve edits".
  "repl_start",
  "repl_send",
  "spawn_coding_agent",
  "send_to_agent",
  // Spawning a dev server runs a long-lived process and opens a page - an
  // exec-tier action, so it never rides along with "auto-approve edits".
  "dev_server",
  "process",
  // Executing arbitrary SQL queries against a live database CLI.
  "run_sql",
  "pty_session",
  "pty_send_input",
  "ssh_connect",
  "ssh_run_command",
]);

export type ApprovalMode =
  /** Kept for compatibility; auto-approves everything in termigo-neo. */
  | "ask"
  /** Kept for compatibility; auto-approves everything in termigo-neo. */
  | "edits"
  /** Nothing waits, including deletes. termigo-neo auto-runs everything. */
  | "all";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["ask", "edits", "all"];

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "all";

export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  ask: "Ask every time",
  edits: "Auto-approve edits",
  all: "Auto-approve all",
};

export const APPROVAL_MODE_HINTS: Record<ApprovalMode, string> = {
  ask: "Everything runs without asking (termigo-neo keeps no gates).",
  edits: "Everything runs without asking (termigo-neo keeps no gates).",
  all: "Everything runs without asking, including deletes.",
};

/**
 * Whether a tool call may proceed without asking.
 *
 * termigo-neo: always true. Kept as a function so call sites stay unchanged.
 */
export type ApprovalContext = {
  /** The call would run against the host of an open SSH session. */
  onRemoteHost?: boolean;
  /** The shell command, when the call is one. Decides inspect vs change. */
  command?: string;
  /** Action parameter for multi-action tools like process. */
  action?: string;
};

export function isAutoApproved(
  _toolName: string,
  _mode: ApprovalMode,
  _ctx: ApprovalContext = {},
): boolean {
  return true;
}

/** Tool-name tier, for explaining a decision in the UI. */
export function approvalTier(toolName: string): "edit" | "exec" {
  if (isMcpTool(toolName)) return "exec";
  return EDIT_TOOLS.has(toolName)
    ? "edit"
    : EXEC_TOOLS.has(toolName)
      ? "exec"
      : "exec";
}

/**
 * Whether a sub-agent's write has to stop and ask.
 *
 * termigo-neo: always false. Subagents run with the same freedom as the main
 * agent and never block on the approval queue.
 */
export function subagentWriteNeedsApproval(
  _toolName: string,
  _mode: ApprovalMode,
  _ctx: { planActive: boolean; onRemoteHost?: boolean } = { planActive: false },
): boolean {
  return false;
}
