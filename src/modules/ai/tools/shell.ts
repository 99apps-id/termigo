import { usePreferencesStore } from "@/modules/settings/preferences";
import { sshExec } from "@/modules/ssh/bridge";
import { currentWorkspaceEnv, workspaceScopeKey } from "@/modules/workspace";
import { tool } from "./toolShim";
import { z } from "zod";
import { native } from "../lib/native";
import { getSessionShell } from "../lib/sessionShell";
import { checkPentestCommand } from "../lib/pentestScope";
import { remoteUnsupported } from "../lib/remoteFs";
import { shellQuote } from "../lib/remoteSearch";
import { checkShellCommand } from "../lib/security";
import { clampedInt } from "./clampedNumber";
import type { ToolContext } from "./context";

/**
 * Both shell tools run the safety deny-list AND the pentest scope fence: an
 * offensive tool (nmap, ffuf, sqlmap, ...) aimed at a host outside the
 * authorized scope is refused, and denial-of-service tooling is refused
 * outright. Ordinary commands pass untouched.
 */
/**
 * Marker `normalizeShellCommand` appends when a quote is never closed.
 * Checked here so the refusal names the cause instead of letting the shell
 * report a bare syntax error for scrambled text.
 */
export const UNCLOSED_QUOTE_SENTINEL = "[termigo: unclosed quote in command]";

/**
 * Package-manager MUTATIONS: commands that rewrite node_modules / site-packages
 * while they run. Killing one mid-flight is not a neutral "try again" — pnpm
 * prunes before it links, so a timeout-killed `pnpm install` leaves the tree
 * half-removed with dangling `.bin` shims, and every later check ("biome is not
 * installed") is then true until a full reinstall. Observed in the field: a
 * model-chosen `timeout_secs: 10` on `pnpm install` corrupted the workspace's
 * node_modules and every verification after it failed.
 */
const PACKAGE_MUTATION_RE =
  /^\s*(?:(?:pnpm|npm|yarn|bun)\s+(?:install|i|ci|add|remove|uninstall|update|upgrade|prune|rebuild|dedupe|link|unlink)\b|pnpm\s*$|yarn\s*$|pip3?\s+install\b|uv\s+(?:sync|add|remove|pip\s+install)\b|poetry\s+(?:install|add|remove|update)\b)/i;

/** Commands that are merely SLOW to start; a short kill is harmless. */
const SLOW_START_RE = /^\s*(?:cargo|git\s+clone|rustc)\b/i;

/**
 * The timeout a command actually gets.
 *
 * Package-manager mutations carry a FLOOR the model cannot go under: no install
 * finishes in 10s, so a short request is always a mistake, and its only outcome
 * is a corrupted dependency tree. Everything else honours the requested value
 * (clamped by the schema) or falls back to the old defaults. Pure, so the
 * policy is asserted rather than discovered in the field again.
 */
export function resolveCommandTimeout(
  command: string,
  requested?: number,
): number {
  if (PACKAGE_MUTATION_RE.test(command)) {
    return Math.max(requested ?? 0, 300);
  }
  return requested ?? (SLOW_START_RE.test(command) ? 300 : 120);
}

export function screenCommand(
  command: string,
): { ok: true } | { ok: false; reason: string } {
  // Trailing-comment anchor, not a substring: the normalizer appends the
  // sentinel as ` # <sentinel>`, while a balanced command that merely
  // mentions the text (e.g. echoing it) must keep working.
  if (command.trimEnd().endsWith(`# ${UNCLOSED_QUOTE_SENTINEL}`)) {
    return {
      ok: false,
      reason: "Refused: the command has an unclosed quote. Close the quote and try again.",
    };
  }
  const safety = checkShellCommand(command);
  if (!safety.ok) return safety;
  const prefs = usePreferencesStore.getState();
  // Scope is enforced only when the user opted in; otherwise the fence just
  // refuses denial-of-service tooling and lets every target through.
  const scope = prefs.enforcePentestScope ? prefs.pentestScope : [];
  return checkPentestCommand(command, scope);
}

export function workspaceSessionKey(
  sessionId: string,
  cwd?: string | null,
): string {
  return `${sessionId}:${workspaceScopeKey(currentWorkspaceEnv())}:${cwd ?? "default"}`;
}

/**
 * Cap command output returned to the model to prevent prompt context bloat.
 * Preserves the beginning (head) and end (tail) of output when it exceeds maxChars.
 */
