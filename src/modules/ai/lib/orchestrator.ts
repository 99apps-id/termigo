import { tool } from "ai";
import { z } from "zod";
import { useChatStore } from "../store/chatStore";
import { native } from "./native";
import { runSubagent } from "../agents/runSubagent";
import type { SubagentType } from "../agents/registry";
import type { ToolContext } from "../tools/context";

// ─── Types ────────────────────────────────────────────────────────────────

export type OrchestrationStep = {
  id: string;
  type: SubagentType;
  prompt: string;
  description?: string;
  depends_on?: string[];
  parallel?: boolean;
};

export type OrchestrationPipeline = {
  id: string;
  name: string;
  description?: string;
  steps: OrchestrationStep[];
};

export type OrchestrationResult = {
  pipelineId: string;
  completed: string[];
  failed: string[];
  skipped: string[];
  results: Record<string, unknown>;
  stoppedAt?: string;
};

// ─── Storage ──────────────────────────────────────────────────────────────

const PIPELINES_DIR = ".termigo/pipelines";

async function pipelineRoot(): Promise<string | null> {
  const cwd = useChatStore.getState().live.getWorkspaceRoot() ?? ".";
  return `${cwd.replace(/\/$/, "")}/${PIPELINES_DIR}`;
}

export async function loadPipeline(id: string): Promise<OrchestrationPipeline | null> {
  const root = await pipelineRoot();
  if (!root) return null;

  try {
    const file = `${root}/${id}.json`;
    const r = await native.readFile(file);
    if (r.kind !== "text" || !r.content) return null;
    const parsed = JSON.parse(r.content);
    return {
      id: parsed.id ?? id,
      name: parsed.name ?? id,
      description: parsed.description,
      steps: parsed.steps ?? [],
    };
  } catch {
    return null;
  }
}

