import { tool } from "ai";
import { z } from "zod";
import { rememberFact } from "../lib/memory";
import type { ToolContext } from "./context";

export function buildMemoryTools(ctx: ToolContext) {
  return {
    remember: tool({
      description:
        "Record one durable fact or lesson about this project so future sessions start with it. " +
        "Use it for: mistakes/traps to avoid (start with '[GOTCHA]'), verified build/test commands, " +
        "conventions the user corrected you on, architectural decisions, paths that matter, and things never to run. " +
        "Do NOT use it for the current task, transient state, file contents you can re-read, " +
        "or unverified assumptions. For full multi-step procedures (like deployment or pentest routines), " +
        "use `create_skill` instead. One fact per call, written as a short standalone sentence. " +
        "Stored in .termigo/memory.md (or ~/.termigo/memory.md if scope is global), which the user can edit or delete. Asks for approval.",
      inputSchema: z.object({
        fact: z
          .string()
          .min(1)
          .describe(
            "A single durable fact or avoided mistake, phrased to stand alone. " +
              "Good: '[GOTCHA] Tests fail under npm; always use pnpm test.' or " +
              "'Internal imports must use the @/ path alias.' Bad: 'I fixed a bug.'",
          ),
        scope: z
          .enum(["project", "global"])
          .optional()
          .default("project")
          .describe(
            "Where to save this fact: 'project' saves to .termigo/memory.md for this workspace, " +
              "'global' saves to ~/.termigo/memory.md for all projects across this machine.",
          ),
      }),
      needsApproval: true,
      execute: async ({ fact, scope }) => {
        const outcome = await rememberFact(
          ctx.getWorkspaceRoot(),
          fact,
          undefined,
          scope,
        );
        if (!outcome.stored) {
          // Not an error: the model should carry on rather than retry.
          return { stored: false, reason: outcome.reason };
        }
        return {
          stored: true,
          remembered: fact,
          scope: outcome.scope,
          totalFacts: outcome.total,
        };
      },
    }),
  };
}
