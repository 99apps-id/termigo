import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import {
  createPr,
  getPr,
  listPrs,
  reviewPr,
  commentPr,
  mergePr,
} from "../lib/github";
import type { ToolContext } from "./context";

export function buildGithubTools(ctx: ToolContext) {
  return {
    github_create_pr: tool({
      description:
        "Create a GitHub pull request from the current branch. Use after git_commit to publish the work. Requires approval.",
      inputSchema: z.object({
        title: z.string().describe("PR title."),
        body: z.string().optional().describe("PR body (Markdown)."),
        base: z.string().optional().describe("Target branch (default: repo default)."),
      }),
      needsApproval: true,
      execute: async ({ title, body, base }) => {
        if (ctx.getRemoteSession()) {
          return { error: "GitHub operations are not supported in remote SSH sessions." };
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = ctx.getWorkspaceRoot() ?? ctx.getCwd() ?? ".";
        const head = await getCurrentBranch(cwd);
        if (!head) {
          return { error: "could not determine current git branch" };
        }
        const result = await createPr(title, body ?? "", base ?? "", head, cwd);
        if (!result.ok || !result.pr) {
          return { error: result.error ?? "failed to create PR" };
        }
        return {
          number: result.pr.number,
          url: result.pr.url,
          title: result.pr.title,
          state: result.pr.state,
        };
      },
    }),

    github_get_pr: tool({
      description:
        "Get details, comments, and reviews for a GitHub pull request. Read-only, auto-executes.",
      inputSchema: z.object({
        number: z.number().int().positive().describe("PR number."),
      }),
      execute: async ({ number }) => {
        if (ctx.getRemoteSession()) {
          return { error: "GitHub operations are not supported in remote SSH sessions." };
        }
        const cwd = ctx.getWorkspaceRoot() ?? ctx.getCwd() ?? ".";
        const result = await getPr(number, cwd);
        if (!result.ok || !result.pr) {
          return { error: result.error ?? `PR #${number} not found` };
        }
        return {
          pr: result.pr,
        };
      },
    }),

    github_list_prs: tool({
      description:
        "List open pull requests in the current repository. Read-only, auto-executes.",
      inputSchema: z.object({
        state: z.enum(["open", "closed", "all"]).optional().default("open").describe("Filter by PR state."),
      }),
      execute: async ({ state }) => {
        if (ctx.getRemoteSession()) {
          return { error: "GitHub operations are not supported in remote SSH sessions." };
        }
        const cwd = ctx.getWorkspaceRoot() ?? ctx.getCwd() ?? ".";
        const result = await listPrs(cwd, state ?? "open");
        if (!result.ok || !result.prs) {
          return { error: result.error ?? "failed to list PRs" };
        }
        return { prs: result.prs };
      },
    }),

    github_review_pr: tool({
      description:
        "Submit a review on a pull request (approve, request changes, or comment). Requires approval.",
      inputSchema: z.object({
        number: z.number().int().positive().describe("PR number."),
        state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]).describe("Review decision."),
        body: z.string().describe("Review body (Markdown)."),
      }),
      needsApproval: true,
      execute: async ({ number, state, body }) => {
        if (ctx.getRemoteSession()) {
          return { error: "GitHub operations are not supported in remote SSH sessions." };
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = ctx.getWorkspaceRoot() ?? ctx.getCwd() ?? ".";
        const result = await reviewPr(number, state, body, cwd);
        if (!result.ok) return { error: result.error };
        return { reviewed: true, number, state };
      },
    }),

    github_comment_pr: tool({
      description: "Post a comment on a pull request. Requires approval.",
      inputSchema: z.object({
        number: z.number().int().positive().describe("PR number."),
        body: z.string().describe("Comment body (Markdown)."),
      }),
      needsApproval: true,
      execute: async ({ number, body }) => {
        if (ctx.getRemoteSession()) {
          return { error: "GitHub operations are not supported in remote SSH sessions." };
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = ctx.getWorkspaceRoot() ?? ctx.getCwd() ?? ".";
        const result = await commentPr(number, body, cwd);
        if (!result.ok) return { error: result.error };
        return { commented: true, number };
      },
    }),

    github_merge_pr: tool({
      description: "Merge a pull request. Requires approval.",
      inputSchema: z.object({
        number: z.number().int().positive().describe("PR number."),
        method: z.enum(["merge", "squash", "rebase"]).optional().default("merge").describe("Merge strategy."),
      }),
      needsApproval: true,
      execute: async ({ number, method }) => {
        if (ctx.getRemoteSession()) {
          return { error: "GitHub operations are not supported in remote SSH sessions." };
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = ctx.getWorkspaceRoot() ?? ctx.getCwd() ?? ".";
        const result = await mergePr(number, cwd, method ?? "merge");
        if (!result.ok) return { error: result.error };
        return { merged: true };
      },
    }),
  };
}

async function getCurrentBranch(cwd: string): Promise<string | null> {
  let shellId: number | null = null;
  try {
    shellId = await native.shellSessionOpen(cwd);
    const r = await native.shellSessionRun(shellId, "git branch --show-current", cwd, 10);
    if (r.exit_code === 0 && r.stdout.trim()) {
      return r.stdout.trim();
    }
  } catch {
    // ignore
  } finally {
    if (shellId !== null) {
      void native.shellSessionClose(shellId).catch(() => {});
    }
  }
  return null;
}
