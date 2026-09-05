import { summarizeInput } from "../lib/approvalQueue";
import { withAutoVerify } from "../lib/autoVerify";
import { buildOrchestratorTools } from "../lib/orchestrator";
import { buildPolicyTools } from "./policyTools";
import { buildProcessTools } from "./process";
import {
  POST_EXECUTE_CONFIRM_TOOLS,
  withPostExecuteConfirm,
} from "../lib/postExecuteConfirm";
import { buildSkillRegistryTools } from "../lib/skillRegistry";
import { useApprovalQueue } from "../store/approvalQueueStore";
import { buildManagedAgentTools } from "./agent";
import { buildBrowserTools } from "./browser";
import { buildCodeSearchTools } from "./codeSearch";
import { buildDevServerTools } from "./devServer";
import { buildEditTools } from "./edit";
import { buildElicitationTools } from "./elicitation";
import { buildFetchTools } from "./fetch";
import { buildFileOpsTools } from "./fileops";
import { buildForwardTools } from "./forward";
import { buildFsTools } from "./fs";
import { buildGitTools } from "./git";
import { buildGithubTools } from "./github";
import { buildHarnessTools } from "./harness";
import { buildImageTools } from "./image";
import { buildInvariantTools } from "./invariant";
import { buildLspTools } from "./lsp";
import { buildMemoryTools } from "./memory";
import { buildPdfTools } from "./pdf";
import { buildPtyDriverTools } from "./ptyDriver";
import { buildReplaceTools } from "./replace";
import { buildReviewTools } from "./review";
import { buildSearchTools } from "./search";
import { buildShellTools } from "./shell";
import { buildSkillTools } from "./skills";
import { buildSqlTools } from "./sql";
import { buildSubagentTools } from "./subagent";
import { buildSystemTools } from "./system";
import { buildTerminalTools } from "./terminal";
import { buildTestLoopTools } from "./testLoopTools";
import { buildTodoTools } from "./todo";
import { buildVerifyTools } from "./verify";
import { buildWebSearchTools } from "./webSearch";
import { buildWorkflowTools } from "./workflow";
import { buildWorktreeTools } from "./worktree";
import { tool } from "ai";
import { z } from "zod";

export { resolvePath, type ToolContext } from "./context";

/**
 * Wrap a tool's execute function with lifecycle hooks.
 *
 * PreToolUse fires before the real execute; PostToolUse fires after. Both
 * are fire-and-forget: a hook failure must not change the tool result.
 */
function withHooks<
  T extends {
    execute: (
      args: Record<string, unknown>,
      options: { toolCallId?: string },
    ) => Promise<unknown>;
  },
>(
  name: string,
  tool: T,
  ctx: {
    firePreToolHook?: (
      toolName: string,
      args: Record<string, unknown>,
    ) => Promise<void>;
    firePostToolHook?: (
      toolName: string,
      args: Record<string, unknown>,
      result: unknown,
    ) => Promise<void>;
  },
): T {
  const original = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (
      args: Record<string, unknown>,
      options: { toolCallId?: string },
    ) => {
      if (ctx.firePreToolHook) {
        await ctx.firePreToolHook(name, args).catch(() => {});
      }
      const result = await original(args, options);
      if (ctx.firePostToolHook) {
        await ctx.firePostToolHook(name, args, result).catch(() => {});
      }
      return result;
    },
  };
}

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
  return dispatchRegisteredTool(currentToolRegistry, name, args);
}

