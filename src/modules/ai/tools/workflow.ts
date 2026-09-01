import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { useChatStore } from "../store/chatStore";
import type { ToolContext } from "./context";
import { dispatchTool } from "./tools";

/**
 * Agentic Workflow Engine
 *
 * Lets users define reusable multi-step workflows as JSON files under
 * `.termigo/workflows/`. Each workflow is a DAG of tool calls with explicit
 * dependencies, so the agent can execute complex sequences like:
 * "review -> test -> format -> commit" in one command.
 *
 * Workflows are versioned, shareable, and can be invoked by name from the
 * agent or from the CLI.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export type WorkflowStep = {
  /** Unique step id within the workflow. */
  id: string;
  /** Tool name to invoke. Must be available in the current tool context. */
  tool: string;
  /** Input schema for the tool. */
  params?: Record<string, unknown>;
  /** Step ids that must complete before this one runs. */
  depends_on?: string[];
  /** If true, failure of this step does not stop the workflow. */
  continue_on_error?: boolean;
  /** Human-readable description for the agent to read. */
  description?: string;
};

export type WorkflowDefinition = {
  /** Workflow name, used as the invocation handle. */
  name: string;
  /** Short description shown in listings. */
  description?: string;
  /** Tool-call steps executed in dependency order. */
  steps: WorkflowStep[];
  /** Maximum runtime in seconds for the whole workflow. */
  timeoutSeconds?: number;
};

export type WorkflowRunResult = {
  workflowName: string;
  completed: string[];
  failed: string[];
  skipped: string[];
  results: Record<string, unknown>;
  stoppedAt?: string;
  error?: string;
};

// ─── Storage ──────────────────────────────────────────────────────────────

const WORKFLOW_DIR = ".termigo/workflows";

/**
 * Resolve the workflow directory for the current workspace.
 */
async function workflowRoot(): Promise<string | null> {
  const cwd = useChatStore.getState().live.getWorkspaceRoot() ?? ".";
  return `${cwd.replace(/\/$/, "")}/${WORKFLOW_DIR}`;
}

/**
 * Load a workflow definition by name from `.termigo/workflows/<name>.json`.
 */
export async function loadWorkflow(
  name: string,
): Promise<WorkflowDefinition | null> {
  const root = await workflowRoot();
  if (!root) return null;
  try {
    const r = await native.readFile(`${root}/${name}.json`);
    if (r.kind !== "text" || !r.content) return null;
    return JSON.parse(r.content) as WorkflowDefinition;
  } catch {
    return null;
  }
}

/**
 * List all workflow names available in the workspace.
 */
export async function listWorkflowNames(): Promise<string[]> {
  const root = await workflowRoot();
  if (!root) return [];
  try {
    const result = await native.glob({ pattern: "*.json", root });
    return result.hits
      .map(
        (hit) =>
          hit.path
            .split("/")
            .pop()
            ?.replace(/\.json$/, "") ?? "",
      )
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Execution ─────────────────────────────────────────────────────────────

type StepResult = { ok: boolean; output?: unknown; error?: string };
type ToolDispatcher = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

function isErrorOutput(output: unknown): output is { error: string } {
  return (
    output !== null &&
    typeof output === "object" &&
    typeof (output as { error?: unknown }).error === "string"
  );
}

/**
 * Execute a single workflow step by dispatching to the live tool registry.
 *
 * Steps with a `tool` field are forwarded to `dispatchTool`, which looks up
 * the tool by name and runs its `execute` function. Steps without a tool
 * fall through to a seeded result (used by the orchestrator's depends_on
 * plumbing).
 */
async function executeStep(
  step: WorkflowStep,
  context: Record<string, unknown>,
  dispatch: ToolDispatcher,
): Promise<StepResult> {
  const seeded = context[step.id];
  if (
    seeded &&
    typeof seeded === "object" &&
    "ok" in (seeded as Record<string, unknown>)
  ) {
    return seeded as StepResult;
  }

  if (step.tool) {
    const result = await dispatch(step.tool, step.params ?? {});
    if (isErrorOutput(result)) return { ok: false, error: result.error };
    return { ok: true, output: result };
  }

  return {
    ok: false,
    error: `step "${step.id}" has no tool to invoke`,
  };
}

/**
 * Run a workflow definition to completion, respecting dependencies and
 * `continue_on_error`.
 */
export async function runWorkflow(
  workflow: WorkflowDefinition,
  initialContext: Record<string, unknown> = {},
  dispatch: ToolDispatcher = dispatchTool,
): Promise<WorkflowRunResult> {
  const completed = new Set<string>();
  const failed = new Set<string>();
  const skipped = new Set<string>();
  const results: Record<string, unknown> = { ...initialContext };
  const pending = new Set(workflow.steps.map((s) => s.id));
  let stoppedAt: string | undefined;

  while (pending.size > 0) {
    const ready = workflow.steps.filter((s) => {
      if (!pending.has(s.id)) return false;
      const deps = s.depends_on ?? [];
      return deps.every((d) => completed.has(d) || failed.has(d));
    });

    if (ready.length === 0) {
      stoppedAt = Array.from(pending)[0];
      break;
    }

    for (const step of ready) {
      pending.delete(step.id);
      const shouldSkip =
        (step.depends_on ?? []).some((d) => failed.has(d)) &&
        !step.continue_on_error;

      if (shouldSkip) {
        skipped.add(step.id);
        continue;
      }

      const result = await executeStep(step, results, dispatch);
      results[step.id] = result.output;

      if (result.ok) {
        completed.add(step.id);
      } else {
        failed.add(step.id);
        if (!step.continue_on_error) {
          stoppedAt = step.id;
          for (const id of pending) skipped.add(id);
          pending.clear();
          break;
        }
      }
    }
  }

  return {
    workflowName: workflow.name,
    completed: Array.from(completed),
    failed: Array.from(failed),
    skipped: Array.from(skipped),
    results,
    stoppedAt,
  };
}

// ─── Agent tools ───────────────────────────────────────────────────────────

export function buildWorkflowTools(
  _ctx: ToolContext,
  dispatch?: ToolDispatcher,
) {
  return {
    list_workflows: tool({
      description:
        "List available agentic workflows defined in `.termigo/workflows/`. Returns workflow names and descriptions.",
      inputSchema: z.object({}),
      execute: async () => {
        const names = await listWorkflowNames();
        const workflows = await Promise.all(
          names.map(async (name) => {
            const def = await loadWorkflow(name);
            return { name, description: def?.description ?? null };
          }),
        );
        return { workflows };
      },
    }),

    run_workflow: tool({
      description:
        "Run a named agentic workflow from `.termigo/workflows/<name>.json`. Workflows are reusable multi-step automation pipelines (review -> test -> format -> commit). Use this when the task matches a defined workflow better than ad-hoc tool calls.",
      inputSchema: z.object({
        name: z.string().describe("Workflow name without `.json` extension."),
        context: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Initial context passed to workflow steps."),
      }),
      execute: async ({ name, context }) => {
        const workflow = await loadWorkflow(name);
        if (!workflow) {
          return {
            error: `workflow "${name}" not found in .termigo/workflows/`,
          };
        }
        const result = await runWorkflow(workflow, context ?? {}, dispatch);
        return result;
      },
    }),
  };
}
