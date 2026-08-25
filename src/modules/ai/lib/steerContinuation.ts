/**
 * Steer Message Continuation & Task Resumption Engine
 *
 * Enables the agent to handle user mid-run steer interruptions seamlessly,
 * addressing the user's new instructions while maintaining the overarching task context.
 */

export type SteerContinuationContext = {
  originalTask?: string;
  completedSteps?: string[];
  currentFilesModified?: string[];
  steerInput: string;
};

/**
 * Constructs an instruction prompt that weaves the user's steer message
 * together with the in-flight task status so the model can pivot or adjust.
 */
export function buildSteeredContinuationPrompt(ctx: SteerContinuationContext): string {
  const parts: string[] = [];

  parts.push(`<user_steer_interrupt>\n${ctx.steerInput.trim()}\n</user_steer_interrupt>`);

  if (ctx.originalTask) {
    parts.push(`Original Goal: ${ctx.originalTask.trim()}`);
  }

  if (ctx.completedSteps && ctx.completedSteps.length > 0) {
    parts.push(
      `Progress completed before steer:\n${ctx.completedSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    );
  }

  if (ctx.currentFilesModified && ctx.currentFilesModified.length > 0) {
    parts.push(`Files modified so far: ${ctx.currentFilesModified.join(", ")}`);
  }

  parts.push(
    "Instructions: Acknowledge the user's steer message directly. If the steer updates, clarifies, or redirects the original goal, adapt your approach accordingly. Continue working toward the resolution without repeating completed work unnecessarily.",
  );

  return parts.join("\n\n");
}
