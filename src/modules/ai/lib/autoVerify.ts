// Automatic post-edit verification wrapper (full-agentic loop).
//
// `withAutoVerify` wraps a mutating tool so a successful edit folds a
// best-effort format + lint outcome into the tool result as a `verification`
// field — the read -> change -> verify -> repair loop. The heavy lifting lives
// in autoVerifyRunner.ts; this module only decides WHEN to run it and how to
// attach the outcome, so its control flow is unit-testable by mocking the
// runner.

import type { ToolContext } from "../tools/context";
import { autoVerifyEditedFile } from "./autoVerifyRunner";

/** Tools whose successful result triggers an automatic verify. */
export const AUTO_VERIFY_TOOLS = new Set(["write_file", "edit", "multi_edit"]);

export type { VerifyOutcome } from "./autoVerifyRunner";
export { autoVerifyEditedFile } from "./autoVerifyRunner";

/** Pull the edited path out of a tool result when present. */
function editedPathFrom(result: unknown): string | null {
  if (result && typeof result === "object") {
    const p = (result as { path?: unknown }).path;
    if (typeof p === "string" && p.length > 0) return p;
  }
  return null;
}

/**
 * Wrap a mutating tool so a successful edit folds a best-effort verify into
 * the result (`verification` field). The edit result is always returned; a
 * skipped or failed verify just leaves the field out. Runs AFTER the
 * post-execute confirmation wrapper, so a Reverted edit is never verified.
 */
export function withAutoVerify<
  T extends {
    execute: (
      args: Record<string, unknown>,
      options: { toolCallId?: string; abortSignal?: AbortSignal },
    ) => Promise<unknown>;
  },
>(name: string, tool: T, ctx: ToolContext): T {
  if (!AUTO_VERIFY_TOOLS.has(name)) return tool;
  const original = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (
      args: Record<string, unknown>,
      options: { toolCallId?: string; abortSignal?: AbortSignal },
    ) => {
      const result = await original(args, options);
      // Only successful, non-reverted edits are verified.
      if (result && typeof result === "object" && "error" in result) {
        return result;
      }
      if (
        result &&
        typeof result === "object" &&
        (result as { reverted_by_user?: boolean }).reverted_by_user
      ) {
        return result;
      }
      const path = editedPathFrom(result);
      if (!path) return result;
      const verification = await autoVerifyEditedFile(ctx, path).catch(
        () => null,
      );
      if (!verification) return result;
      return {
        ...(result as Record<string, unknown>),
        verification,
      };
    },
  };
}
