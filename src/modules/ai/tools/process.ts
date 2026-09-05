import { IS_WINDOWS } from "@/lib/platform";
import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { remoteUnsupported } from "../lib/remoteFs";
import { checkShellCommand } from "../lib/security";
import type { ToolContext } from "./context";

/**
 * Port listener inspection helper (lsof / ss on Unix, Get-NetTCPConnection on Windows).
 */
async function inspectPort(
  port: number,
): Promise<{ port: number; listening: boolean; output: string }> {
  try {
    const cmd = IS_WINDOWS
      ? `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -Property OwningProcess, LocalAddress, LocalPort | Format-Table -AutoSize`
      : `lsof -n -P -iTCP:${port} -sTCP:LISTEN 2>/dev/null || (ss -tulpn 2>/dev/null | grep -E "(:|\\])${port}\\b")`;
    const r = await native.runCommand(cmd, null, 10);
    const text = (r.stdout + (r.stderr ? "\n" + r.stderr : "")).trim();
    const listening = text.length > 0 && r.exit_code === 0;
    return {
      port,
      listening,
      output: text || `Port ${port} is free (no process currently listening).`,
    };
  } catch (e) {
    return {
      port,
      listening: false,
      output: `Could not inspect port: ${String(e)}`,
    };
  }
}

export function buildProcessTools(ctx: ToolContext) {
  return {
    process: tool({
      description:
        "Unified process management tool (Hermes Agent style). Manage long-running background tasks, dev servers, crawlers, watchers, and listeners. Actions: 'spawn' (launch command in background), 'list' (list all managed background processes), 'status' (inspect specific process status, uptime, exit code and latest log snippet), 'logs' (stream logs from offset), 'wait' (block until process exits or timeout), 'kill' (terminate process by handle), 'find_port' (detect which process is listening on a local port).",
      inputSchema: z.object({
        action: z
          .enum([
            "spawn",
            "list",
            "status",
            "logs",
            "wait",
            "kill",
            "find_port",
          ])
          .describe("Action to perform."),
        command: z
          .string()
          .optional()
          .describe("Command to run. Required when action is 'spawn'."),
        cwd: z
          .string()
          .nullable()
          .optional()
          .describe("Working directory. Optional for 'spawn'."),
        handle: z
          .number()
          .int()
          .optional()
          .describe(
            "Background process handle. Required for 'status', 'logs', 'wait', and 'kill'.",
          ),
        since_offset: z
          .number()
          .int()
          .optional()
          .describe("Byte offset to read logs from incrementally. Used with 'logs'."),
        timeout_secs: z
          .number()
          .int()
          .min(1)
          .max(600)
          .optional()
          .describe("Timeout in seconds for 'wait' (default 120)."),
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe("Port number to inspect. Required for 'find_port'."),
      }),
      needsApproval: true,
      execute: async (
        { action, command, cwd, handle, since_offset, timeout_secs, port },
        { abortSignal },
      ) => {
        if (action === "find_port") {
          if (!port) return { error: "action 'find_port' requires 'port'" };
          return inspectPort(port);
        }

        if (action === "list") {
          try {
            const list = await native.shellBgList();
            const now = Date.now();
            return {
              processes: list.map((p) => ({
                handle: p.handle,
                pid: p.pid,
                command: p.command,
                cwd: p.cwd,
                uptime_secs: Math.max(0, Math.round((now - p.started_at_ms) / 1000)),
                exited: p.exited,
                exit_code: p.exit_code,
              })),
            };
          } catch (e) {
            return { error: String(e) };
          }
        }

        if (action === "spawn") {
          if (!command || !command.trim()) {
            return { error: "action 'spawn' requires 'command'" };
          }
          if (ctx.getRemoteSession()) {
            return remoteUnsupported(
              "Background processes",
              "Use bash_run with `nohup CMD > /tmp/out.log 2>&1 &` and read the log file afterwards.",
            );
          }
          const safety = checkShellCommand(command);
          if (!safety.ok) return { error: safety.reason };
          const effectiveCwd = cwd ?? ctx.getWorkspaceRoot() ?? ctx.getCwd();
          try {
            const h = await native.shellBgSpawn(command, effectiveCwd);
            const list = await native.shellBgList().catch(() => []);
            const found = list.find((p) => p.handle === h);
            return {
              handle: h,
              pid: found?.pid ?? null,
              command,
              cwd: effectiveCwd,
              ok: true,
            };
          } catch (e) {
            return { error: String(e) };
          }
        }

        if (handle === undefined) {
          return { error: `action '${action}' requires 'handle'` };
        }

        if (action === "status") {
          try {
            const list = await native.shellBgList();
            const found = list.find((p) => p.handle === handle);
            if (!found) {
              return { error: `No process found with handle ${handle}` };
            }
            const logs = await native.shellBgLogs(handle, 0).catch(() => null);
            const now = Date.now();
            return {
              handle: found.handle,
              pid: found.pid,
              command: found.command,
              cwd: found.cwd,
              uptime_secs: Math.max(
                0,
                Math.round((now - found.started_at_ms) / 1000),
              ),
              exited: found.exited,
              exit_code: found.exit_code,
              log_tail: logs ? logs.bytes.slice(-2000) : "",
              total_bytes: logs ? logs.next_offset : 0,
            };
          } catch (e) {
            return { error: String(e) };
          }
        }

        if (action === "logs") {
          try {
            const r = await native.shellBgLogs(handle, since_offset);
            return r;
          } catch (e) {
            return { error: String(e) };
          }
        }

        if (action === "kill") {
          try {
            await native.shellBgKill(handle);
            return { handle, killed: true, ok: true };
          } catch (e) {
            return { error: String(e) };
          }
        }

        if (action === "wait") {
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
          let accumulatedTail = "";
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
                tail: accumulatedTail,
                note: "aborted by user",
              };
            }
            try {
              last = await native.shellBgLogs(handle, last.next_offset);
              if (last.bytes) {
                accumulatedTail = (accumulatedTail + last.bytes).slice(-4000);
              }
            } catch (e) {
              return { error: String(e) };
            }
            if (last.exited) {
              return {
                handle,
                exited: true,
                exit_code: last.exit_code,
                timed_out: false,
                tail: accumulatedTail,
              };
            }
            if (Date.now() >= deadline) {
              return {
                handle,
                exited: false,
                exit_code: null,
                timed_out: true,
                tail: accumulatedTail,
                note: "still running - call process wait again, or kill to stop it",
              };
            }
            await sleep(500);
          }
        }

        return { error: `Unsupported action: ${String(action)}` };
      },
    }),

    process_port: tool({
      description:
        "Check which process or command is currently listening on a specific TCP port (e.g. 3000, 5173, 8080). Useful when a dev server or test service fails with EADDRINUSE (port already in use). Auto-executes.",
      inputSchema: z.object({
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .describe("The TCP port number to inspect, e.g. 3000 or 5173."),
      }),
      execute: async ({ port }) => {
        return inspectPort(port);
      },
    }),
  } as const;
}
