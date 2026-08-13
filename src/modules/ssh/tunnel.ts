// SSH port-forward helpers for the extension host. Termigo exposes port
// forwarding through the SSH session backend (`ssh_forward_open`); these
// wrappers resolve the live session for a connection id and open/close the
// forward on it.
import { invoke } from "@tauri-apps/api/core";
import { listConnections } from "./connections";

type ForwardResult = { localPort: number };

async function sessionForConnection(connectionId: string): Promise<number> {
  const conns = await listConnections();
  const conn = conns.find((c) => c.id === connectionId);
  if (!conn) throw new Error(`ssh: connection ${connectionId} not found`);
  // The extension API opens the connection first (openConnection), which
  // records the active session; reuse that session id from the active store.
  const { useSshActiveSessionStore } = await import("./sshActiveSession");
  const session = useSshActiveSessionStore.getState().session;
  if (!session) throw new Error("ssh: no active session for this connection");
  return session.sessionId;
}

/** Open a `-L` style forward on the connection's live session. */
export async function openForwardForConnection(
  connectionId: string,
  remoteHost: string,
  remotePort: number,
): Promise<ForwardResult> {
  const sessionId = await sessionForConnection(connectionId);
  const localPort = await invoke<number>("ssh_forward_open", {
    id: sessionId,
    localPort: 0,
    remoteHost,
    remotePort,
  });
  return { localPort };
}

/** Close a forward (the backend closes forwards with the session). */
export async function closeForwardForConnection(
  _connectionId: string,
  _remoteHost: string,
  _remotePort: number,
): Promise<void> {
  // Forwards are session-scoped; closing the connection closes them.
}