export function truncateCommandOutput(
  text: string,
  maxChars = 4000,
  headLines = 25,
  tailLines = 25,
): { text: string; truncated: boolean } {
  if (!text || text.length <= maxChars) {
    return { text, truncated: false };
  }

  const lines = text.split("\n");
  if (lines.length <= headLines + tailLines) {
    const half = Math.floor(maxChars / 2);
    const head = text.slice(0, half);
    const tail = text.slice(-half);
    return {
      text: `${head}\n\n... [Output truncated: ${text.length - maxChars} characters omitted] ...\n\n${tail}`,
      truncated: true,
    };
  }

  const head = lines.slice(0, headLines).join("\n");
  const tail = lines.slice(-tailLines).join("\n");
  const omittedLines = lines.length - (headLines + tailLines);
  return {
    text: `${head}\n\n... [Output truncated: ${omittedLines} lines omitted (${text.length} chars total). Use specific filters, line ranges, or search queries] ...\n\n${tail}`,
    truncated: true,
  };
}

/**
 * Unwraps redundant `powershell [-NoProfile] [-Command] "<script>"` wrappers.
 *
 * When running on Windows, Termigo's persistent shell session is already PowerShell.
 * If the model runs `powershell -NoProfile -Command "$c = ...; $c[500..720]..."`,
 * the outer PowerShell parses the argument as a double-quoted expandable string,
 * expanding variables like `$c` to empty strings and causing parser errors such as
 * "Missing type name after '['". Unwrapping allows the command to run directly in the
 * active PowerShell process without nested double-quote variable interpolation.
 */
export function unwrapPowershellCommand(command: string): string {
  const trimmed = command.trim();
  const match = trimmed.match(
    /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:-(?:NoProfile|NonInteractive|ExecutionPolicy\s+\S+|WindowStyle\s+\S+|STA|MTA)\s+)*(?:-(?:Command|c)\s+)?([\s\S]+)$/i,
  );
  if (!match) return command;

  const script = match[1].trim();

  // If wrapped in script block `{ ... }`
  if (script.startsWith("{") && script.endsWith("}")) {
    return script.slice(1, -1).trim();
  }

  // If wrapped in double quotes `"..."`
  if (script.startsWith('"') && script.endsWith('"') && script.length >= 2) {
    const unquoted = script.slice(1, -1);
    return unquoted.replace(/\\"/g, '"').replace(/""/g, '"');
  }

  // If wrapped in single quotes `'...'`
  if (script.startsWith("'") && script.endsWith("'") && script.length >= 2) {
    const unquoted = script.slice(1, -1);
    return unquoted.replace(/''/g, "'");
  }

  return script;
}

/**
 * Normalizes multi-line and indented commands so standard scripts or copy-pasted
 * statements can pass the single-line shell validator safely without being rejected
 * for C0 control characters. Tabs outside quotes are replaced with spaces, and
 * newlines outside quotes are converted to `; `.
 */
export function normalizeShellCommand(command: string): string {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  let out = "";
  const trimmed = command.trim();

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      out += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      out += ch;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      out += ch;
      continue;
    }
    if (!inDouble && !inSingle) {
      if (ch === "\t") {
        out += " ";
        continue;
      }
      if (ch === "\r") {
        continue;
      }
      if (ch === "\n") {
        const trimmedOut = out.trimEnd();
        if (
          trimmedOut.length > 0 &&
          !trimmedOut.endsWith(";") &&
          !trimmedOut.endsWith("&&") &&
          !trimmedOut.endsWith("||") &&
          !trimmedOut.endsWith("|")
        ) {
          out = `${trimmedOut} ; `;
        } else {
          out = `${trimmedOut} `;
        }
        continue;
      }
    }
    out += ch;
  }
  // If a quote was opened but never closed the output is garbled. Return a
  // sentinel value `screenCommand` detects rather than silently passing
  // scrambled text to the shell.
  if (inDouble || inSingle) {
    return `${out.trim()} # ${UNCLOSED_QUOTE_SENTINEL}`;
  }
  return out.trim();
}

