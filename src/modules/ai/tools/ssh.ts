import { tool } from "ai";
import { z } from "zod";
import { sshExec } from "@/modules/ssh/bridge";
import {
  listConnections,
  newConnectionId,
  upsertConnection,
  type SshConnection,
} from "@/modules/ssh/connections";
import { useSshActiveSessionStore } from "@/modules/ssh/sshActiveSession";
import { screenCommand, truncateCommandOutput } from "./shell";
import { shellQuote } from "../lib/remoteSearch";
import type { ToolContext } from "./context";

/** Safe summary of a saved SSH connection with secrets withheld. */
export type SafeSshConnectionSummary = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  authMode: string;
  hasPassword: boolean;
  hasPrivateKey: boolean;
  hasKeyPassphrase: boolean;
  description?: string;
  lastConnectedAt?: number;
};

function toSafeSummary(c: SshConnection): SafeSshConnectionSummary {
  return {
    id: c.id,
    name: c.name,
    host: c.host,
    port: c.port,
    user: c.user,
    authMode: c.authMode,
    hasPassword: c.hasPassword,
    hasPrivateKey: c.hasPrivateKey,
    hasKeyPassphrase: c.hasKeyPassphrase,
    description: c.description,
    lastConnectedAt: c.lastConnectedAt,
  };
}

async function waitForActiveSession(
  expectedConnectionId: string,
  timeoutMs = 4000,
): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = useSshActiveSessionStore.getState().session;
    if (s && s.connectionId === expectedConnectionId) {
      return s.sessionId;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return useSshActiveSessionStore.getState().session?.sessionId ?? null;
}