export async function listPipelines(): Promise<OrchestrationPipeline[]> {
  const root = await pipelineRoot();
  if (!root) return [];

  try {
    const globResult = await native.glob({ pattern: "*.json", root });
    const pipelines: OrchestrationPipeline[] = [];

    for (const hit of globResult.hits) {
      try {
        const id = hit.rel.replace(/\.json$/, "");
        const pipeline = await loadPipeline(id);
        if (pipeline) pipelines.push(pipeline);
      } catch {
        // skip invalid pipelines
      }
    }

    return pipelines.sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

// ─── Execution ─────────────────────────────────────────────────────────────

type StepResult = { ok: boolean; output?: unknown; error?: string };

async function executeStep(
  step: OrchestrationStep,
  toolContext: ToolContext,
): Promise<StepResult> {
  const { apiKeys, selectedModelId } = useChatStore.getState();
  if (!apiKeys || !selectedModelId) {
    return { ok: false, error: "no provider key/model configured" };
  }

  try {
    const r = await runSubagent({
      type: step.type,
      prompt: step.prompt,
      keys: apiKeys,
      modelId: selectedModelId,
      toolContext,
      requester: step.description ?? step.type,
    });
    return { ok: true, output: r.summary };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function runPipeline(
  pipeline: OrchestrationPipeline,
  toolContext: ToolContext,
  initialContext: Record<string, unknown> = {},
): Promise<OrchestrationResult> {
  const completed = new Set<string>();
  const failed = new Set<string>();
  const skipped = new Set<string>();
  const results: Record<string, unknown> = { ...initialContext };
  const pending = new Set(pipeline.steps.map((s) => s.id));
  let stoppedAt: string | undefined;

  const deps = new Map<string, string[]>();
  for (const step of pipeline.steps) {
    deps.set(step.id, step.depends_on ?? []);
  }

  while (pending.size > 0) {
    const ready: OrchestrationStep[] = [];
    for (const stepId of pending) {
      const stepDeps = deps.get(stepId) ?? [];
      const allDepsMet = stepDeps.every((dep) => completed.has(dep));
      const hasFailedDep = stepDeps.some((dep) => failed.has(dep) || skipped.has(dep));

      if (hasFailedDep) {
        skipped.add(stepId);
        pending.delete(stepId);
      } else if (allDepsMet) {
        const step = pipeline.steps.find((s) => s.id === stepId);
        if (step) ready.push(step);
      }
    }

    if (ready.length === 0) {
      for (const stepId of pending) {
        skipped.add(stepId);
      }
      break;
    }

    const parallelSteps = ready.filter((s) => s.parallel);
    const sequentialSteps = ready.filter((s) => !s.parallel);

    if (parallelSteps.length > 0) {
      const stepPromises = parallelSteps.map(async (step) => {
        const result = await executeStep(step, toolContext);
        return { step, result };
      });

      const stepResults = await Promise.all(stepPromises);

      for (const { step, result } of stepResults) {
        pending.delete(step.id);
        if (result.ok) {
          completed.add(step.id);
          results[step.id] = result.output;
        } else {
          failed.add(step.id);
          results[step.id] = { error: result.error };
        }
      }
    }

    for (const step of sequentialSteps) {
      pending.delete(step.id);
      const result = await executeStep(step, toolContext);

      if (result.ok) {
        completed.add(step.id);
        results[step.id] = result.output;
      } else {
        failed.add(step.id);
        results[step.id] = { error: result.error };
        stoppedAt = step.id;
        break;
      }
    }
  }

  return {
    pipelineId: pipeline.id,
    completed: Array.from(completed),
    failed: Array.from(failed),
    skipped: Array.from(skipped),
    results,
    stoppedAt,
  };
}

// ─── User-facing entry point ───────────────────────────────────────────────

/**
 * Kick off a named pipeline (`/pipeline <name>`). Loads the pipeline from
 * `.termigo/pipelines/<name>.json` to validate it, then sends a prompt that
 * asks the agent to run it with the `orchestrate` tool — so steps execute as
 * sub-agents through the normal approval flow and their progress is visible in
 * the chat transcript, exactly like a pipeline started by hand.
 */
export async function runPipelineByName(
  name: string,
): Promise<{ ok: boolean; message?: string }> {
  const trimmed = name.trim();
  if (!trimmed) {
    return { ok: false, message: "pipeline name is required" };
  }
  const pipeline = await loadPipeline(trimmed);
  if (!pipeline) {
    return {
      ok: false,
      message: `Pipeline "${trimmed}" not found in .termigo/pipelines/`,
    };
  }
  const stepIds = pipeline.steps.map((s) => s.id).join(", ");
  const { sendMessage } = await import("../store/chatRuntime");
  const prompt = `Run the orchestration pipeline "${trimmed}" (${pipeline.steps.length} steps: ${stepIds}) using the orchestrate tool with the current workspace context. Execute every step in dependency order, wait for approvals, and report the final OrchestrationResult.`;
  const ok = await sendMessage(prompt);
  if (!ok) {
    return {
      ok: false,
      message:
        "no active chat session; open a workspace and pick a model first",
    };
  }
  return { ok: true };
}

// ─── Agent tools ───────────────────────────────────────────────────────────

export function buildOrchestratorTools(ctx: ToolContext) {
  return {
    orchestrate: tool({
      description:
        "Execute a multi-agent orchestration pipeline. Pipelines are defined in `.termigo/pipelines/<id>.json` and consist of ordered steps with dependencies. Use this for complex tasks that require multiple agents working together.",
      inputSchema: z.object({
        pipeline_id: z.string().describe("Pipeline ID to execute"),
        context: z.record(z.string(), z.unknown()).optional().describe("Initial context for the pipeline"),
      }),
      execute: async ({ pipeline_id, context }) => {
        const pipeline = await loadPipeline(pipeline_id);
        if (!pipeline) {
          return { error: `Pipeline "${pipeline_id}" not found` };
        }
        const result = await runPipeline(pipeline, ctx, context ?? {});
        return result;
      },
    }),

    list_pipelines: tool({
      description:
        "List available orchestration pipelines. Returns pipeline IDs, names, and descriptions.",
      inputSchema: z.object({}),
      execute: async () => {
        const pipelines = await listPipelines();
        return {
          pipelines: pipelines.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            steps: p.steps.length,
          })),
        };
      },
    }),
  };
}
