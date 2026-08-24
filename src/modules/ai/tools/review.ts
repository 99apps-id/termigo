import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { checkShellCommand } from "../lib/security";
import { getSessionShell, sessionShellKey } from "../lib/sessionShell";
import { quoteShellArg } from "@/lib/shellQuote";
import { runSubagent } from "../agents/runSubagent";
import { useChatStore } from "../store/chatStore";
import { gitDiffCommand } from "./git";
import type { ToolContext } from "./context";

const DIFF_CAP = 32_000;

/** Run a read-only git command in the session shell, capping the output. */
async function runGit(
  ctx: ToolContext,
  command: string,
  cap = DIFF_CAP,
): Promise<{ command: string; stdout: string } | { error: string }> {
  if (ctx.getRemoteSession()) {
    return { error: "git commands are local-only; use bash_run on the remote host" };
  }
  const sid = ctx.getSessionId();
  if (!sid) return { error: "no active chat session" };
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
 * Review the current changes before they are committed. Runs the code-review
 * sub-agent over the working-tree diff, then returns its findings so the agent
 * can fix issues before `git_commit`. Read-only: it never modifies anything.
 */
export function buildReviewTools(ctx: ToolContext) {
  return {
    review_changes: tool({
      description:
        "Run a code-review subagent over the current git diff and return actionable findings, BEFORE committing. Use after edits and after run_checks pass, before git_commit — so the change is reviewed for correctness, security and architecture before it lands. Read-only, auto-executes.",
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
      }),
      execute: async ({ staged, scope }) => {
        const command = gitDiffCommand({ staged, path: scope });
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
          const r = await runSubagent({
            type: "code-review",
            prompt: `Review the following git diff for correctness bugs, security risks and architecture issues. Report only ACTIONABLE findings, each as "[MUST/SHOULD/NIT] — issue → fix". If nothing is wrong say "Looks good."\n\n\`\`\`diff\n${diff.stdout}\n\`\`\``,
            keys: apiKeys,
            modelId: selectedModelId,
            toolContext: ctx,
            requester: "code review",
          });
          return { command: diff.command, summary: r.summary };
        } catch (e) {
          return { error: String(e), command: diff.command };
        }
      },
    }),

    review_run: tool({
      description:
        "Summarize everything the agent has changed this session in one place: the changed-file list, a diff stat, and the full unified diff. Use to show the user the whole change set before committing, or before reverting. Read-only, auto-executes.",
      inputSchema: z.object({
        staged: z
          .boolean()
          .optional()
          .describe("Include staged changes instead of unstaged."),
        scope: z
          .string()
          .optional()
          .describe("Limit to one path (e.g. src/)."),
      }),
      execute: async ({ staged, scope }) => {
        const base = staged ? "git diff --cached" : "git diff";
        const quoted = scope ? ` -- ${quoteShellArg(scope)}` : "";
        const files = await runGit(ctx, `git status --porcelain`, 8_000);
        if ("error" in files) return { error: files.error };
        const stat = await runGit(ctx, `${base} --stat${quoted}`, 8_000);
        if ("error" in stat) return { error: stat.error };
        const diff = await runGit(ctx, `${base}${quoted}`, DIFF_CAP);
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
        };
      },
    }),
  } as const;
}
