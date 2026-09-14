import { tool } from "ai";
import { z } from "zod";

export function buildThinkTools() {
  return {
    think: tool({
      description:
        "Private scratchpad to record your thoughts, reason through problems, analyze edge cases, or plan multi-step implementations before executing changes.\n\nNot shown to the user as direct response, but recorded into context without external side effects.",
      inputSchema: z.object({
        thoughts: z
          .string()
          .describe(
            "Your private thoughts, analysis, hypothesis testing, or plan.",
          ),
      }),
      execute: async ({ thoughts }) => {
        return {
          ok: true,
          recorded: true,
          length: thoughts.length,
        };
      },
    }),
  } as const;
}
