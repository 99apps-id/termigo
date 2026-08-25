import { buildManagedAgentTools } from "./agent";
import { buildEditTools } from "./edit";
import { buildFetchTools } from "./fetch";
import { buildForwardTools } from "./forward";
import { buildFileOpsTools } from "./fileops";
import { buildReplaceTools } from "./replace";
import { buildSkillTools } from "./skills";
import { buildFsTools } from "./fs";
import { buildSearchTools } from "./search";
import { buildShellTools } from "./shell";
import { buildSubagentTools } from "./subagent";
import { buildTerminalTools } from "./terminal";
import { buildMemoryTools } from "./memory";
import { buildTodoTools } from "./todo";
import { buildVerifyTools } from "./verify";
import { buildGitTools } from "./git";
import { buildHarnessTools } from "./harness";
import { buildReviewTools } from "./review";
import { buildWorkflowTools } from "./workflow";
import { buildPolicyTools } from "../lib/policyEngine";
import { buildSkillRegistryTools } from "../lib/skillRegistry";
import { buildGithubTools } from "./github";
import { buildCodeSearchTools } from "./codeSearch";
import { buildLspTools } from "./lsp";
import { buildWorktreeTools } from "./worktree";
import { buildInvariantTools } from "./invariant";
import { buildTestLoopTools } from "./testLoopTools";
import { buildPtyDriverTools } from "./ptyDriver";
import { buildOrchestratorTools } from "../lib/orchestrator";

export { resolvePath, type ToolContext } from "./context";

/**
 * The currently-registered tool map, set by `buildTools` each time the agent
 * builds its tool set. The workflow and orchestrator engines use this to
 * dispatch JSON-defined steps to the actual tool implementations.
 */
let currentToolRegistry: Record<string, unknown> = {};

/**
 * Reset the registry to empty. Used by tests so one suite's `buildTools`
 * call cannot leak into the next.
 */
export function resetToolRegistry(): void {
  currentToolRegistry = {};
}

/**
 * Look up and invoke a registered tool by name. This is the bridge that lets
 * JSON-defined workflow steps and orchestration pipelines call any tool the
 * agent can call.
 *
 * The registry is set by `buildTools` at the start of each agent run, so a
 * step always dispatches to the tool set the current run was built with.
 */
export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = currentToolRegistry[name];
  if (!tool) {
    return {
      error: `unknown tool "${name}". Available: ${Object.keys(currentToolRegistry).join(", ")}`,
    };
  }
  const callId = `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    return await (tool as { execute: (args: Record<string, unknown>, options: { toolCallId?: string }) => Promise<unknown> }).execute(args, {
      toolCallId: callId,
    });
  } catch (e) {
    return { error: `tool "${name}" threw: ${String(e)}` };
  }
}

/**
 * AI tool definitions.
 *
 * Approval policy:
 *  - Read-only tools (`read_file`, `list_directory`, `grep`, `glob`)
 *    auto-execute, but go through the security guard which refuses obvious
 *    secret paths (.env*, .ssh/, credentials, etc.).
 *  - Mutating tools (`write_file`, `edit`, `multi_edit`, `create_directory`,
 *    `run_command`) require explicit user approval — the AI SDK pauses on
 *    tool-call and surfaces a `tool-approval-request` part that the UI
 *    renders as a confirmation card.
 *  - `edit` / `multi_edit` additionally enforce a read-before-edit invariant
 *    (the model must have called read_file on the path earlier in the
 *    session).
 *
 * The model sees absolute paths only after they are resolved against the
 * active terminal's cwd (provided via `getCwd`); it should not invent paths
 * outside that.
 */
export function buildTools(ctx: import("./context").ToolContext) {
  const base = {
    ...buildFsTools(ctx),
    ...buildFileOpsTools(ctx),
    ...buildFetchTools(),
    ...buildForwardTools(ctx),
    ...buildReplaceTools(ctx),
    ...buildEditTools(ctx),
    ...buildSearchTools(ctx),
    ...buildShellTools(ctx),
    ...buildSubagentTools(ctx),
    ...buildTerminalTools(ctx),
    ...buildTodoTools(ctx),
    ...buildMemoryTools(ctx),
    ...buildManagedAgentTools(ctx),
    ...buildVerifyTools(ctx),
    ...buildGitTools(ctx),
    ...buildHarnessTools(ctx),
    ...buildReviewTools(ctx),
    ...buildWorkflowTools(ctx),
    ...buildPolicyTools(),
    ...buildSkillRegistryTools(),
    ...buildGithubTools(ctx),
    ...buildCodeSearchTools(ctx),
    ...buildLspTools(ctx),
    ...buildWorktreeTools(ctx),
    ...buildInvariantTools(ctx),
    ...buildTestLoopTools(ctx),
    ...buildPtyDriverTools(ctx),
    ...buildOrchestratorTools(ctx),
  } as const;

  // Store a reference so the workflow / orchestrator engines can dispatch
  // JSON-defined steps to the real tool implementations.
  currentToolRegistry = base as unknown as Record<string, unknown>;

  // Skill tools last, and told what the others are called: the dependency
  // checker compares a skill against the real registry rather than a list kept
  // by hand, so adding or renaming a tool later cannot leave the check stale.
  return { ...base, ...buildSkillTools(ctx, Object.keys(base)) } as const;
}

export type ChatTools = ReturnType<typeof buildTools>;