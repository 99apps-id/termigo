import { tool } from "ai";
import { z } from "zod";
import { useElicitationStore } from "../store/elicitationStore";

/**
 * Elicitation tool: lets the agent ask the user a question with selectable
 * options, rendered as a clickable chooser in the chat (BatikCode
 * `chatElicitationContentPart` parity). The user's pick returns to the model as
 * the tool result; dismissing / stopping the run returns an error.
 */
export function buildElicitationTools() {
  return {
    ask_user: tool({
      description:
        "Ask the user a question with selectable options — e.g. choose between approaches, confirm a risky or ambiguous decision, or pick a target. Renders a clickable chooser in the chat; the user's pick returns here as the tool result. Use sparingly: prefer a sensible default and proceed when the choice is cheap to undo.",
      inputSchema: z.object({
        question: z
          .string()
          .min(1)
          .describe("A short, concrete question (one or two sentences)."),
        options: z
          .array(z.string().min(1).max(140))
          .min(2)
          .max(6)
          .describe("2–6 answer options; the user clicks one."),
      }),
      execute: async ({ question, options }, opts) => {
        const abort = opts?.abortSignal;
        const answer = await useElicitationStore
          .getState()
          .ask(question, options, abort);
        if (answer == null) {
          return { error: "no answer given" };
        }
        return { question, answer };
      },
    }),
  } as const;
}
