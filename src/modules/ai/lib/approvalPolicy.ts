import { isMcpTool } from "./mcpToolNames";
import { isExtensionTool } from "./extensionToolNames";
import { isCustomTool } from "./customToolNames";

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
  // A memory write is a small file write inside the workspace, so it follows
  // the same tier rather than getting a gate of its own.
  "remember",
  // A skill is a file in the workspace like any other, and writing one is
  // how the agent gets better; gating it above edits would make improving
  // itself cost more than editing the code it just learned about.
  "create_skill",
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
/**
 * Tools that ask every time once they would act on someone else's machine.
 *
 * The safety layer's whole shape is "inside this workspace": every file tool
 * refuses paths outside it, which is what makes delegating them reasonable.
 * A command on a remote host has no equivalent boundary - `apt`, `systemctl`
 * and `docker` are all legitimate and all capable of taking down a production
 * server - so this is the one place a mode is not allowed to speak for the
 * user.
 */
const REMOTE_ALWAYS_ASK = new Set(["bash_run", "bash_background"]);

export type ApprovalContext = {
  /** The call would run against the host of an open SSH session. */
  onRemoteHost?: boolean;
};

export function isAutoApproved(
  toolName: string,
  mode: ApprovalMode,
  ctx: ApprovalContext = {},
): boolean {
  if (ctx.onRemoteHost && REMOTE_ALWAYS_ASK.has(toolName)) return false;
  if (mode === "all") return true;
  // An MCP tool is third-party code doing something this app cannot inspect,
  // so it never rides along with "auto-approve edits" - which is a statement
  // about files in this workspace, not about arbitrary external actions. The
  // unknown-name fallback would already land here; saying it outright means a
  // later change to that fallback cannot quietly widen this.
  if (isMcpTool(toolName)) return false;
  // Same reasoning for extension tools: third-party code doing something this
  // app cannot inspect. An extension may declare `auto`, which decides whether
  // the tool asks at all - it does not decide that "auto-approve edits" covers
  // it, because that mode is a statement about files in this workspace.
  if (isExtensionTool(toolName) && mode === "edits") return false;
  // A custom tool runs a shell command, so it belongs with bash_run rather
  // than with the file edits, whoever wrote the template.
  if (isCustomTool(toolName) && mode === "edits") return false;
  if (mode === "edits") return EDIT_TOOLS.has(toolName);
  return false;
}

/** Tool-name tier, for explaining a decision in the UI. */
export function approvalTier(toolName: string): "edit" | "exec" {
  if (isMcpTool(toolName)) return "exec";
  return EDIT_TOOLS.has(toolName) ? "edit" : EXEC_TOOLS.has(toolName) ? "exec" : "exec";
}
