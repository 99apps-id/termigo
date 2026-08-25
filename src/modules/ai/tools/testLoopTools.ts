import { tool } from "ai";
import { z } from "zod";
import { resolvePath, type ToolContext } from "./context";
import { checkShellCommand } from "../lib/security";
import { remoteUnsupported } from "../lib/remoteFs";
import { getSessionShell, sessionShellKey } from "../lib/sessionShell";
import { native } from "../lib/native";
import { TestAttemptTracker, retryGuidance } from "../lib/testLoop";
import { detectCheckCommand } from "./verify";

/**
 * Bounded retry budget for the fix->re-run loop per (session, file). Every
 * `test_file` run requires approval anyway, so the cap is a guardrail against
 * the model burning approvals on an identical failing run, not the primary
 * gate.
 */
const MAX_TEST_RETRIES = 3;
const attemptTrackers = new Map<string, TestAttemptTracker>();

function trackerFor(sessionId: string): TestAttemptTracker {
  let tracker = attemptTrackers.get(sessionId);
  if (!tracker) {
    tracker = new TestAttemptTracker(MAX_TEST_RETRIES);
    attemptTrackers.set(sessionId, tracker);
  }
  return tracker;
}

/** Drop the retry counters for a session (e.g. when the chat is closed). */
export function resetTestAttempts(sessionId: string): void {
  attemptTrackers.delete(sessionId);
}

/**
 * Target a single test file at the configured test command where the runner
 * supports it, without inventing syntax for the runners it does not know.
 * Returns the command unchanged (with a note) when focusing is unsupported so
 * a wrong test invocation can never mask the real suite.
 *
 * - vitest / jest: append the file; jest needs `--passWithNoTests` or it
 *   errors when the file matches nothing.
 * - pytest: append the file (pytest accepts paths directly).
 * - go test: scope to the file's package directory instead of `./...`.
 * - cargo test: run the whole suite; rust filters by module path at runtime,
 *   so guessing one from a file is fragile.
 * - anything else: leave the configured command alone.
 */
export function focusTestFile(
  base: string,
  file: string,
): { command: string; note: string } {
  const b = base.trim();
  if (!b) return { command: b, note: "no test command configured" };
  const isVitest = /(^|\s)(vitest|(\S*)vitest)(\s|$)/.test(b);
  const isJest = /(^|\s)jest(\s|$)/.test(b) || /(^|\s)npx jest/.test(b);
  const isPytest = /pytest/.test(b);

  if (isVitest || isJest || isPytest) {
    const passWithNoTests = isJest ? " --passWithNoTests" : "";
    return { command: `${b} ${file}${passWithNoTests}`, note: `focused ${file}` };
  }
  if (/\bgo test\b/.test(b)) {
    const slash = file.lastIndexOf("/");
    const pkgDir = slash === -1 ? "." : file.slice(0, slash);
    return {
      command: `${b.replace(/(\.\/\.\.\.|\.\.\/\.\.\.|\.\/)/g, "").trim()} ${pkgDir}`,
      note: "scoped to the file's package; no file-level go test filter exists",
    };
  }
  if (/\bcargo test\b/.test(b)) {
    return {
      command: b,
      note: "cargo filters by module path at runtime, not by file; running the full suite",
    };
  }
  return { command: b, note: "could not focus this runner; running the configured command" };
}

/**
 * Focused test runner: run the project's test command narrowed to one file
 * where the runner supports it, and distill failures into an actionable
 * summary. This is the cheap "fix -> re-run" step of the agent's test loop:
 * the model runs it, reads `distilled_error`, edits, and calls it again.
 */
export function buildTestLoopTools(ctx: ToolContext) {
  return {
    test_file: tool({
      description:
        "Run the project's test command focused on a single file where the runner supports it (vitest, jest, pytest, go test), returning distilled failure summaries. Use for fast TDD iteration instead of running the whole suite every fix. Requires approval.",
      inputSchema: z.object({
        file: z.string().describe("Relative or absolute path to the test file."),
        command: z
          .string()
          .optional()
          .describe("Optional test command override (e.g. `pnpm test`)."),
      }),
      needsApproval: true,
      execute: async ({ file, command }, { abortSignal }) => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "test_file",
            "Use bash_run on the remote host to run test commands.",
          );
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const filePath = resolvePath(file, ctx.getCwd());
        const root = ctx.getWorkspaceRoot() ?? ctx.getCwd() ?? ".";

        let actual = command ?? null;
        let note = command ? "explicit" : "";
        if (!actual) {
          const resolved = await resolveCheckCommand("test", root);
          actual = resolved.command;
          note = resolved.note;
        }
        if (!actual) {
          return {
            error:
              "could not detect a test runner for this project; pass `command` explicitly.",
          };
        }

        const focused = focusTestFile(actual, filePath);
        const safety = checkShellCommand(focused.command);
        if (!safety.ok) return { error: safety.reason };
        const cwd = ctx.getWorkspaceRoot() ?? ctx.getCwd();

        const shellId = await getSessionShell(
          sessionShellKey("verify", sid, root),
          cwd,
        );
        const onAbort = () => {
          void native.shellSessionInterrupt(shellId).catch(() => {});
        };
        abortSignal?.addEventListener("abort", onAbort, { once: true });
        let r: Awaited<ReturnType<typeof native.shellSessionRun>>;
        try {
          r = await native.shellSessionRun(shellId, focused.command, cwd, 300);
        } finally {
          abortSignal?.removeEventListener("abort", onAbort);
        }
        const combined = `${r.stdout}\n${r.stderr}`.trim();
        // A null exit code means the run was interrupted (timeout/abort);
        // treat it as a failure for the retry budget.
        const exitCode = r.exit_code ?? 1;
        const tracker = trackerFor(sid);
        const attempt = tracker.record(filePath, exitCode);
        const failureSummary =
          exitCode !== 0
            ? (await import("../lib/testLoop")).distillTestOutput(combined)
            : undefined;
        const retry = retryGuidance({
          attempt,
          maxRetries: MAX_TEST_RETRIES,
          exitCode,
        });
        return {
          file: filePath,
          command: focused.command,
          detected: note,
          focus: focused.note,
          stdout: r.stdout,
          stderr: r.stderr,
          exit_code: r.exit_code,
          timed_out: r.timed_out,
          truncated: r.truncated,
          passing: r.exit_code === 0,
          attempt,
          max_retries: MAX_TEST_RETRIES,
          ...(failureSummary
            ? {
                distilled_error: failureSummary,
                should_retry: retry.shouldRetry,
                guidance: retry.guidance,
              }
            : {}),
        };
      },
    }),
  } as const;
}

async function resolveCheckCommand(
  kind: "test",
  root: string | null,
): Promise<{ command: string | null; note: string }> {
  if (!root) return { command: null, note: "no project root" };
  const read = async (name: string) => {
    try {
      const r = (await native.readFile(`${root}/${name}`)) as {
        content?: string;
      };
      return typeof r.content === "string" ? r.content : null;
    } catch {
      return null;
    }
  };
  const manifests = {
    pkgJson: await read("package.json"),
    cargo: await read("Cargo.toml"),
    goMod: await read("go.mod"),
    pyproject: await read("pyproject.toml"),
  };
  return detectCheckCommand(kind, manifests);
}