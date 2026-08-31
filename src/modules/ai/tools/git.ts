import { quoteShellArg } from "@/lib/shellQuote";
import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { enforcePolicy } from "../lib/policyEngine";
import { remoteUnsupported } from "../lib/remoteFs";
import { checkShellCommand } from "../lib/security";
import { getSessionShell, sessionShellKey } from "../lib/sessionShell";
import type { ToolContext } from "./context";

// A git branch name may use letters, digits, and `- _ . /`, but must not
// begin with `-` (option) or contain a space or control character. Anything
// else refuses rather than guessing — the model can pick a simpler name.
const BRANCH_RE = /^(?!-)[^\s~^:?*[\]\\]+$/;

function validBranch(name: string): boolean {
  if (!BRANCH_RE.test(name)) return false;
  // Control bytes and CR/LF would break the single-line command.
  return !/[\x00-\x1f]/.test(name);
}

// Exported for unit tests; not part of the tool surface.
export { validBranch };

/**
 * Resolve the directory git commands run in.
 *
 * Git is a *project* operation, so the workspace root is the anchor — not the
 * active terminal's cwd, which may be anywhere (the user's home, a subdir, or
 * an unrelated repo) and would make `git status` report the wrong tree or
 * "not a git repository". The workspace root is prefered, then the terminal
 * cwd, then "." — the same order BatikCode's agent host uses (cwd from the
 * session/workspace, falling back to the shell's working dir).
 */
export function repoRootFor(root: string | null, cwd: string | null): string {
  return root ?? cwd ?? ".";
}

const DIFF_CAP = 8000;

