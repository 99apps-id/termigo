import { quoteShellArg } from "@/lib/shellQuote";
import { tool } from "ai";
import { z } from "zod";
import { runSubagent } from "../agents/runSubagent";
import { native } from "../lib/native";
import { reviewBaseFromLog } from "../lib/snapshots";
import { checkShellCommand } from "../lib/security";
import { getSessionShell, sessionShellKey } from "../lib/sessionShell";
import { useChatStore } from "../store/chatStore";
import type { ToolContext } from "./context";
import { gitDiffCommand, isValidRev } from "./git";
import { reviewDiffWithRetry } from "./reviewCore";

const DIFF_CAP = 32_000;

/** Run a read-only git command in the session shell, capping the output. */
async function runGit(
  ctx: ToolContext,
  command: string,
  cap = DIFF_CAP,
): Promise<{ command: string; stdout: string } | { error: string }> {
  if (ctx.getRemoteSession()) {
    return {
      error: "git commands are local-only; use bash_run on the remote host",
    };
  }
  const sid = ctx.getSessionId();
  if (!sid) return { error: "no active chat session" };
  // Project-first cwd (BatikCode parity): review is a project operation, so
  // anchor at the workspace root and fall back to the terminal cwd.
  const cwd = ctx.getWorkspaceRoot() ?? ctx.getCwd() ?? ".";
  const safety = checkShellCommand(command);
  if (!safety.ok) return { error: safety.reason };
  const shellId = await getSessionShell(
    sessionShellKey("git", sid, ctx.getWorkspaceRoot()),
    cwd,
  );
  const r = await native.shellSessionRun(shellId, command, cwd, 60);
  return { command, stdout: r.stdout.slice(0, cap) };
}

/**
 * Pick the revision a review diffs against.
 *
 * An explicit `base` wins after validation. Otherwise the review auto-detects
 * the auto-checkpoint blind spot: the pre-run checkpoint commit swallows the
 * working tree into history, so a plain `git diff` reviews only what changed
 * since the checkpoint and silently misses everything before it. When HEAD is
 * checkpoint-deep, the newest real commit is the honest base.
 */
async function resolveReviewBase(
  ctx: ToolContext,
  explicit?: string,
): Promise<{ base?: string; error?: undefined } | { error: string }> {
  if (explicit !== undefined) {
    if (!isValidRev(explicit)) {
      return {
        error:
          "invalid base revision: pass a commit sha or branch/tag name (no options, spaces, or control characters)",
      };
    }
    return { base: explicit.trim() };
  }
  try {
    const root = ctx.getWorkspaceRoot() ?? ctx.getCwd();
    if (!root) return {};
    const log = await native.gitLog(root, { limit: 25 });
    const auto = reviewBaseFromLog(log);
    // The sha arrives from the native git-log parser; re-check it as a rev
    // rather than trusting the parser's output to be well-shaped.
    return auto && isValidRev(auto) ? { base: auto } : {};
  } catch {
    // No history readable (fresh repo, git missing): the plain diff stands.
    return {};
  }
}

/**
 * Review the current changes before they are committed. Runs the code-review
 * sub-agent over the working-tree diff, then returns its findings so the agent
 * can fix issues before `git_commit`. Read-only: it never modifies anything.
 */
export function buildReviewTools(ctx: ToolContext) {
  return {
    review_changes: tool({
      description:
        "Run a code-review subagent over the current git diff and return actionable findings, BEFORE committing. Use after edits and after run_checks pass, before git_commit — so the change is reviewed for correctness, security and architecture before it lands. The diff baseline is the working tree; when an auto-checkpoint has swallowed earlier work, the newest real commit is used instead (or pass `base`). Read-only, auto-executes.",
      inputSchema: z.object({
        staged: z
          .boolean()
          .optional()
          .describe("Review the staged diff instead of the unstaged one."),
        scope: z
          .string()
          .optional()
          .describe(
            "Narrow the review to one path (e.g. src/), so a large change does not flood the review with unrelated files.",
          ),
        base: z
          .string()
          .optional()
          .describe(
            "Diff against this commit sha / branch instead of the automatic baseline.",
          ),
      }),
      execute: async ({ staged, scope, base }) => {
        const resolved = await resolveReviewBase(ctx, base);
        if ("error" in resolved) return { error: resolved.error };
        const command = gitDiffCommand({
          staged,
          path: scope,
          base: resolved.base,
        });
        const diff = await runGit(ctx, command);
        if ("error" in diff) return { error: diff.error };
        if (!diff.stdout.trim()) {
          return { summary: "No changes to review.", command: diff.command };
        }
        const { apiKeys, selectedModelId } = useChatStore.getState();
        if (!apiKeys || !selectedModelId) {
          return { error: "no provider key/model configured for review" };
        }
        try {
          const r = await reviewDiffWithRetry(
            diff.stdout,
            (prompt, timeoutMs) =>
              runSubagent({
                type: "code-review",
                prompt,
                keys: apiKeys,
                modelId: selectedModelId,
                toolContext: ctx,
                requester: "code review",
                abortSignal: AbortSignal.timeout(timeoutMs),
              }),
          );
          return "error" in r
            ? { ...r, command: diff.command }
            : { command: diff.command, ...r };
        } catch (e) {
          return { error: String(e), command: diff.command };
        }
      },
    }),

    review_run: tool({
      description:
        "Summarize everything the agent has changed this session in one place: the changed-file list, a diff stat, and the full unified diff. Use to show the user the whole change set before committing, or before reverting. Auto-detects an auto-checkpoint-swallowed change set and diffs from the newest real commit when one exists (or pass `base`). Read-only, auto-executes.",
      inputSchema: z.object({
        staged: z
          .boolean()
          .optional()
          .describe("Include staged changes instead of unstaged."),
        scope: z.string().optional().describe("Limit to one path (e.g. src/)."),
        base: z
          .string()
          .optional()
          .describe(
            "Diff against this commit sha / branch instead of the automatic baseline.",
          ),
      }),
      execute: async ({ staged, scope, base }) => {
        const resolved = await resolveReviewBase(ctx, base);
        if ("error" in resolved) return { error: resolved.error };
        const rev = resolved.base ? ` ${quoteShellArg(resolved.base)}` : "";
        const quoted = scope ? ` -- ${quoteShellArg(scope)}` : "";
        const head = staged ? "git diff --cached" : "git diff";
        // With a base the working tree may be clean (the checkpoint committed
        // it all), so `git status` would list nothing while the diff is large;
        // the file list must come from the same comparison as the diff.
        const files = resolved.base
          ? await runGit(ctx, `git diff --name-only${rev}${quoted}`, 8_000)
          : await runGit(ctx, `git status --porcelain`, 8_000);
        if ("error" in files) return { error: files.error };
        const stat = await runGit(ctx, `${head}${rev} --stat${quoted}`, 8_000);
        if ("error" in stat) return { error: stat.error };
        const diff = await runGit(ctx, `${head}${rev}${quoted}`, DIFF_CAP);
        if ("error" in diff) return { error: diff.error };
        const changed = files.stdout
          .trim()
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        return {
          files: changed,
          stat: stat.stdout,
          diff: diff.stdout,
          truncated: diff.stdout.length >= DIFF_CAP,
          ...(resolved.base ? { base: resolved.base } : {}),
        };
      },
    }),
  } as const;
}