export function buildSshTools(ctx: ToolContext) {
  return {
    ssh_list_connections: tool({
      description:
        "List all saved SSH connections (remote servers, VPS) and get the status of any currently active SSH session. Read-only, auto-executes.",
      inputSchema: z.object({
        filter: z
          .string()
          .optional()
          .describe(
            "Optional search filter matching connection name, host, or user.",
          ),
      }),
      execute: async ({ filter }) => {
        try {
          const all = await listConnections();
          let filtered = all;
          if (filter?.trim()) {
            const needle = filter.trim().toLowerCase();
            filtered = all.filter(
              (c) =>
                c.name.toLowerCase().includes(needle) ||
                c.host.toLowerCase().includes(needle) ||
                c.user.toLowerCase().includes(needle),
            );
          }
          const summaries = filtered.map(toSafeSummary);

          const remote = ctx.getRemoteSession();
          const activeStore = useSshActiveSessionStore.getState().session;
          const activeSession = remote
            ? {
                sessionId: remote.sessionId,
                cwd: remote.cwd,
                hostLabel: activeStore?.hostLabel ?? "connected-host",
                connectionId: activeStore?.connectionId ?? null,
              }
            : activeStore
              ? {
                  sessionId: activeStore.sessionId,
                  cwd: null,
                  hostLabel: activeStore.hostLabel,
                  connectionId: activeStore.connectionId,
                }
              : null;

          return {
            count: summaries.length,
            connections: summaries,
            active_session: activeSession,
          };
        } catch (err) {
          return { error: `Failed to list SSH connections: ${String(err)}` };
        }
      },
    }),

    ssh_connect: tool({
      description:
        "Connect to a remote server or VPS via SSH. Opens an SSH terminal tab in Termigo so that the agent and user have a live SSH session. Specify `connection_id` or `name` to connect to a saved host, or pass `host`, `port`, `user` for direct connections. Asks for approval.",
      inputSchema: z.object({
        connection_id: z
          .string()
          .optional()
          .describe(
            "ID of a saved connection from ssh_list_connections (e.g. 'c-abc123').",
          ),
        name: z
          .string()
          .optional()
          .describe("Saved connection name or host to search for and connect."),
        host: z
          .string()
          .optional()
          .describe("Remote server hostname or IP address."),
        port: z
          .union([z.number(), z.string()])
          .optional()
          .describe("SSH port (default 22)."),
        user: z
          .string()
          .optional()
          .describe("SSH login username (default 'root')."),
        password: z
          .string()
          .optional()
          .describe("Password for password-based authentication."),
        private_key: z
          .string()
          .optional()
          .describe("PEM-encoded private key for key-based authentication."),
      }),
      needsApproval: true,
      execute: async ({
        connection_id,
        name,
        host,
        port,
        user,
        password,
        private_key,
      }) => {
        if (!ctx.openSshTab) {
          return { error: "SSH terminal tab bridging is not available." };
        }

        try {
          const all = await listConnections();
          let target: SshConnection | undefined;

          if (connection_id?.trim()) {
            target = all.find((c) => c.id === connection_id.trim());
            if (!target) {
              return {
                error: `Saved connection with id '${connection_id}' not found. Use ssh_list_connections to see available connections.`,
              };
            }
          } else if (name?.trim()) {
            const needle = name.trim().toLowerCase();
            target = all.find(
              (c) =>
                c.name.toLowerCase() === needle ||
                c.host.toLowerCase() === needle ||
                c.name.toLowerCase().includes(needle),
            );
            if (!target) {
              return {
                error: `No saved connection matched name '${name}'. Use ssh_list_connections to see available connections.`,
              };
            }
          } else if (host?.trim()) {
            const parsedPort =
              typeof port === "string" ? parseInt(port, 10) || 22 : port ?? 22;
            const targetUser = user?.trim() || "root";
            target = all.find(
              (c) =>
                c.host.toLowerCase() === host.trim().toLowerCase() &&
                c.port === parsedPort &&
                c.user === targetUser,
            );

            if (!target) {
              const newId = newConnectionId();
              const authMode = private_key?.trim()
                ? "key"
                : password
                  ? "password"
                  : "agent";
              const newConn: SshConnection = {
                id: newId,
                name: `${targetUser}@${host.trim()}`,
                host: host.trim(),
                port: parsedPort,
                user: targetUser,
                authMode,
                hasPassword: Boolean(password),
                hasPrivateKey: Boolean(private_key),
                hasKeyPassphrase: false,
                description: "Created by AI agent",
              };

              await upsertConnection(newConn, {
                password: password || undefined,
                privateKey: private_key || undefined,
              });
              target = newConn;
            }
          } else {
            return {
              error:
                "Please provide a `connection_id`, `name`, or `host` to connect.",
            };
          }

          const tabId = ctx.openSshTab(target.id, target.name);
          const sessionId = await waitForActiveSession(target.id);

          return {
            connected: true,
            connection_id: target.id,
            name: target.name,
            host: target.host,
            user: target.user,
            port: target.port,
            tab_id: tabId,
            session_id: sessionId,
            message: `Connected to ${target.user}@${target.host}:${target.port} in terminal tab ${tabId}. Remote SSH tools and commands are now active.`,
          };
        } catch (err) {
          return { error: `Failed to connect SSH: ${String(err)}` };
        }
      },
    }),

    ssh_run_command: tool({
      description:
        "Execute a command directly on a remote server or VPS over a dedicated SSH exec channel. Runs on the active SSH session or targets a specific `session_id` or `connection_id`. Returns stdout, stderr, and exit code. Asks for approval.",
      inputSchema: z.object({
        command: z
          .string()
          .describe("The shell command to execute on the remote VPS/server."),
        cwd: z
          .string()
          .optional()
          .describe(
            "Working directory on remote host. If provided or if remote session has a known cwd, executes after cd to that directory.",
          ),
        session_id: z
          .union([z.number(), z.string()])
          .optional()
          .describe(
            "Specific SSH session ID. Omit to run on the currently active SSH session.",
          ),
        connection_id: z
          .string()
          .optional()
          .describe(
            "Saved connection ID to auto-connect to if no session is currently active.",
          ),
        timeout_secs: z
          .union([z.number(), z.string()])
          .optional()
          .describe("Timeout in seconds. Default 60, up to 300."),
      }),
      needsApproval: true,
      execute: async ({
        command,
        cwd,
        session_id,
        connection_id,
        timeout_secs = 60,
      }) => {
        const safety = screenCommand(command);
        if (!safety.ok) return { error: safety.reason };

        const timeout =
          typeof timeout_secs === "string"
            ? parseInt(timeout_secs, 10) || 60
            : Number(timeout_secs) || 60;

        let targetSessionId: number | null = null;
        const remote = ctx.getRemoteSession();
        if (session_id !== undefined) {
          targetSessionId =
            typeof session_id === "string"
              ? parseInt(session_id, 10)
              : Number(session_id);
        } else {
          if (remote) {
            targetSessionId = remote.sessionId;
          } else {
            const activeStore = useSshActiveSessionStore.getState().session;
            if (activeStore) {
              targetSessionId = activeStore.sessionId;
            }
          }
        }

        if (targetSessionId === null) {
          if (connection_id && ctx.openSshTab) {
            try {
              const all = await listConnections();
              const conn = all.find((c) => c.id === connection_id);
              if (conn) {
                ctx.openSshTab(conn.id, conn.name);
                targetSessionId = await waitForActiveSession(conn.id);
              }
            } catch {
              // Ignore connection lookup error
            }
          }
        }

        if (targetSessionId === null || Number.isNaN(targetSessionId)) {
          return {
            error:
              "No active SSH session. Use ssh_list_connections to inspect saved servers, or ssh_connect to connect to a VPS/server first.",
            remote: true,
          };
        }

        try {
          const effectiveCwd = cwd?.trim() || remote?.cwd;
          const fullCommand = effectiveCwd
            ? `cd ${shellQuote(effectiveCwd)} && ${command}`
            : command;

          const out = await sshExec(targetSessionId, fullCommand, timeout);
          const stdoutTrunc = truncateCommandOutput(out.stdout ?? "");
          const stderrTrunc = truncateCommandOutput(out.stderr ?? "");
          const truncated =
            Boolean(out.truncated) ||
            stdoutTrunc.truncated ||
            stderrTrunc.truncated;

          const result: Record<string, unknown> = {
            command,
            remote: true,
            session_id: targetSessionId,
            stdout: stdoutTrunc.text,
            stderr: stderrTrunc.text,
            exit_code: out.exitCode ?? 0,
            truncated,
          };

          if (effectiveCwd) {
            result.cwd = effectiveCwd;
          }

          if (
            (out.exitCode ?? 0) === 0 &&
            !stdoutTrunc.text.trim() &&
            !stderrTrunc.text.trim()
          ) {
            result.info =
              "Command completed successfully with no output (exit code 0).";
          }

          return result;
        } catch (err) {
          return {
            error: `SSH execution error: ${String(err)}`,
            command,
            remote: true,
            session_id: targetSessionId,
          };
        }
      },
    }),

    ssh_active_session: tool({
      description:
        "Check the status and details of the currently active remote SSH session (session ID, connected host label, remote working directory). Read-only, auto-executes.",
      inputSchema: z.object({}),
      execute: async () => {
        const remote = ctx.getRemoteSession();
        const activeStore = useSshActiveSessionStore.getState().session;

        if (!remote && !activeStore) {
          return {
            connected: false,
            message:
              "No active SSH session. Use ssh_list_connections to view saved hosts, or ssh_connect to establish a connection.",
          };
        }

        const sessionId = remote?.sessionId ?? activeStore?.sessionId ?? null;
        const hostLabel = activeStore?.hostLabel ?? "remote-server";
        const connectionId = activeStore?.connectionId ?? null;
        const cwd = remote?.cwd ?? null;

        return {
          connected: true,
          session_id: sessionId,
          host_label: hostLabel,
          connectionId,
          cwd,
          message: `Active SSH session #${sessionId} connected to ${hostLabel}.`,
        };
      },
    }),
  };
}