function truncate(s: string, cap = DIFF_CAP): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n… [truncated ${s.length - cap} chars]`;
}

/** Pure command builders, exported so the constructed shell line is testable. */
export function gitStatusCommand(): string {
  return "git status --short --branch";
}

export function gitDiffCommand(opts: {
  staged?: boolean;
  path?: string;
}): string {
  const base = opts.staged ? "git diff --staged" : "git diff";
  return opts.path ? `${base} -- ${quoteShellArg(opts.path)}` : base;
}

/** Revert tracked working-tree changes (never removes untracked files). */
export function revertCommand(paths: string[] | undefined): string {
  if (paths && paths.length > 0) {
    return `git restore -- ${paths.map((p) => quoteShellArg(p)).join(" ")}`;
  }
  return "git restore .";
}

export function gitPushCommand(): string {
  return "git push";
}

export function gitPullCommand(): string {
  return "git pull --ff-only";
}

export function gitStashCommand(message: string | undefined): string {
  const msg = (message ?? "").trim();
  if (!msg) return "git stash push";
  return `git stash push -m ${quoteShellArg(msg)}`;
}

export function gitStashPopCommand(): string {
  return "git stash pop";
}

export function gitLogCommand(limit: number): string {
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  return `git log --oneline -n ${n}`;
}

/**
 * `git blame` with an optional path and line range. A file may be at a
 * sub-path of the repo, so the file is always quoted; when no file is given
 * the whole tree is blamed line-by-line.
 */
export function gitBlameCommand(opts: {
  path?: string;
  lines?: string;
}): string {
  const args = ["blame", "--line-porcelain"];
  if (opts.lines) args.push(`-L ${opts.lines}`);
  if (opts.path) {
    args.push("--");
    args.push(quoteShellArg(opts.path));
  }
  return `git ${args.join(" ")}`;
}

/**
 * `git show` for one commit (with optional path filter). Falls back to HEAD
 * when the ref is empty. `--stat` shows the file list without a full diff so
 * a long commit does not flood the model; the caller decides via `statOnly`.
 */
export function gitShowCommand(opts: {
  ref?: string;
  path?: string;
  statOnly?: boolean;
}): string {
  const ref = (opts.ref ?? "HEAD").trim() || "HEAD";
  const args = ["show", "--format=fuller"];
  // Stat by default; only a full diff when the caller explicitly asks for it.
  if (opts.statOnly !== false) args.push("--stat");
  args.push(quoteShellArg(ref));
  if (opts.path) {
    args.push("--");
    args.push(quoteShellArg(opts.path));
  }
  return `git ${args.join(" ")}`;
}

export function buildGitTools(ctx: ToolContext) {
  return {
    git_status: tool({
      description:
        "Report the git working-tree state: current branch and untracked/modified/staged files. Read-only, auto-executes. Use before committing or before a risky change so the agent knows what is already dirty.",
      inputSchema: z.object({}),
      execute: async () => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "git_status",
            "Use bash_run with `git status` on the remote host.",
          );
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = repoRootFor(ctx.getWorkspaceRoot(), ctx.getCwd());
        const command = gitStatusCommand();
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        try {
          const shellId = await getSessionShell(
            sessionShellKey("git", sid, ctx.getWorkspaceRoot()),
            cwd,
          );
          const r = await native.shellSessionRun(shellId, command, cwd, 60);
          return {
            command,
            stdout: r.stdout,
            stderr: r.stderr,
            exit_code: r.exit_code,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    git_diff: tool({
      description:
        "Show the working-tree or staged diff (optionally for one path). Read-only, auto-executes. Use to see exactly what changed before committing or before asking the user to review.",
      inputSchema: z.object({
        staged: z
          .boolean()
          .optional()
          .describe(
            "Show the staged diff (git diff --staged) instead of unstaged.",
          ),
        path: z
          .string()
          .optional()
          .describe("Limit the diff to one file or directory."),
      }),
      execute: async ({ staged, path }) => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "git_diff",
            "Use bash_run with `git diff` on the remote host.",
          );
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = repoRootFor(ctx.getWorkspaceRoot(), ctx.getCwd());
        const command = gitDiffCommand({ staged, path });
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        try {
          const shellId = await getSessionShell(
            sessionShellKey("git", sid, ctx.getWorkspaceRoot()),
            cwd,
          );
          const r = await native.shellSessionRun(shellId, command, cwd, 60);
          return {
            command,
            stdout: truncate(r.stdout),
            stderr: r.stderr,
            exit_code: r.exit_code,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    revert_changes: tool({
      description:
        "Revert the agent's tracked working-tree changes (the safety valve). Pass `paths` to undo specific files, or omit to undo all tracked changes. Never removes untracked files. Requires approval, and deletion is never delegated.",
      inputSchema: z.object({
        paths: z
          .array(z.string())
          .optional()
          .describe(
            "Files/dirs to revert. Omit to revert all tracked changes in the workspace.",
          ),
      }),
      needsApproval: true,
      execute: async ({ paths }) => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "revert_changes",
            "Use bash_run with `git restore` on the remote host.",
          );
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = repoRootFor(ctx.getWorkspaceRoot(), ctx.getCwd());
        const command = revertCommand(paths);
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        try {
          const shellId = await getSessionShell(
            sessionShellKey("git", sid, ctx.getWorkspaceRoot()),
            cwd,
          );
          const r = await native.shellSessionRun(shellId, command, cwd, 120);
          return {
            command,
            reverted: paths ?? "all tracked changes",
            stdout: r.stdout,
            stderr: r.stderr,
            exit_code: r.exit_code,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    git_checkpoint: tool({
      description:
        "Create a WIP commit snapshot of the current changes as an undo point, before a risky edit. A checkpoint is an ordinary commit with a `checkpoint:` message — amend or reset it later. Requires approval.",
      inputSchema: z.object({
        message: z
          .string()
          .optional()
          .describe(
            "Short label for the checkpoint. Defaults to `checkpoint`.",
          ),
      }),
      needsApproval: true,
      execute: async ({ message }) => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "git_checkpoint",
            "Use bash_run on the remote host to snapshot changes.",
          );
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = repoRootFor(ctx.getWorkspaceRoot(), ctx.getCwd());
        const label = (message ?? "checkpoint").trim() || "checkpoint";
        const command = `git add -A && git commit -m ${quoteShellArg(
          `checkpoint: ${label}`,
        )}`;
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        try {
          const shellId = await getSessionShell(
            sessionShellKey("git", sid, ctx.getWorkspaceRoot()),
            cwd,
          );
          const r = await native.shellSessionRun(shellId, command, cwd, 120);
          return {
            command,
            message: `checkpoint: ${label}`,
            stdout: r.stdout,
            stderr: r.stderr,
            exit_code: r.exit_code,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    git_branch: tool({
      description:
        "Create and check out a new git branch (e.g. `feat/user-auth`). Use at the start of a change so work is isolated. Requires approval.",
      inputSchema: z.object({
        name: z
          .string()
          .describe(
            "Branch name. Use `type/description` (feat/, fix/, docs/).",
          ),
      }),
      needsApproval: true,
      execute: async ({ name }) => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "git_branch",
            "Use bash_run with `git checkout -b <branch>` on the remote host.",
          );
        }
        if (!validBranch(name)) {
          return {
            error:
              "Refused: branch name contains characters git will reject. Use letters, digits, `-`, `_`, `.` or `/`, and no leading `-`.",
          };
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = repoRootFor(ctx.getWorkspaceRoot(), ctx.getCwd());
        const command = `git checkout -b ${quoteShellArg(name)}`;
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        try {
          const shellId = await getSessionShell(
            sessionShellKey("git", sid, ctx.getWorkspaceRoot()),
            cwd,
          );
          const r = await native.shellSessionRun(shellId, command, cwd, 60);
          return {
            command,
            branch: name,
            stdout: r.stdout,
            stderr: r.stderr,
            exit_code: r.exit_code,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    git_commit: tool({
      description:
        "Stage and commit the current changes with a conventional message. Stages everything in the repo unless you pass `paths`. Requires approval.",
      inputSchema: z.object({
        message: z
          .string()
          .describe(
            "Commit message. One line, imperative mood, e.g. `fix: stop double-mounting terminals`.",
          ),
        paths: z
          .array(z.string())
          .optional()
          .describe("Files/dirs to stage. Omit to stage all changes."),
      }),
      needsApproval: true,
      execute: async ({ message, paths }) => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "git_commit",
            "Use bash_run with `git add <path> && git commit -m <msg>` on the remote host.",
          );
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = repoRootFor(ctx.getWorkspaceRoot(), ctx.getCwd());
        const add = paths?.length
          ? paths.map((p) => quoteShellArg(p)).join(" ")
          : "-A";
        const command = `git add ${add} && git commit -m ${quoteShellArg(message)}`;
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        const policy = await enforcePolicy({
          toolName: "git_commit",
          command,
          path: cwd,
        });
        if (!policy.allowed) {
          return { error: `Policy blocked: ${policy.reason}` };
        }
        try {
          const shellId = await getSessionShell(
            sessionShellKey("git", sid, ctx.getWorkspaceRoot()),
            cwd,
          );
          const r = await native.shellSessionRun(shellId, command, cwd, 120);
          return {
            command,
            message,
            stdout: r.stdout,
            stderr: r.stderr,
            exit_code: r.exit_code,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    git_pr: tool({
      description:
        "Push the current branch and open a pull request via `gh`. Use after a commit to hand the change off for review. Requires approval.",
      inputSchema: z.object({
        title: z.string().describe("PR title."),
        body: z.string().optional().describe("PR body (Markdown)."),
        base: z
          .string()
          .optional()
          .describe("Target branch (default: repo default)."),
        branch: z
          .string()
          .optional()
          .describe("Head branch. Defaults to the current branch."),
      }),
      needsApproval: true,
      execute: async ({ title, body, base, branch }) => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "git_pr",
            "Run `git push` and `gh pr create` on the remote host via bash_run.",
          );
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = repoRootFor(ctx.getWorkspaceRoot(), ctx.getCwd());

        const parts = ["gh pr create", `--title ${quoteShellArg(title)}`];
        if (body) parts.push(`--body ${quoteShellArg(body)}`);
        if (base) parts.push(`--base ${quoteShellArg(base)}`);
        if (branch) parts.push(`--head ${quoteShellArg(branch)}`);
        const command = parts.join(" ");
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        try {
          const shellId = await getSessionShell(
            sessionShellKey("git", sid, ctx.getWorkspaceRoot()),
            cwd,
          );
          const r = await native.shellSessionRun(shellId, command, cwd, 180);
          return {
            command,
            stdout: r.stdout,
            stderr: r.stderr,
            exit_code: r.exit_code,
            // `gh` writes the URL to stderr on success; surface it so the
            // model can hand the user a link.
            url:
              /https:\/\/[^\s]+/.exec(r.stderr)?.[0] ??
              r.stdout.match(/https:\/\/[^\s]+/)?.[0] ??
              null,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    git_push: tool({
      description:
        "Push the current branch to its upstream. Use after git_commit to publish the work. Requires approval.",
      inputSchema: z.object({}),
      needsApproval: true,
      execute: async () => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "git_push",
            "Use bash_run with `git push` on the remote host.",
          );
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = repoRootFor(ctx.getWorkspaceRoot(), ctx.getCwd());
        const command = gitPushCommand();
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        const policy = await enforcePolicy({
          toolName: "git_push",
          command,
          path: cwd,
        });
        if (!policy.allowed) {
          return { error: `Policy blocked: ${policy.reason}` };
        }
        try {
          const shellId = await getSessionShell(
            sessionShellKey("git", sid, ctx.getWorkspaceRoot()),
            cwd,
          );
          const r = await native.shellSessionRun(shellId, command, cwd, 180);
          return {
            command,
            stdout: r.stdout,
            stderr: r.stderr,
            exit_code: r.exit_code,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    git_log: tool({
      description:
        "List recent commits (one line each). Read-only, auto-executes. Use to understand what has changed recently, or to reference a commit in a message.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("How many commits to show. Defaults to 20."),
      }),
      execute: async ({ limit }) => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "git_log",
            "Use bash_run with `git log` on the remote host.",
          );
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = repoRootFor(ctx.getWorkspaceRoot(), ctx.getCwd());
        const command = gitLogCommand(limit ?? 20);
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        try {
          const shellId = await getSessionShell(
            sessionShellKey("git", sid, ctx.getWorkspaceRoot()),
            cwd,
          );
          const r = await native.shellSessionRun(shellId, command, cwd, 60);
          return {
            command,
            stdout: r.stdout,
            stderr: r.stderr,
            exit_code: r.exit_code,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    git_blame: tool({
      description:
        "Show who last changed each line of a file (git blame), with commit, author, and date per line. Read-only, auto-executes. Use to attribute a line or find which commit introduced it — e.g. 'who wrote this line?' or 'when did this regression appear?'. Optionally limit to a line range like '5-20'.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            "File to blame, relative to the repo root or the active cwd.",
          ),
        lines: z
          .string()
          .optional()
          .describe(
            "Optional line range, git syntax e.g. '5' or '5-20' (1-based).",
          ),
      }),
      execute: async ({ path, lines }) => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "git_blame",
            "Use bash_run with `git blame` on the remote host.",
          );
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = repoRootFor(ctx.getWorkspaceRoot(), ctx.getCwd());
        const command = gitBlameCommand({ path, lines });
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        try {
          const shellId = await getSessionShell(
            sessionShellKey("git", sid, ctx.getWorkspaceRoot()),
            cwd,
          );
          const r = await native.shellSessionRun(shellId, command, cwd, 120);
          return {
            command,
            stdout: truncate(r.stdout),
            stderr: r.stderr,
            exit_code: r.exit_code,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    git_show: tool({
      description:
        "Inspect a specific commit: metadata plus either the file list (--stat, default) or the full diff for one file. Read-only, auto-executes. Use to see what a commit changed without opening the diff UI — e.g. 'what did abc1234 do?'. Pass a ref (sha, branch, tag, or HEAD~2); defaults to HEAD.",
      inputSchema: z.object({
        ref: z
          .string()
          .optional()
          .describe(
            "Commit ref: sha, branch, tag, or HEAD~N. Defaults to HEAD.",
          ),
        path: z
          .string()
          .optional()
          .describe("Limit the diff to one file (relative to repo root)."),
        full_diff: z
          .boolean()
          .optional()
          .describe(
            "Show the full diff instead of the file list. Omit for a quick look; set only when the change itself matters.",
          ),
      }),
      execute: async ({ ref, path, full_diff }) => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "git_show",
            "Use bash_run with `git show` on the remote host.",
          );
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = repoRootFor(ctx.getWorkspaceRoot(), ctx.getCwd());
        const command = gitShowCommand({ ref, path, statOnly: !full_diff });
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        try {
          const shellId = await getSessionShell(
            sessionShellKey("git", sid, ctx.getWorkspaceRoot()),
            cwd,
          );
          const r = await native.shellSessionRun(shellId, command, cwd, 120);
          return {
            command,
            ref: (ref ?? "HEAD").trim() || "HEAD",
            stdout: truncate(r.stdout),
            stderr: r.stderr,
            exit_code: r.exit_code,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    git_pull: tool({
      description:
        "Pull the latest commits from the upstream (fast-forward only). Use before starting work so the branch is up to date. Requires approval.",
      inputSchema: z.object({}),
      needsApproval: true,
      execute: async () => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "git_pull",
            "Use bash_run with `git pull --ff-only` on the remote host.",
          );
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = repoRootFor(ctx.getWorkspaceRoot(), ctx.getCwd());
        const command = gitPullCommand();
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        try {
          const shellId = await getSessionShell(
            sessionShellKey("git", sid, ctx.getWorkspaceRoot()),
            cwd,
          );
          const r = await native.shellSessionRun(shellId, command, cwd, 180);
          return {
            command,
            stdout: r.stdout,
            stderr: r.stderr,
            exit_code: r.exit_code,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    git_stash: tool({
      description:
        "Park the current working-tree changes in a stash (without committing), keeping the tree clean. Use before a speculative change you may want to abandon. Untracked files are not stashed. Requires approval.",
      inputSchema: z.object({
        message: z
          .string()
          .optional()
          .describe("Short label for the stash. Defaults to an empty label."),
      }),
      needsApproval: true,
      execute: async ({ message }) => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "git_stash",
            "Use bash_run with `git stash` on the remote host.",
          );
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = repoRootFor(ctx.getWorkspaceRoot(), ctx.getCwd());
        const command = gitStashCommand(message);
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        try {
          const shellId = await getSessionShell(
            sessionShellKey("git", sid, ctx.getWorkspaceRoot()),
            cwd,
          );
          const r = await native.shellSessionRun(shellId, command, cwd, 120);
          return {
            command,
            stashed: message ?? "unnamed",
            stdout: r.stdout,
            stderr: r.stderr,
            exit_code: r.exit_code,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    git_stash_pop: tool({
      description:
        "Restore the most recent stash and drop it from the list. Use after git_stash to get your parked changes back. Requires approval.",
      inputSchema: z.object({}),
      needsApproval: true,
      execute: async () => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "git_stash_pop",
            "Use bash_run with `git stash pop` on the remote host.",
          );
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = repoRootFor(ctx.getWorkspaceRoot(), ctx.getCwd());
        const command = gitStashPopCommand();
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        try {
          const shellId = await getSessionShell(
            sessionShellKey("git", sid, ctx.getWorkspaceRoot()),
            cwd,
          );
          const r = await native.shellSessionRun(shellId, command, cwd, 120);
          return {
            command,
            stdout: r.stdout,
            stderr: r.stderr,
            exit_code: r.exit_code,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  } as const;
}
