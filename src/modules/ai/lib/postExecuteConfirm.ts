import { usePreferencesStore } from "@/modules/settings/preferences";
import { useConfirmationStore } from "../store/confirmationStore";
import type { ToolContext } from "../tools/context";
import { revertCommand } from "../tools/git";
import { native } from "./native";
import { checkShellCommand } from "./security";
import { getSessionShell, sessionShellKey } from "./sessionShell";

/**
 * Mutating tools that pause for a post-execution "Keep / Revert?" confirmation
 * when the `confirmAfterMutations` preference is on (BatikCode
 * `PendingResultConfirmation` parity). The run resumes only after the user
 * decides; "Revert" restores the touched paths from git (best-effort).
 */
export const POST_EXECUTE_CONFIRM_TOOLS = new Set([
  "write_file",
  "edit",
  "multi_edit",
  "bash_run",
]);

/**
 * Best-effort revert of touched paths via `git restore` on the shared session
 * shell (the same plumbing the `revert_changes` tool uses). Returns the
 * command that ran, or null when revert was skipped/unsafe.
 */
async function revertTouched(
  ctx: ToolContext,
  sessionId: string,
  paths: string[],
): Promise<string | null> {
  try {
    const cwd = ctx.getWorkspaceRoot() ?? ctx.getCwd();
    const command = revertCommand(paths.length > 0 ? paths : undefined);
    const safety = checkShellCommand(command);
    if (!safety.ok) return null;
    const shellId = await getSessionShell(
      sessionShellKey("git", sessionId, ctx.getWorkspaceRoot()),
      cwd,
    );
    const r = await native.shellSessionRun(shellId, command, cwd, 120);
    return r.exit_code === 0 ? command : null;
  } catch {
    return null;
  }
}

/** Pull the touched path out of a successful tool result when present. */
function touchedPathsFromResult(result: unknown): string[] {
  if (result && typeof result === "object") {
    const path = (result as { path?: unknown }).path;
    if (typeof path === "string" && path.length > 0) return [path];
  }
  return [];
}

/**
 * Wrap a mutating tool so that, after a successful execute, it registers a
 * post-execution confirmation and awaits the user's Keep / Revert decision.
 * Skipped entirely when the preference is off, when the run has no session,
 * or when the tool errored. A null decision (dismissed / aborted) keeps the
 * change — an aborted run must never auto-revert.
 */
export function withPostExecuteConfirm<
  T extends {
    execute: (
      args: Record<string, unknown>,
      options: { toolCallId?: string; abortSignal?: AbortSignal },
    ) => Promise<unknown>;
  },
>(name: string, tool: T, ctx: ToolContext): T {
  const original = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (
      args: Record<string, unknown>,
      options: { toolCallId?: string; abortSignal?: AbortSignal },
    ) => {
      const result = await original(args, options);
      // Only successful mutations pause for confirmation.
      if (
        !POST_EXECUTE_CONFIRM_TOOLS.has(name) ||
        !usePreferencesStore.getState().confirmAfterMutations
      ) {
        return result;
      }
      if (result && typeof result === "object" && "error" in result) {
        return result;
      }
      const sessionId = ctx.getSessionId();
      if (!sessionId) return result;

      const touchedPaths = touchedPathsFromResult(result);
      const summary = makeSummary(name, args, touchedPaths);
      const keep = await useConfirmationStore
        .getState()
        .request(
          sessionId,
          { toolName: name, summary, touchedPaths },
          options?.abortSignal,
        );
      if (keep !== false) return result; // true or null → keep the change

      const reverted = await revertTouched(ctx, sessionId, touchedPaths);
      return {
        ...(result as Record<string, unknown>),
        reverted_by_user: true,
        revert_command: reverted ?? null,
        note: "The user reverted this change after it ran; do not treat it as applied.",
      };
    },
  };
}

/** Short human summary for the confirmation card. */
export function makeSummary(
  toolName: string,
  args: Record<string, unknown>,
  touchedPaths: string[],
): string {
  const path =
    touchedPaths[0] ?? (typeof args.path === "string" ? args.path : null);
  switch (toolName) {
    case "write_file":
      return path ? `Wrote ${path}` : "Wrote a file";
    case "edit":
      return path ? `Edited ${path}` : "Edited a file";
    case "multi_edit":
      return path ? `Edited ${path}` : "Edited files";
    case "bash_run":
      return `Ran command: ${String(args.command ?? "").slice(0, 90)}`;
    default:
      return path ? `${toolName} on ${path}` : toolName;
  }
}
