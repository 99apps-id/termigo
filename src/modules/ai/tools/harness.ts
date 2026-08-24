import { tool } from "ai";
import { z } from "zod";
import { useChatStore } from "../store/chatStore";
import { usePlanStore } from "../store/planStore";
import type { ToolContext } from "./context";

/**
 * Harness self-awareness: a read-only view of the agent's own context and cost
 * footprint. The model cannot see its prompt size or token spend directly, so
 * a long task can balloon the context while it keeps reading. This lets it
 * choose to summarize, stop re-reading, or hand off before it is too late.
 */
export function buildHarnessTools(ctx: ToolContext) {
  return {
    context_report: tool({
      description:
        "Report your own context/cost footprint this session: how many files you have read, the token cost of the last request, how much of it was cache-hit, and the run round / step budget. Read-only, auto-executes. Use before a long task, or when a run feels like it is getting expensive, so you can decide to summarize instead of reading more files.",
      inputSchema: z.object({}),
      execute: async () => {
        const meta = useChatStore.getState().agentMeta;
        return {
          files_read_this_session: ctx.readCache.size,
          last_request_tokens: meta.lastInputTokens,
          last_cached_tokens: meta.lastCachedTokens,
          total_run_tokens: meta.tokens.inputTokens,
          run_round: meta.runRound,
          approvals_pending: meta.approvalsPending,
          stop_reason: meta.stopReason,
        };
      },
    }),

    plan_mode: tool({
      description:
        "Enable plan mode to make the agent queue ALL file edits for the user to review as one diff before applying — use for a large multi-file change. Disable it to apply edits directly (each still asks for approval). Auto-executes.",
      inputSchema: z.object({
        enabled: z.boolean().describe("Turn plan mode on (true) or off (false)."),
      }),
      execute: async ({ enabled }) => {
        if (enabled) {
          usePlanStore.getState().enable();
        } else {
          usePlanStore.getState().disable();
        }
        return {
          planMode: enabled,
          ...(enabled
            ? {
                note: "edits will now queue for review in one diff; call plan_mode(false) to resume direct edits",
              }
            : {}),
        };
      },
    }),
  } as const;
}
