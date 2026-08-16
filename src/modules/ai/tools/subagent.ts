import { tool } from "ai";
import { z } from "zod";
import { runSubagent } from "../agents/runSubagent";
import { SUBAGENTS, type SubagentType } from "../agents/registry";
import { useChatStore } from "../store/chatStore";
import {
  cascadeSkip,
  planSubagentBatch,
  readyTasks,
  type TaskState,
} from "../lib/subagentSchedule";
import type { ToolContext } from "./context";

const TYPE_KEYS = Object.keys(SUBAGENTS) as [SubagentType, ...SubagentType[]];

/**
 * Caps on a batch, so a model that asks for forty explorers gets a working
 * fan-out rather than forty concurrent requests and a rate limit.
 *
 * Tasks past the cap are dropped and reported. Silently running fewer than
 * asked would leave the model synthesising from summaries it never got.
 */
const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;

type BatchResult = {
  index: number;
  type: SubagentType;
  description?: string;
  summary?: string;
  error?: string;
  skipped?: string;
  stepCount?: number;
  durationMs?: number;
};

export function buildSubagentTools(ctx: ToolContext) {
  return {
    run_subagent: tool({
      description: `Spawn an isolated subagent with its own restricted toolset and a fresh message history. Use when you need to delegate a self-contained read-only investigation (large search, code review, security audit) without polluting your own context. The subagent returns a single text summary; pick a 'type' that matches its job.

Types:
${TYPE_KEYS.map((k) => `- ${k}: ${SUBAGENTS[k].description}`).join("\n")}

Auto-executes (no approval) — subagents are read-only by design.`,
      inputSchema: z.object({
        type: z.enum(TYPE_KEYS),
        prompt: z
          .string()
          .describe(
            "Self-contained instruction. The subagent has no memory of prior conversation — include all relevant context.",
          ),
        description: z
          .string()
          .optional()
          .describe("Short label shown in the chat UI for the spawn card."),
      }),
      execute: async ({ type, prompt, description }, opts) => {
        const { apiKeys, selectedModelId, patchAgentMeta } =
          useChatStore.getState();
        try {
          const r = await runSubagent({
            type,
            prompt,
            keys: apiKeys,
            modelId: selectedModelId,
            toolContext: ctx,
            requester: description ?? type,
            abortSignal: opts?.abortSignal,
            onStep: (label) => patchAgentMeta({ step: label }),
          });
          return {
            type,
            description,
            summary: r.summary,
            stepCount: r.stepCount,
            durationMs: r.durationMs,
          };
        } catch (e) {
          return { error: String(e), type };
        }
      },
    }),

    run_subagents: tool({
      description: `Spawn SEVERAL isolated subagents in one call and get all their summaries back together. Prefer this over repeating run_subagent: independent tasks run at the same time instead of one after another.

Two patterns, combinable:
- Fan-out: independent tasks run concurrently (bounded by max_concurrency, cap ${MAX_CONCURRENCY}).
- Scatter then gather: a task's \`depends_on\` lists the tasks it waits for, and it receives their summaries as context. e.g. tasks 0,1,2 explore three modules; task 3 (depends_on [0,1,2]) synthesises from them.

Each subagent has a fresh history and no memory of this conversation, so every prompt must stand alone — dependency summaries are injected for you. A task whose dependency fails is skipped rather than run without it. Cycles and self-references are rejected.

At most ${MAX_TASKS} tasks per call; extras are dropped and reported in \`note\`, never silently. Read \`note\` before trusting the results.

Use this for anything spanning more than one file — studying, exploring, reviewing or auditing a codebase — rather than reading files one at a time.

Auto-executes: subagents are read-only.`,
      inputSchema: z.object({
        tasks: z
          .array(
            z.object({
              type: z.enum(TYPE_KEYS),
              prompt: z
                .string()
                .describe(
                  "Self-contained instruction. The subagent has no memory of this conversation.",
                ),
              description: z
                .string()
                .optional()
                .describe("Short label shown in the chat UI."),
              depends_on: z
                .array(z.number().int())
                .optional()
                .describe(
                  "0-based indices of other tasks to wait for. Their summaries arrive as context.",
                ),
            }),
          )
          .min(1)
          .describe("The subagents to run."),
        max_concurrency: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            `How many may run at once. Defaults to ${MAX_CONCURRENCY}, which is also the cap.`,
          ),
      }),
      execute: async ({ tasks, max_concurrency }, opts) => {
        const batchSignal = opts?.abortSignal;
        const notes: string[] = [];
        let batch = tasks;
        if (batch.length > MAX_TASKS) {
          notes.push(
            `${batch.length - MAX_TASKS} task(s) past the cap of ${MAX_TASKS} were dropped.`,
          );
          batch = batch.slice(0, MAX_TASKS);
        }
        const concurrency = Math.min(
          max_concurrency ?? MAX_CONCURRENCY,
          MAX_CONCURRENCY,
        );

        const plan = planSubagentBatch(batch);
        for (const e of plan.droppedEdges) {
          notes.push(
            `Task #${e.index} asked to depend on #${e.target}, which does not exist; it ran without that context.`,
          );
        }

        const results: BatchResult[] = batch.map((t, i) => ({
          index: i,
          type: t.type,
          description: t.description,
        }));
        const state: TaskState[] = batch.map(() => ({
          settled: false,
          bad: false,
          running: false,
        }));

        // Settle the unrunnable before scheduling, then cascade, so nothing
        // downstream of a cycle is left waiting on a task that will never run.
        for (const problem of plan.unrunnable) {
          state[problem.index] = {
            settled: true,
            bad: true,
            running: false,
          };
          results[problem.index].skipped = problem.reason;
        }
        for (const problem of plan.unrunnable) {
          for (const s of cascadeSkip(plan.deps, state, problem.index)) {
            results[s.index].skipped ??= s.reason;
          }
        }

        const { apiKeys, selectedModelId, patchAgentMeta } =
          useChatStore.getState();

        const runOne = async (i: number): Promise<void> => {
          const task = batch[i];
          // Dependency summaries are prepended rather than left to the model
          // to fetch: the subagent has no history and no way to ask.
          const context = plan.deps[i]
            .map((d) => results[d].summary)
            .filter((s): s is string => !!s)
            .map((s, n) => `## Result of dependency ${n + 1}\n${s}`)
            .join("\n\n");
          const prompt = context
            ? `${context}\n\n---\n\n${task.prompt}`
            : task.prompt;
          try {
            const r = await runSubagent({
              type: task.type,
              prompt,
              keys: apiKeys,
              modelId: selectedModelId,
              toolContext: ctx,
              // Numbered, because several run at once and the approval queue
              // is unreadable if every row says "builder".
              requester: `${task.description ?? task.type} #${i + 1}`,
              abortSignal: batchSignal,
              onStep: (label) =>
                patchAgentMeta({
                  step: `${task.description ?? task.type}: ${label}`,
                }),
            });
            results[i].summary = r.summary;
            results[i].stepCount = r.stepCount;
            results[i].durationMs = r.durationMs;
            state[i] = { settled: true, bad: false, running: false };
          } catch (e) {
            results[i].error = String(e);
            state[i] = { settled: true, bad: true, running: false };
            for (const s of cascadeSkip(plan.deps, state, i)) {
              results[s.index].skipped ??= s.reason;
            }
          }
        };

        // Launch every ready task, wait for the earliest to finish, launch
        // again. `Promise.race` rather than `all` so a slot frees the moment
        // one task ends instead of when the whole wave does.
        const inFlight = new Map<number, Promise<void>>();
        while (state.some((s) => !s.settled) || inFlight.size > 0) {
          for (const i of readyTasks(plan.deps, state, concurrency - inFlight.size)) {
            state[i].running = true;
            inFlight.set(
              i,
              runOne(i).finally(() => inFlight.delete(i)),
            );
          }
          if (inFlight.size === 0) break; // nothing running and nothing ready
          await Promise.race(inFlight.values());
        }

        const failedOrSkipped = results.filter(
          (r) => r.error || r.skipped,
        ).length;
        return {
          count: results.length,
          maxConcurrency: concurrency,
          ...(failedOrSkipped ? { failedOrSkipped } : {}),
          ...(notes.length ? { note: notes.join(" ") } : {}),
          results,
        };
      },
    }),
  } as const;
}
