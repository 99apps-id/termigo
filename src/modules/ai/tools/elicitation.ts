import { tool } from "ai";
import { z } from "zod";
import { useElicitationStore } from "../store/elicitationStore";

/** Max characters per option shown in the chooser. */
const OPTION_MAX = 140;

/**
 * Coerce a near-miss `ask_user` input into a valid one instead of rejecting it.
 *
 * The strict schema (options 2–6, each ≤140 chars) used to HARD-FAIL on a
 * recoverable mistake: a model writing a build plan routinely stuffs a long
 * rationale into an option ("... — REKOMENDASI") or emits options as a JSON
 * string, and strict validation threw "Invalid input for tool ask_user",
 * which the SDK fed back to the model so it retried, failed again, and the
 * run looked like it was looping on the question. Normalising first — parse a
 * stringified array, trim each option to the cap, drop empties, clamp to 6 —
 * means the chooser renders and the user answers on the first try. The two
 * hard rules we keep: a question must exist, and there must be ≥2 usable
 * options (a single choice is not a question; that stays an error result).
 */
export function normalizeAskUserInput(input: unknown): unknown {
  let value = input;
  // A provider that double-encodes the whole call as a JSON string.
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return input;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return input;
  const obj = { ...(value as Record<string, unknown>) };

  let options: unknown = obj.options;
  if (typeof options === "string") {
    // options sent as a JSON array string, or a newline/comma-delimited list.
    const text = options;
    try {
      const parsed: unknown = JSON.parse(text);
      options = Array.isArray(parsed) ? parsed : text.split(/\r?\n/);
    } catch {
      options = text.split(/\r?\n/);
    }
  }
  if (Array.isArray(options)) {
    obj.options = options
      .map((o) =>
        typeof o === "string"
          ? o.trim()
          : o && typeof o === "object"
            ? String(
                (o as { label?: unknown; value?: unknown }).label ??
                  (o as { value?: unknown }).value ??
                  "",
              ).trim()
            : "",
      )
      .filter((o) => o.length > 0)
      .map((o) =>
        o.length > OPTION_MAX ? `${o.slice(0, OPTION_MAX - 1)}…` : o,
      )
      // De-duplicate identical options so the cap count is honest.
      .filter((o, i, arr) => arr.indexOf(o) === i)
      .slice(0, 6);
  }
  return obj;
}

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
        "Ask the user a question with selectable options — e.g. choose between approaches, confirm a risky or ambiguous decision, or pick a target. Renders a clickable chooser in the chat; the user's pick returns here as the tool result. Use sparingly: prefer a sensible default and proceed when the choice is cheap to undo. Keep each option SHORT (< 140 chars): a label, not a paragraph — put the rationale in the question or your surrounding prose, not the button.",
      inputSchema: z.preprocess(
        normalizeAskUserInput,
        z.object({
          question: z
            .string()
            .min(1)
            .describe("A short, concrete question (one or two sentences)."),
          options: z
            .array(z.string().min(1).max(OPTION_MAX))
            .min(2)
            .max(6)
            .describe("2–6 answer options; the user clicks one."),
        }),
      ),
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