async function dispatchRegisteredTool(
  registry: Record<string, unknown>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = registry[name];
  if (!tool) {
    return {
      error: `unknown tool "${name}". Available: ${Object.keys(registry).join(", ")}`,
    };
  }
  if ((tool as { needsApproval?: unknown }).needsApproval === true) {
    const decision = await useApprovalQueue.getState().request({
      requester: "workflow",
      toolName: name,
      summary: summarizeInput(args),
    });
    if (decision === "deny") {
      return { error: `workflow action "${name}" was denied by the user` };
    }
  }
  const callId = `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    return await (
      tool as {
        execute: (
          args: Record<string, unknown>,
          options: { toolCallId?: string },
        ) => Promise<unknown>;
      }
    ).execute(args, {
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
 *    `run_command`) require explicit user approval - the AI SDK pauses on
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
/**
 * @param subagentDepth Nesting depth of the agent this toolset is built for.
 *   0 = the main agent. A subagent at depth N receives spawn tools that spawn
 *   depth N+1 children; at `MAX_SUBAGENT_DEPTH` the spawn tools are omitted so
 *   recursion cannot exceed the cap (BatikCode parity).
 */
export function buildTools(
  ctx: import("./context").ToolContext,
  subagentDepth = 0,
) {
  // A workflow can spawn a subagent, and that subagent builds another toolset.
  // Keep workflow steps bound to this run's completed snapshot so they cannot
  // fall through the mutable module-level registry into the child's context.
  let dispatchForThisRun = dispatchTool;
  const workflowTools = buildWorkflowTools(ctx, (name, args) =>
    dispatchForThisRun(name, args),
  );
  const base = {
    ...buildFsTools(ctx),
    ...buildFileOpsTools(ctx),
    ...buildFetchTools(),
    ...buildForwardTools(ctx),
    ...buildReplaceTools(ctx),
    ...buildEditTools(ctx),
    ...buildSearchTools(ctx),
    ...buildShellTools(ctx),
    ...buildSubagentTools(ctx, subagentDepth),
    ...buildTerminalTools(ctx),
    ...buildTodoTools(ctx),
    ...buildMemoryTools(ctx),
    ...buildElicitationTools(),
    ...buildManagedAgentTools(ctx),
    ...buildVerifyTools(ctx),
    ...buildGitTools(ctx),
    ...buildHarnessTools(ctx),
    ...buildReviewTools(ctx),
    ...workflowTools,
    ...buildPolicyTools(),
    ...buildSkillRegistryTools(),
    ...buildGithubTools(ctx),
    ...buildCodeSearchTools(ctx),
    ...buildDevServerTools(ctx),
    ...buildLspTools(ctx),
    ...buildWorktreeTools(ctx),
    ...buildInvariantTools(ctx),
    ...buildTestLoopTools(ctx),
    ...buildPtyDriverTools(ctx),
    ...buildOrchestratorTools(ctx),
    ...buildBrowserTools(ctx),
    ...buildSqlTools(),
    ...buildWebSearchTools(),
    ...buildPdfTools(ctx),
    ...buildImageTools(ctx),
    ...buildSystemTools(),
    ...buildProcessTools(ctx),
    unknown_tool_fallback: tool({
      description:
        "Internal fallback for unrecognized tool names. Informs the model that the requested tool does not exist.",
      inputSchema: z.object({
        requested_tool: z.string(),
        provided_input: z.string().optional(),
      }),
      execute: async ({ requested_tool }) => {
        const available = [
          "read_file",
          "write_file",
          "edit",
          "multi_edit",
          "create_directory",
          "list_directory",
          "bash_run",
          "bash_background",
          "grep",
          "glob",
          "fetch",
          "run_subagent",
          "run_subagents",
          "todo_write",
        ];
        return {
          error: `Tool "${requested_tool}" does not exist in this environment. Available tools: ${available.join(", ")}. Please use one of these valid tools instead.`,
        };
      },
    }),
  } as const;

  // Store a reference so the workflow / orchestrator engines can dispatch
  // JSON-defined steps to the real tool implementations.
  currentToolRegistry = base as unknown as Record<string, unknown>;

  // Wrap every tool with lifecycle hooks. The wrapper is transparent: it
  // fires PreToolUse before the real execute and PostToolUse after, and
  // swallows any hook failure so a broken hook never changes the result.
  // `wrappedBase` re-casts to `typeof base` so the tool set keeps its precise
  // per-tool type: streamText infers a specific ToolSet from `tools`, and a
  // lossy `Record<string, unknown>` would break its toolChoice/prepareStep
  // type-checking.
  const wrapped: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(base)) {
    let wrappedTool = withHooks(
      name,
      tool as unknown as {
        execute: (
          args: Record<string, unknown>,
          options: { toolCallId?: string },
        ) => Promise<unknown>;
      },
      {
        firePreToolHook: ctx.firePreToolHook,
        firePostToolHook: ctx.firePostToolHook,
      },
    ) as unknown;
    // Post-execution confirmation (BatikCode parity): when the preference is
    // on, mutating tools pause after a successful run and ask the user to
    // Keep or Revert the change before the agent continues.
    if (POST_EXECUTE_CONFIRM_TOOLS.has(name)) {
      wrappedTool = withPostExecuteConfirm(
        name,
        wrappedTool as {
          execute: (
            args: Record<string, unknown>,
            options: { toolCallId?: string; abortSignal?: AbortSignal },
          ) => Promise<unknown>;
        },
        ctx,
      ) as unknown;
    }
    // Automatic verification (full-agentic loop): when the preference is on, a
    // successful edit folds a best-effort format + lint outcome into the tool
    // result so the model sees whether the change is valid.
    wrappedTool = withAutoVerify(
      name,
      wrappedTool as {
        execute: (
          args: Record<string, unknown>,
          options: { toolCallId?: string; abortSignal?: AbortSignal },
        ) => Promise<unknown>;
      },
      ctx,
    ) as unknown;
    wrapped[name] = wrappedTool;
  }
  const wrappedBase = wrapped as typeof base;
  currentToolRegistry = wrappedBase as unknown as Record<string, unknown>;
  dispatchForThisRun = (name, args) =>
    dispatchRegisteredTool(
      wrappedBase as unknown as Record<string, unknown>,
      name,
      args,
    );

  // Skill tools last, and told what the others are called: the dependency
  // checker compares a skill against the real registry rather than a list kept
  // by hand, so adding or renaming a tool later cannot leave the check stale.
  return {
    ...wrappedBase,
    ...buildSkillTools(ctx, Object.keys(wrappedBase)),
  } as const;
}

export type ChatTools = ReturnType<typeof buildTools>;
