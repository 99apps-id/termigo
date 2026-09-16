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
import {
  backoffMs,
  gaveUpNotice,
  MAX_ATTEMPTS,
  reconnectedNotice,
  reconnectNotice,
  shouldReconnect,
} from "./reconnectPolicy";

/**
 * Like `PtyHandlers`, but `onExit` also says whether the remote reported an
 * exit status. Kept separate rather than widening `PtyHandlers`: a local PTY
 * has no such distinction to make, and the terminal never needs it.
 */
export type SshTerminalHandlers = Omit<PtyHandlers, "onExit"> & {
  onExit?: (code: number, clean: boolean) => void;
};

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
  handlers: SshTerminalHandlers,
): Promise<PtySession> {
  const input = await resolveSshOpenInput(conn);
  const hostLabel = `${conn.user}@${conn.host}`;

  // The backend emits `connected` (and the first shell bytes) from inside the
  // connect, so these callbacks run while `openSsh` is still awaiting and the
  // session id does not exist yet. Closing over the `const` below would put
  // every one of them in its temporal dead zone: `connected` threw before it
  // could register the session, which left the file browser with no session
  // and - because a throw stalls the event channel - a terminal that never
  // received a single byte. So the id is tracked separately and the connect is
  // replayed once it is known.
  let sessionId: number | null = null;
  let connectedEarly = false;

  const registerSession = () => {
    if (sessionId === null) return;
    useSshActiveSessionStore
      .getState()
      .setSession({ sessionId, connectionId: conn.id, hostLabel });
  };
  const forgetSession = () => {
    if (sessionId === null) return; // never registered; nothing to clear
    useSshActiveSessionStore.getState().clearSession(sessionId);
  };

  const session = await openSsh(
    { ...input, cols, rows },
    {
      onData: (bytes) => handlers.onData(bytes),
      onExit: (code) => {
        forgetSession();
        handlers.onExit?.(code, true);
      },
      // The link dropped without an exit status, so there is no code to report.
      // Print why into the pane and then end the session as abnormal (-1), the
      // same value `onError` uses for "no status available". Reporting the old
      // `0` would have shown a dropped connection as a clean finish, and calling
      // nothing would leave a dead grid the user cannot type into.
      onDisconnected: (reason) => {
        handlers.onData(
          new TextEncoder().encode(
            `\r\n\x1b[31m[termigo] SSH ${reason}\x1b[0m\r\n`,
          ),
        );
        forgetSession();
        handlers.onExit?.(-1, false);
      },
      onConnected: () => {
        connectedEarly = true;
        registerSession(); // no-op before the id lands; replayed below
      },
      onHostKeyPrompt: (prompt) => {
        useHostKeyPrompt.getState().enqueue(prompt, () => {
          void pinFingerprint(conn.id, prompt.fingerprint).catch(() => {});
        });
      },
      onError: () => {
        forgetSession();
        handlers.onExit?.(-1, false);
      },
    },
  );

  sessionId = session.id;
  if (connectedEarly) registerSession();

  return {
    id: session.id,
    write: session.write,
    resize: session.resize,
    close: session.close,
  };
}

const notice = (text: string) => new TextEncoder().encode(text);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Open an SSH terminal from a leaf spec, reconnecting if the link drops.
 *
 * A dropped connection used to leave a dead tab that the user had to notice
 * and reopen by hand - and until they did, the agent had no remote session at
 * all, so every remote tool call fell over.
 *
 * What comes back is a proxy, not the session. `id` is a getter, because
 * reconnecting produces a new backend session and `leafSessionId` reads the id
 * at call time - so the SFTP commands and the agent's remote routing follow
 * the new session without anything having to be told.
 *
 * The shell itself is genuinely new: working directory, environment and
 * anything that was running are gone. The terminal says so rather than
 * pretending the session resumed.
 */
export async function openSshTerminalFromSpec(
  spec: SshLeafSpec,
  cols: number,
  rows: number,
  handlers: PtyHandlers,
): Promise<PtySession> {
  const conn = await resolveSshConnection(spec.connectionId);

  let closedByUser = false;
  let attempts = 0;
  let size = { cols, rows };

  const inner = (): SshTerminalHandlers => ({
    onData: handlers.onData,
    onExit: (code: number, clean: boolean) => {
      if (!shouldReconnect({ code, clean }, { closedByUser, attempts })) {
        if (!clean && !closedByUser && attempts >= MAX_ATTEMPTS) {
          handlers.onData(notice(gaveUpNotice()));
        }
        handlers.onExit?.(code);
        return;
      }
      void reconnect();
    },
  });

  let current = await openSshTerminalSession(conn, cols, rows, inner());

  const reconnect = async (): Promise<void> => {
    attempts += 1;
    const delay = backoffMs(attempts);
    handlers.onData(notice(reconnectNotice(attempts, delay)));
    await sleep(delay);
    if (closedByUser) return;
    try {
      const revived = await openSshTerminalSession(
        conn,
        size.cols,
        size.rows,
        inner(),
      );
      // Checked again after the await, not just before it. Closing the tab
      // mid-connect otherwise stranded this session: `close()` had already run
      // against the dead one, and nothing knew about the live one.
      if (closedByUser) {
        await revived.close().catch(() => {});
        return;
      }
      current = revived;
      attempts = 0;
      handlers.onData(notice(reconnectedNotice()));
    } catch {
      if (attempts >= MAX_ATTEMPTS) {
        handlers.onData(notice(gaveUpNotice()));
        handlers.onExit?.(-1);
        return;
      }
      await reconnect();
    }
  };

  return {
    get id() {
      return current.id;
    },
    write: (data) => current.write(data),
    resize: (c, r) => {
      // Remembered so a reconnect opens at the size the pane is now, not the
      // size it happened to be when the tab was first created.
      size = { cols: c, rows: r };
      return current.resize(c, r);
    },
    close: async () => {
      closedByUser = true;
      await current.close();
    },
  };
}