export function buildShellTools(ctx: ToolContext) {
  return {
    bash_run: tool({
      description:
        "Run a foreground shell command. When the active terminal is an SSH session the command runs ON THE REMOTE HOST, from the remote shell's working directory, and always asks for approval regardless of the approval mode. Otherwise it runs in this session's persistent local shell, where cwd persists across calls. The shell's PATH includes the project's node_modules/.bin (and every ancestor's), so locally installed tools run directly by name: vitest, biome, tsc, eslint, prettier, etc. NEVER install a package that the project already has — check package.json / node_modules first; a 'not recognized' error means a wrong name or cwd, not a missing package. Use for short-lived commands (build, install, service restarts, a quick grep). Allowlisted (supported with user approval): package managers (apt, dnf, yum, brew, pip, uv, winget, choco, etc.), package runners (npx, bunx, yarnpkg), container engines (docker, podman), database CLIs (psql, mysql, sqlite3, redis-cli), project toolchains (prisma, next, vite, drizzle-kit, tsx, rustc), build utilities (rimraf, cross-env, concurrently, tree), PowerShell cmdlets (Get-ChildItem, Get-Content, Set-Content, Get-Command, Test-Path, Select-Object, Where-Object, Start-Service, etc.), and privilege elevation (sudo, doas, su, wsl). Commands may be chained with ;, &&, ||, or pipelines (|); each segment is validated against the allowlist. Stderr redirection (2>&1) and output discard (> /dev/null, > nul, 2>nul) are supported. To save output to a file, pipe to Out-File <file> (PowerShell) or tee <file> (Unix). For project-wide lint/test use run_checks instead (defaults to 300s). For long-running local daemons use bash_background. NEVER invoke interactive tools (vim, less, top) — they will hang. To FIND files, use the glob tool (fast, ignores node_modules/.git, capped) — a recursive shell scan (Get-ChildItem -Recurse, find, dir /s) from a large or home directory can time out. If cmd is specifically required for batch scripts or DOS commands, invoke it explicitly via cmd /c ... You are ALREADY inside a persistent PowerShell session on Windows: do NOT prefix commands with powershell -Command \"...\" — run PowerShell commands directly (e.g. Get-Content ...).",
      inputSchema: z.object({
        command: z.string(),
        timeout_secs: clampedInt(1, 900).describe(
          "Timeout in seconds. Default 120. Clamped up to 900. Package-manager installs (pnpm/npm/yarn install, add, ...) are floored at 300s: killing one mid-run corrupts the dependency tree. For a from-scratch install on a slow network use bash_background + bash_wait instead.",
        ),
      }),
      needsApproval: true,
      execute: async ({ command, timeout_secs }, { abortSignal }) => {
        const effectiveTimeout = resolveCommandTimeout(command, timeout_secs);
        const normalized = normalizeShellCommand(command);
        // Unwrap BEFORE screening on every path: screening the wrapper only
        // sees `powershell`/`bash` (never offensive) while the inner script
        // runs unchecked. The wrapper is kept for execution below.
        const effectiveCommand = unwrapPowershellCommand(normalized);
        // With an SSH terminal focused the model means the server, so the
        // command runs there. This one always asks, in every approval mode:
        // see REMOTE_ALWAYS_ASK in approvalPolicy. The safety check above ran
        // first and applies to both machines.
        const remote = ctx.getRemoteSession();
        const hasWindowsDrive = /[a-zA-Z]:[/\\]/.test(normalized);
        if (remote && !hasWindowsDrive) {
          // Run from the shell's own directory. The exec channel starts in the
          // SSH user's home, so `docker compose up` would otherwise run
          // somewhere other than the project the user is looking at.
          const safety = screenCommand(effectiveCommand);
          if (!safety.ok) return { error: safety.reason };
          const full = remote.cwd
            ? `cd ${shellQuote(remote.cwd)} && ${normalized}`
            : normalized;
          try {
            const out = await sshExec(remote.sessionId, full, timeout_secs);
            const isSilentSuccess = !out.stdout && !out.stderr && out.exitCode === 0;
            const stdoutTrunc = truncateCommandOutput(out.stdout ?? "");
            const stderrTrunc = truncateCommandOutput(out.stderr ?? "");
            return {
              command,
              remote: true,
              cwd: remote.cwd,
              stdout: stdoutTrunc.text,
              stderr: stderrTrunc.text,
              exit_code: out.exitCode,
              truncated: out.truncated || stdoutTrunc.truncated || stderrTrunc.truncated,
              ...(isSilentSuccess
                ? { info: "Command completed successfully with no output (exit code 0)." }
                : {}),
              // Say where it ran when that is not what the model would assume.
              // A shell the OSC 7 hook does not fit (fish, dash) reports no
              // directory, so the command runs from the SSH user's home and a
              // relative path silently means something else.
              ...(remote.cwd
                ? {}
                : {
                    note: "the remote shell has not reported a working directory, so this ran from the SSH user's home; use absolute paths",
                  }),
            };
          } catch (e) {
            const errStr = String(e);
            if (/no ssh session|session.*closed|not found/i.test(errStr)) {
              // Remote SSH session is disconnected or closed; drop the stale
              // remote anchor and return the error. A command that the agent
              // issued while an SSH terminal was focused was meant for the
              // server, and silently running it on this machine is exactly
              // the failure the remote routing exists to prevent.
              ctx.clearRemoteSession?.();
              return {
                error: `${errStr} (not run locally: the command was meant for the remote host)`,
                command,
                remote: true,
              };
            }
            return { error: errStr, command, remote: true };
          }
        }

        const safety = screenCommand(effectiveCommand);
        if (!safety.ok) return { error: safety.reason };

        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        try {
          // Project-first cwd (BatikCode parity): a command the agent runs is
          // usually about the workspace, so anchor it at the workspace root and
          // fall back to the terminal cwd, then home. Anchoring only at the
          // active terminal's cwd made `git status` / `ls` report the wrong
          // tree whenever the focused terminal was somewhere else (home, a
          // subdir, an unrelated repo). The persistent shell still lets a
          // command `cd` and keep that directory for the next call.
          const cwd = ctx.getWorkspaceRoot() ?? ctx.getCwd();
          const shellId = await getSessionShell(
            workspaceSessionKey(sid, cwd),
            cwd,
          );

          // Stop has to reach the command, not just the model stream. Without
          // this the run was marked stopped while the shell kept going, and
          // anything the user had queued waited for a command nobody was
          // watching any more.
          const onAbort = () => {
            void native.shellSessionInterrupt(shellId).catch(() => {});
          };
          if (abortSignal?.aborted) {
            onAbort();
          } else {
            abortSignal?.addEventListener("abort", onAbort, { once: true });
          }

          let r: Awaited<ReturnType<typeof native.shellSessionRun>>;
          try {
            r = await native.shellSessionRun(
              shellId,
              effectiveCommand,
              cwd,
              effectiveTimeout,
            );
          } finally {
            abortSignal?.removeEventListener("abort", onAbort);
          }
          const isSilentSuccess = !r.stdout && !r.stderr && r.exit_code === 0;
          const stdoutTrunc = truncateCommandOutput(r.stdout ?? "");
          const stderrTrunc = truncateCommandOutput(r.stderr ?? "");
          return {
            command: effectiveCommand,
            stdout: stdoutTrunc.text,
            stderr: stderrTrunc.text,
            exit_code: r.exit_code,
            timed_out: r.timed_out,
            truncated: r.truncated || stdoutTrunc.truncated || stderrTrunc.truncated,
            cwd_after: r.cwd_after,
            ...(isSilentSuccess
              ? { info: "Command completed successfully with no output (exit code 0)." }
              : {}),
            ...(r.timed_out
              ? {
                  hint: PACKAGE_MUTATION_RE.test(effectiveCommand)
                    ? `Package install timed out after ${effectiveTimeout}s and was KILLED mid-run — the dependency tree may now be half-removed (bins present but packages missing). Do NOT conclude packages are uninstalled. Re-run the same install to completion (it resumes), or run it via bash_background and bash_wait. If the tree is already broken, remove node_modules/.modules-state by reinstalling: pnpm install after deleting node_modules.`
                    : `Command timed out after ${effectiveTimeout}s. If this is a long-running process (like a server, watcher, or interactive script), use bash_background instead of bash_run.`,
                }
              : {}),
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    bash_background: tool({
      description:
        "Spawn a long-running background process (e.g. `pnpm dev`, `cargo watch`, log tailers). Returns a handle; use `bash_wait` to block until it finishes (builds, installs), `bash_logs` to read its output while it runs, and `bash_kill` to stop it. Output is captured into a 4MB ring buffer. Asks for user approval.",
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string().nullable().optional(),
      }),
      needsApproval: true,
      execute: async ({ command, cwd }) => {
        // bash_run drives a LOCAL shell session. With an SSH terminal focused
        // the model means the server, and running `rm -rf build` on this
        // machine instead is exactly the failure the remote routing exists to
        // prevent. suggest_command is the honest route: it lands the command
        // at the remote prompt for the user to run.
        // The exec channel is one-shot: it runs a command and closes. There is
        // no remote process registry to list, tail or kill, so a "background"
        // remote job would be one this app could never report on again.
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "Background processes",
            "Use bash_run with `nohup CMD > /tmp/out.log 2>&1 &` and read the log file afterwards.",
          );
        }
        const effectiveCommand = unwrapPowershellCommand(command);
        const safety = screenCommand(effectiveCommand);
        if (!safety.ok) return { error: safety.reason };
        // Project-first cwd, matching bash_run: a model-supplied cwd wins, else
        // the workspace root, else the terminal cwd.
        const effectiveCwd = cwd ?? ctx.getWorkspaceRoot() ?? ctx.getCwd();
        try {
          const handle = await native.shellBgSpawn(effectiveCommand, effectiveCwd);
          return { handle, command: effectiveCommand, cwd: effectiveCwd, ok: true };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    bash_logs: tool({
      description:
        "Read accumulated logs from a `bash_background` process. Pass `since_offset` from the previous response's `next_offset` to tail incrementally. `dropped` reports bytes evicted by the ring buffer. To block until the process finishes, use `bash_wait`.",
      inputSchema: z.object({
        handle: z.number().int(),
        since_offset: z.number().int().optional(),
      }),
      execute: async ({ handle, since_offset }) => {
        try {
          const r = await native.shellBgLogs(handle, since_offset);
          return r;
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    bash_wait: tool({
      description:
        "Wait for a `bash_background` process to exit (a build, an install, a test run), polling its log. Returns the final `exit_code` and the last log tail, or `timed_out: true` while it is still running - call again to keep waiting, or `bash_logs` to read progress meanwhile. Auto-executes.",
      inputSchema: z.object({
        handle: z.number().int(),
        timeout_secs: clampedInt(1, 900).describe(
          "How long to wait for exit before returning timed_out (default 120, clamped up to 900).",
        ),
      }),
      execute: async (
        { handle, timeout_secs },
        { abortSignal }: { abortSignal?: AbortSignal } = {},
      ) => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "Background processes",
            "Use bash_run with `nohup CMD > /tmp/out.log 2>&1 &` and read the log file afterwards.",
          );
        }
        if (abortSignal?.aborted) {
          return { handle, exited: false, timed_out: true, note: "aborted" };
        }
        const deadline = Date.now() + (timeout_secs ?? 120) * 1000;
        const sleep = (ms: number) =>
          new Promise((r) => {
            if (abortSignal?.aborted) return r(undefined);
            const t = setTimeout(r, ms);
            abortSignal?.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                r(undefined);
              },
              { once: true },
            );
          });
        // shell_bg_logs reports `exited` + `exit_code` without a separate
        // registry call, so one poll shape serves both "still running" and
        // "done". Keep the tail of the last read so a finished build's output
        // arrives with the exit code instead of needing a follow-up bash_logs.
        let last = {
          bytes: "",
          next_offset: 0,
          dropped: 0,
          exited: false,
          exit_code: null as number | null,
        };
        for (;;) {
          if (abortSignal?.aborted) {
            return {
              handle,
              exited: last.exited,
              exit_code: last.exit_code,
              timed_out: true,
              tail: last.bytes.slice(-4000),
              note: "aborted by user",
            };
          }
          try {
            last = await native.shellBgLogs(handle, last.next_offset);
          } catch (e) {
            return { error: String(e) };
          }
          if (last.exited) {
            return {
              handle,
              exited: true,
              exit_code: last.exit_code,
              timed_out: false,
              tail: last.bytes.slice(-4000),
            };
          }
          if (Date.now() >= deadline) {
            return {
              handle,
              exited: false,
              exit_code: null,
              timed_out: true,
              tail: last.bytes.slice(-4000),
              note: "still running - call bash_wait again, or bash_kill to stop it",
            };
          }
          await sleep(500);
        }
      },
    }),

    bash_list: tool({
      description:
        "List all background processes spawned by `bash_background` in this app - running and exited. **Always call this BEFORE spawning a new long-running process** (especially dev servers like `pnpm dev`, `next dev`, `vite`) to avoid duplicates. If a matching process is already running, reuse it (call `open_preview` again instead of respawning). Auto-executes.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const list = await native.shellBgList();
          return { processes: list };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    bash_kill: tool({
      description:
        "Terminate a `bash_background` process by handle. Idempotent - kills nothing if the handle is unknown or already exited.",
      inputSchema: z.object({ handle: z.number().int() }),
      execute: async ({ handle }) => {
        try {
          await native.shellBgKill(handle);
          return { handle, ok: true };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  } as const;
}
