// Auto-continue policy for budget pauses.
//
// A run that exhausts its step budget (the 25 -> 50 -> 100 ladder) is paused,
// not failed: the transcript is intact and the next round simply gets the next
// rung. Historically every pause needed a manual "Continue" click, which for
// approval-gated work (one model call per tool round) meant clicking over and
// over on a task that was progressing fine. When the preference is on, the run
// resumes itself. The ladder is bounded per task so a model that keeps hitting
// the cap without ever summarising eventually defers to the manual button
// instead of burning tokens unattended.
//
// Stops that signal a STUCK agent (tool repetition, no progress, repeated tool
// errors, cost cap) are deliberately NOT auto-continued — a new round would
// just repeat the same failure. Only "step-cap" qualifies.

/** How many automatic continues one task may chain before the manual
 *  Continue button takes over again. Reset by any fresh user message. */
export const MAX_AUTO_CONTINUES = 8;

/** Breathing room between the pause and the auto-resume, so the UI settles
 *  (and a queued Stop lands) before the next round is dispatched. */
export const AUTO_CONTINUE_DELAY_MS = 1_200;

/** Whether another automatic continue may be attempted for a task that has
 *  already used `attempts` of them. Pure, so the budget is testable without
 *  the chat runtime. */
export function autoContinueSlot(
  attempts: number,
  max: number = MAX_AUTO_CONTINUES,
): boolean {
  return attempts < max;
}
