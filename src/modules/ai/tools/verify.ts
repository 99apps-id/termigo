import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { checkShellCommand } from "../lib/security";
import { remoteUnsupported } from "../lib/remoteFs";
import { getSessionShell, sessionShellKey } from "../lib/sessionShell";
import { quoteShellArg } from "@/lib/shellQuote";
import type { ToolContext } from "./context";

type CheckKind = "test" | "lint";

/** First file extension, lowercased, or "" when there is none. */
function extOf(paths: string[]): string {
  const base = (paths[0] || "").split(/[\\/]/).pop() ?? "";
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1).toLowerCase() : "";
}

/** Pure formatter command resolver, exported so the detection is testable. */
export function formatCommand(paths: string[]): {
  command: string;
  note: string;
} {
  const quoted = paths.map((p) => quoteShellArg(p)).join(" ");
  switch (extOf(paths)) {
    case "rs":
      return { command: `rustfmt ${quoted}`, note: "rustfmt" };
    case "go":
      return { command: `gofmt -w ${quoted}`, note: "gofmt" };
    case "py":
      return { command: `ruff format ${quoted}`, note: "ruff format" };
    default:
      // TS/JS/JSON/CSS/Markdown and anything unknown: this client is the
      // pnpm term, and biome is its formatter.
      return {
        command: `pnpm exec biome format --write ${quoted}`,
        note: "biome format (pnpm)",
      };
  }
}

/** Read the file if it exists; null when not present or unreadable. */
async function tryRead(root: string, name: string): Promise<string | null> {
  try {
    const r = (await native.readFile(`${root}/${name}`)) as {
      content?: string;
    };
    return typeof r.content === "string" ? r.content : null;
  } catch {
    return null;
  }
}

function packageManager(raw: string | null): string {
  if (!raw) return "pnpm";
  const m = raw.match(/"packageManager"\s*:\s*"([^@"]+)/);
  return m?.[1] ?? "pnpm";
}

