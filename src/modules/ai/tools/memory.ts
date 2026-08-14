import { tool } from "ai";
import { z } from "zod";
import { rememberFact } from "../lib/memory";
import type { ToolContext } from "./context";

export function buildMemoryTools(ctx: ToolContext) {
  return {
    remember: tool({
      description:
        "Record one durable fact about this project so future sessions start with it. " +
        "Use it for things that stay true: build and test commands, conventions the user " +
        "corrected you on, architectural decisions, paths that matter, things never to run. " +
        "Do NOT use it for the current task, transient state, file contents you can re-read, " +
        "or anything the user has not confirmed. One fact per call, written as a short " +
        "standalone sentence that will still make sense with no conversation around it. " +
        "Stored in .termigo/memory.md, which the user can edit or delete. Asks for approval.",
      inputSchema: z.object({
        fact: z
          .string()
          .min(1)
          .describe(
            "A single durable fact, phrased to stand alone. Good: 'Tests run with pnpm test; " +
              "npm is not used in this repo.' Bad: 'The user asked me to fix the dialog.'",
          ),
      }),
      needsApproval: true,
      execute: async ({ fact }) => {
        const outcome = await rememberFact(ctx.getWorkspaceRoot(), fact);
        if (!outcome.stored) {
          // Not an error: the model should carry on rather than retry.
          return { stored: false, reason: outcome.reason };
        }
        return { stored: true, remembered: fact, totalFacts: outcome.total };
      },
    }),
  };
}
