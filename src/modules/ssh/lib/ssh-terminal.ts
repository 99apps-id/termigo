// Adapter that presents a saved SSH connection to Termigo's terminal
// session abstraction (PtySession), swapping the local PTY for a remote
// shell over russh. Mirrors TEDI's ssh terminal integration.
import type {
  PtyHandlers,
  PtySession,
} from "@/modules/terminal/lib/pty-bridge";
import { openSsh, type SshOpenInput } from "../bridge";
import {
  authFields,
  getConnectionSecrets,
  listConnections,
  pinFingerprint,
  resolveJumpHops,
  type SshConnection,
} from "../connections";
import { useHostKeyPrompt } from "../hostKeyPrompt";
import { useSshActiveSessionStore } from "../sshActiveSession";

/** What a terminal leaf needs to open an SSH session instead of a local PTY. */
export type SshLeafSpec = { connectionId: string };

/** Resolve a saved connection into the full open input (secrets + jumps). */
export async function resolveSshOpenInput(
  conn: SshConnection,
): Promise<Omit<SshOpenInput, "cols" | "rows">> {
  const secrets = await getConnectionSecrets(conn.id);
  const all = await listConnections();
  const jumps = await resolveJumpHops(conn.proxyJumpId, conn.id, all);
  return {
    host: conn.host,
    port: conn.port,
    user: conn.user,
    ...authFields(conn.authMode, secrets),
    expectedFingerprint: conn.lastFingerprint || undefined,
    jumps,
  };
}

/** Look up a saved connection by id, throwing a readable error if missing. */
export async function resolveSshConnection(id: string): Promise<SshConnection> {
  const all = await listConnections();
  const conn = all.find((c) => c.id === id);
  if (!conn) throw new Error(`ssh: connection ${id} no longer exists`);
  return conn;
}

/**
 * Open an SSH terminal session in the shape Termigo's terminal expects.
 * Host-key prompts (first connect to a new host) are routed to the global
 * confirmation dialog; accepting pins the fingerprint on the connection.
 */
export async function openSshTerminalSession(
  conn: SshConnection,
  cols: number,
  rows: number,
  handlers: PtyHandlers,
): Promise<PtySession> {
  const input = await resolveSshOpenInput(conn);
  const hostLabel = `${conn.user}@${conn.host}`;
  const session = await openSsh(
    { ...input, cols, rows },
    {
      onData: (bytes) => handlers.onData(bytes),
      onExit: (code) => {
        useSshActiveSessionStore.getState().clearSession(session.id);
        handlers.onExit?.(code);
      },
      onConnected: () => {
        useSshActiveSessionStore.getState().setSession({ sessionId: session.id, hostLabel });
      },
      onHostKeyPrompt: (prompt) => {
        useHostKeyPrompt.getState().enqueue(prompt, () => {
          void pinFingerprint(conn.id, prompt.fingerprint).catch(() => {});
        });
      },
      onError: () => {
        useSshActiveSessionStore.getState().clearSession(session.id);
        handlers.onExit?.(-1);
      },
    },
  );
  return {
    id: session.id,
    write: session.write,
    resize: session.resize,
    close: session.close,
  };
}

/** Open an SSH terminal from a leaf spec (looks the connection up by id). */
export async function openSshTerminalFromSpec(
  spec: SshLeafSpec,
  cols: number,
  rows: number,
  handlers: PtyHandlers,
): Promise<PtySession> {
  const conn = await resolveSshConnection(spec.connectionId);
  return openSshTerminalSession(conn, cols, rows, handlers);
}