function scriptCommand(pkgJson: string | null, kind: CheckKind): string | null {
  if (!pkgJson) return null;
  try {
    const pkg = JSON.parse(pkgJson) as { scripts?: Record<string, string> };
    const script = kind === "test" ? pkg.scripts?.test : pkg.scripts?.lint;
    return typeof script === "string" && script.trim() ? script.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the project's test / lint command without the model having to guess
 * the runner. Returns `{ command, note }` where `note` explains a fallback so
 * the agent (and the user reading the approval card) can tell what was picked.
 */
async function resolveCheckCommand(
  kind: CheckKind,
  root: string | null,
): Promise<{ command: string | null; note: string }> {
  if (!root) {
    return { command: null, note: "no project root; pass `command` explicitly" };
  }
  const manifests = {
    pkgJson: await tryRead(root, "package.json"),
    cargo: await tryRead(root, "Cargo.toml"),
    goMod: await tryRead(root, "go.mod"),
    pyproject: await tryRead(root, "pyproject.toml"),
  };
  return detectCheckCommand(kind, manifests);
}

type Manifests = {
  pkgJson: string | null;
  cargo: string | null;
  goMod: string | null;
  pyproject: string | null;
};

/** Pure command resolver, split out so the detection rules are testable. */
export function detectCheckCommand(
  kind: CheckKind,
  manifests: Manifests,
): { command: string | null; note: string } {
  const { pkgJson, cargo, goMod, pyproject } = manifests;
  if (pkgJson) {
    const script = scriptCommand(pkgJson, kind);
    if (script) {
      // A script like `"test": "vitest run"` already carries the runner, so
      // run it directly. `"test": "run test:unit"` style also runs as-is.
      const pm = packageManager(pkgJson);
      return { command: script, note: `package.json script (${pm})` };
    }
  }
  if (cargo) {
    return kind === "test"
      ? { command: "cargo test", note: "Cargo.toml" }
      : {
          command: "cargo clippy --all-targets -- -D warnings",
          note: "Cargo.toml (clippy)",
        };
  }
  if (goMod) {
    return kind === "test"
      ? { command: "go test ./...", note: "go.mod" }
      : { command: "go vet ./...", note: "go.mod" };
  }
  if (pyproject) {
    return kind === "test"
      ? { command: "python -m pytest", note: "pyproject.toml (pytest)" }
      : { command: "ruff check .", note: "pyproject.toml (ruff)" };
  }
  return {
    command: null,
    note:
      "could not detect a test/lint runner from package.json, Cargo.toml, go.mod or pyproject.toml; pass `command` explicitly",
  };
}

export function buildVerifyTools(ctx: ToolContext) {
  return {
    run_checks: tool({
      description:
        "Detect and run this project's test or lint command, returning the output. Use after editing code so the agent sees the result and can fix failures itself (the verification step of read -> change -> verify). Chooses the right runner from package.json / Cargo.toml / go.mod / pyproject.toml. Pass `command` to override the detected one. Runs locally in the workspace; use bash_run on an SSH terminal. Requires approval.",
      inputSchema: z.object({
        kind: z.enum(["test", "lint"]).describe("Run tests, or run the linter."),
        command: z
          .string()
          .optional()
          .describe(
            "Override the detected command, e.g. `pnpm test ui` or `cargo test --lib`.",
          ),
        timeout_secs: z.number().int().min(1).max(600).optional(),
      }),
      needsApproval: true,
      execute: async ({ kind, command, timeout_secs }, { abortSignal }) => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "run_checks",
            "Use bash_run when the active terminal is an SSH session.",
          );
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };

        const root = ctx.getWorkspaceRoot();
        let actualCommand = command ?? null;
        let note = command ? "explicit" : "";
        if (!actualCommand) {
          const resolved = await resolveCheckCommand(kind, root);
          actualCommand = resolved.command;
          note = resolved.note;
        }
        if (!actualCommand) {
          return {
            error: `no ${kind} command detected; ${note}. Pass \`command\` explicitly.`,
          };
        }

        const safety = checkShellCommand(actualCommand);
        if (!safety.ok) return { error: safety.reason };

        // Run at the workspace root, not the terminal cwd: a project-wide check
        // (`cargo test`, `go test ./...`, `vitest run`) must cover the whole
        // repo, and the manifest we detected the command from lives there.
        const cwd = root ?? ctx.getCwd();
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
          r = await native.shellSessionRun(
            shellId,
            actualCommand,
            cwd,
            timeout_secs ?? 300,
          );
        } finally {
          abortSignal?.removeEventListener("abort", onAbort);
        }
        const combined = `${r.stdout}\n${r.stderr}`.trim();
        const failureSummary =
          r.exit_code !== 0
            ? (await import("../lib/testLoop")).distillTestOutput(combined)
            : undefined;

        return {
          command: actualCommand,
          kind,
          note,
          cwd,
          stdout: r.stdout,
          stderr: r.stderr,
          exit_code: r.exit_code,
          timed_out: r.timed_out,
          truncated: r.truncated,
          distilled_error: failureSummary,
        };
      },
    }),

    format_code: tool({
      description:
        "Auto-format the given files with the project's formatter (rustfmt / gofmt / ruff / biome). Use after editing to keep the change clean and match the repo style. Requires approval.",
      inputSchema: z.object({
        paths: z
          .array(z.string())
          .min(1)
          .describe("Files to format, e.g. ['src/App.tsx']."),
      }),
      needsApproval: true,
      execute: async ({ paths }) => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "format_code",
            "Use bash_run on the remote host to format files.",
          );
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = ctx.getWorkspaceRoot() ?? ctx.getCwd() ?? ".";
        const { command, note } = formatCommand(paths);
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        try {
          const shellId = await getSessionShell(
            sessionShellKey("verify", sid, ctx.getWorkspaceRoot()),
            cwd,
          );
          const r = await native.shellSessionRun(shellId, command, cwd, 120);
          return {
            command,
            formatter: note,
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
