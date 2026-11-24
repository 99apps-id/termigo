import { tool } from "ai";
import { z } from "zod";
import { computeNextDueAt, parseScheduleWhen } from "../lib/scheduler";
import { useChatStore } from "../store/chatStore";
import { useSessionDirectiveStore } from "../store/sessionDirectiveStore";
import type { ToolContext } from "./context";

function activeScope(ctx: ToolContext): {
  sessionId: string;
  workspaceRoot: string | null;
} {
  const sessionId = useChatStore.getState().activeSessionId ?? "default";
  const workspaceRoot =
    useChatStore.getState().live.getWorkspaceRoot() ?? ctx.getCwd() ?? null;
  return { sessionId, workspaceRoot };
}

export function buildCronTools(ctx: ToolContext) {
  return {
    cron_list: tool({
      description:
        "List all scheduled automation / cron jobs configured for the current workspace session.",
      inputSchema: z.object({}),
      execute: async () => {
        const { sessionId, workspaceRoot } = activeScope(ctx);
        const jobs = useSessionDirectiveStore
          .getState()
          .getSchedules(sessionId, workspaceRoot);
        return {
          ok: true,
          count: jobs.length,
          jobs: jobs.map((j) => ({
            id: j.id,
            when: j.when,
            prompt: j.prompt,
            enabled: j.enabled,
            nextDueAt: j.nextDueAt ? new Date(j.nextDueAt).toISOString() : null,
          })),
        };
      },
    }),

    cron_create: tool({
      description:
        "Create a recurring automation or cron job that runs a prompt automatically on schedule. Accepts standard 5-field cron expressions (e.g. '*/15 * * * *', '0 9 * * 1-5'), interval strings ('every 10m', 'every 2h'), or daily schedules ('daily at 09:00').",
      inputSchema: z.object({
        when: z
          .string()
          .min(1)
          .describe(
            "Schedule expression: 5-field cron ('0 9 * * *', '*/30 * * * *'), 'every <N>s|m|h', or 'daily at HH:MM'.",
          ),
        prompt: z
          .string()
          .min(1)
          .describe("The task/prompt the agent should run when the job fires."),
      }),
      execute: async ({ when, prompt }) => {
        const timing = parseScheduleWhen(when);
        const nextDueAt = computeNextDueAt(Date.now(), timing);
        if (nextDueAt === null) {
          return {
            ok: false,
            error:
              "Invalid schedule expression. Use a 5-field cron ('0 9 * * *', '*/15 * * * *'), 'every <N>s|m|h', or 'daily at HH:MM'.",
          };
        }
        const { sessionId, workspaceRoot } = activeScope(ctx);
        const store = useSessionDirectiveStore.getState();
        store.addSchedule(
          sessionId,
          workspaceRoot,
          when.trim(),
          prompt.trim(),
          {
            ...timing,
            nextDueAt,
          },
        );
        const jobs = store.getSchedules(sessionId, workspaceRoot);
        const created = jobs[jobs.length - 1];
        return {
          ok: true,
          id: created?.id ?? "",
          when: when.trim(),
          prompt: prompt.trim(),
          nextDueAt: new Date(nextDueAt).toISOString(),
        };
      },
    }),

    cron_toggle: tool({
      description:
        "Enable or disable an existing scheduled automation / cron job by its id.",
      inputSchema: z.object({
        id: z.string().min(1).describe("The schedule job id from cron_list."),
      }),
      execute: async ({ id }) => {
        const { sessionId, workspaceRoot } = activeScope(ctx);
        const store = useSessionDirectiveStore.getState();
        const before = store
          .getSchedules(sessionId, workspaceRoot)
          .find((j) => j.id === id);
        if (!before) {
          return { ok: false, error: `No cron job found with id '${id}'.` };
        }
        store.toggleSchedule(sessionId, workspaceRoot, id);
        return { ok: true, id, enabled: !before.enabled };
      },
    }),

    cron_delete: tool({
      description: "Delete a scheduled automation / cron job by its id.",
      inputSchema: z.object({
        id: z.string().min(1).describe("The schedule job id from cron_list."),
      }),
      execute: async ({ id }) => {
        const { sessionId, workspaceRoot } = activeScope(ctx);
        const store = useSessionDirectiveStore.getState();
        const exists = store
          .getSchedules(sessionId, workspaceRoot)
          .some((j) => j.id === id);
        if (!exists) {
          return { ok: false, error: `No cron job found with id '${id}'.` };
        }
        store.removeSchedule(sessionId, workspaceRoot, id);
        return { ok: true, id, deleted: true };
      },
    }),
  };
}
