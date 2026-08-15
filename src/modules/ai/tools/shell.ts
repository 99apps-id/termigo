import { remoteUnsupported } from "../lib/remoteFs";
import { shellQuote } from "../lib/remoteSearch";
import { sshExec } from "@/modules/ssh/bridge";
import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { checkShellCommand } from "../lib/security";
import type { ToolContext } from "./context";
import { currentWorkspaceEnv, workspaceScopeKey } from "@/modules/workspace";

/**
 * Per-session lazy shell-session id. The agent gets one persistent shell per
 * chat session, so cwd survives across tool calls (cd, mkdir+cd, etc).
 */
const sessionShells = new Map<string, Promise<number>>();

async function getSessionShell(
  sessionId: string,
  cwd: string | null,
): Promise<number> {
  let p = sessionShells.get(sessionId);
  if (!p) {
    p = native.shellSessionOpen(cwd);
    sessionShells.set(sessionId, p);
  }
  return p;
}

function workspaceSessionKey(sessionId: string): string {
  return `${sessionId}:${workspaceScopeKey(currentWorkspaceEnv())}`;
}

export function buildShellTools(ctx: ToolContext) {
  return {
    bash_run: tool({
      description:
        "Run a foreground shell command. When the active terminal is an SSH session the command runs ON THE REMOTE HOST, from the remote shell's working directory, and always asks for approval regardless of the approval mode. Otherwise it runs in this session's persistent local shell, where cwd persists across calls. Use for short-lived commands (lint, test, build, install, service restarts). For long-running local daemons use `bash_background`. NEVER invoke interactive tools (vim, less, top) — they will hang.",
      inputSchema: z.object({
        command: z.string(),
        timeout_secs: z.number().int().min(1).max(300).optional(),
      }),
      needsApproval: true,
      execute: async ({ command, timeout_secs }, { abortSignal }) => {
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };

        // With an SSH terminal focused the model means the server, so the
        // command runs there. This one always asks, in every approval mode:
        // see REMOTE_ALWAYS_ASK in approvalPolicy. The safety check above ran
        // first and applies to both machines.
        const remote = ctx.getRemoteSession();
        if (remote) {
          // Run from the shell's own directory. The exec channel starts in the
          // SSH user's home, so `docker compose up` would otherwise run
          // somewhere other than the project the user is looking at.
          const full = remote.cwd
            ? `cd ${shellQuote(remote.cwd)} && ${command}`
            : command;
          try {
            const out = await sshExec(remote.sessionId, full, timeout_secs);
            return {
              command,
              remote: true,
              cwd: remote.cwd,
              stdout: out.stdout,
              stderr: out.stderr,
              exit_code: out.exitCode,
              truncated: out.truncated,
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
            return { error: String(e), command, remote: true };
          }
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        try {
          const cwd = ctx.getCwd();
          const shellId = await getSessionShell(workspaceSessionKey(sid), cwd);

          // Stop has to reach the command, not just the model stream. Without
          // this the run was marked stopped while the shell kept going, and
          // anything the user had queued waited for a command nobody was
          // watching any more.
          const onAbort = () => {
            void native.shellSessionInterrupt(shellId).catch(() => {});
          };
          abortSignal?.addEventListener("abort", onAbort, { once: true });

          let r: Awaited<ReturnType<typeof native.shellSessionRun>>;
          try {
            r = await native.shellSessionRun(shellId, command, cwd, timeout_secs);
          } finally {
            abortSignal?.removeEventListener("abort", onAbort);
          }
          return {
            command,
            stdout: r.stdout,
            stderr: r.stderr,
            exit_code: r.exit_code,
            timed_out: r.timed_out,
            truncated: r.truncated,
            cwd_after: r.cwd_after,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    bash_background: tool({
      description:
        "Spawn a long-running background process (e.g. `pnpm dev`, `cargo watch`, log tailers). Returns a handle; use `bash_logs` to read its output and `bash_kill` to stop it. Output is captured into a 4MB ring buffer. Asks for user approval.",
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
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        const effectiveCwd = cwd ?? ctx.getCwd();
        try {
          const handle = await native.shellBgSpawn(command, effectiveCwd);
          return { handle, command, cwd: effectiveCwd, ok: true };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    bash_logs: tool({
      description:
        "Read accumulated logs from a `bash_background` process. Pass `since_offset` from the previous response's `next_offset` to tail incrementally. `dropped` reports bytes evicted by the ring buffer.",
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

    bash_list: tool({
      description:
        "List all background processes spawned by `bash_background` in this app — running and exited. **Always call this BEFORE spawning a new long-running process** (especially dev servers like `pnpm dev`, `next dev`, `vite`) to avoid duplicates. If a matching process is already running, reuse it (call `open_preview` again instead of respawning). Auto-executes.",
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
        "Terminate a `bash_background` process by handle. Idempotent — kills nothing if the handle is unknown or already exited.",
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
