import { describe, expect, it, vi } from "vitest";

// `openSshTerminalFromSpec` looks the connection up, so the mock has to be
// able to return it. Hoisted because vi.mock runs before the const below.
const saved = vi.hoisted(() => ({ list: [] as unknown[] }));

const setSession = vi.fn();
const clearSession = vi.fn();

vi.mock("../sshActiveSession", () => ({
  useSshActiveSessionStore: {
    getState: () => ({ setSession, clearSession }),
  },
}));
vi.mock("../hostKeyPrompt", () => ({
  useHostKeyPrompt: { getState: () => ({ enqueue: vi.fn() }) },
}));
vi.mock("../connections", () => ({
  authFields: () => ({}),
  getConnectionSecrets: async () => ({}),
  listConnections: async () => saved.list,
  pinFingerprint: async () => {},
  resolveJumpHops: async () => [],
}));

const openSsh = vi.fn();
vi.mock("../bridge", () => ({ openSsh: (...a: unknown[]) => openSsh(...a) }));

import type { SshHandlers } from "../bridge";
import type { SshConnection } from "../connections";
import {
  openSshTerminalFromSpec,
  openSshTerminalSession,
} from "./ssh-terminal";

const conn = {
  id: "c1",
  name: "vps",
  host: "vps.example.com",
  port: 22,
  user: "root",
  authMode: "key",
} as unknown as SshConnection;
saved.list = [conn];

/**
 * The backend emits `connected` and the first shell bytes from inside the
 * connect, so callbacks fire while `openSsh` is still pending. This fake
 * reproduces that ordering, which is what the original code got wrong.
 */
function backendThatEmitsDuringConnect(id: number) {
  return vi.fn(async (_input: unknown, handlers: SshHandlers) => {
    handlers.onConnected?.("SHA256:aa");
    handlers.onData(new TextEncoder().encode("motd"));
    return { id, write: vi.fn(), resize: vi.fn(), close: vi.fn() };
  });
}

describe("openSshTerminalSession", () => {
  it("registers the session even though connected arrives before the id exists", async () => {
    setSession.mockClear();
    openSsh.mockImplementation(backendThatEmitsDuringConnect(7));

    const onData = vi.fn();
    await openSshTerminalSession(conn, 80, 24, { onData });

    // Previously this threw a ReferenceError inside the event channel, leaving
    // the file browser with no session and the terminal with no output.
    expect(setSession).toHaveBeenCalledWith({
      sessionId: 7,
      connectionId: "c1",
      hostLabel: "root@vps.example.com",
    });
  });

  it("passes shell bytes through even when they arrive during the connect", async () => {
    openSsh.mockImplementation(backendThatEmitsDuringConnect(8));

    const onData = vi.fn();
    await openSshTerminalSession(conn, 80, 24, { onData });

    expect(onData).toHaveBeenCalledWith(new TextEncoder().encode("motd"));
  });

  it("clears the session on exit", async () => {
    clearSession.mockClear();
    let exit: ((code: number) => void) | undefined;
    openSsh.mockImplementation(async (_i: unknown, h: SshHandlers) => {
      exit = h.onExit;
      return { id: 9, write: vi.fn(), resize: vi.fn(), close: vi.fn() };
    });

    const onExit = vi.fn();
    await openSshTerminalSession(conn, 80, 24, { onData: vi.fn(), onExit });
    exit?.(0);

    expect(clearSession).toHaveBeenCalledWith(9);
    expect(onExit).toHaveBeenCalledWith(0, true);
  });

  // The backend used to report a dropped link as `exit 0`, so the pane showed a
  // clean finish for a connection that died mid-command. It must now say what
  // happened and close as abnormal instead.
  it("reports a dropped link as abnormal, not as a clean exit", async () => {
    clearSession.mockClear();
    let dropped: ((reason: string) => void) | undefined;
    openSsh.mockImplementation(async (_i: unknown, h: SshHandlers) => {
      dropped = h.onDisconnected;
      return { id: 11, write: vi.fn(), resize: vi.fn(), close: vi.fn() };
    });

    const onData = vi.fn();
    const onExit = vi.fn();
    await openSshTerminalSession(conn, 80, 24, { onData, onExit });
    dropped?.("connection closed without reporting an exit status");

    expect(onExit).toHaveBeenCalledWith(-1, false);
    expect(onExit).not.toHaveBeenCalledWith(0, true);
    expect(clearSession).toHaveBeenCalledWith(11);
    // The reason has to reach the pane, or the user is left guessing why a
    // session they did not close disappeared.
    const written = onData.mock.calls
      .map((c) => new TextDecoder().decode(c[0] as Uint8Array))
      .join("");
    expect(written).toContain(
      "connection closed without reporting an exit status",
    );
  });

  // A connect that fails before the id exists must report the exit without
  // trying to clear a session that was never registered.
  it("reports a failure that happens before the id exists", async () => {
    clearSession.mockClear();
    openSsh.mockImplementation(async (_i: unknown, h: SshHandlers) => {
      h.onError?.("connection refused");
      return { id: 10, write: vi.fn(), resize: vi.fn(), close: vi.fn() };
    });

    const onExit = vi.fn();
    await openSshTerminalSession(conn, 80, 24, { onData: vi.fn(), onExit });

    expect(onExit).toHaveBeenCalledWith(-1, false);
    expect(clearSession).not.toHaveBeenCalled();
  });

  it("clears the session when closed directly", async () => {
    clearSession.mockClear();
    openSsh.mockImplementation(async () => ({
      id: 12,
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
    }));

    const session = await openSshTerminalSession(conn, 80, 24, {
      onData: vi.fn(),
    });
    await session.close();

    expect(clearSession).toHaveBeenCalledWith(12);
  });
});

describe("openSshTerminalFromSpec", () => {
  it("clears active session store when closed by user", async () => {
    clearSession.mockClear();
    openSsh.mockImplementation(backendThatEmitsDuringConnect(15));

    const session = await openSshTerminalFromSpec(
      { connectionId: conn.id },
      80,
      24,
      { onData: vi.fn() },
    );

    await session.close();
    expect(clearSession).toHaveBeenCalledWith(15);
  });
});

// Found by auditing rather than by anything failing. `closedByUser` was checked
// only before the connect, so closing the tab *while the connect was in
// flight* left the freshly-opened session with no owner: `close()` had already
// run against the dead one. An orphan shell on the server until the app exits.
describe("a reconnect that lands after the tab closed", () => {
  it("closes the session it just opened instead of stranding it", async () => {
    const revivedClose = vi.fn().mockResolvedValue(undefined);
    let deadDrop: ((reason: string) => void) | undefined;
    let releaseConnect: (() => void) | undefined;
    const connecting = new Promise<void>((r) => {
      releaseConnect = r;
    });
    let call = 0;

    openSsh.mockImplementation(async (_i: unknown, h: SshHandlers) => {
      call += 1;
      if (call === 1) {
        deadDrop = h.onDisconnected;
        return { id: 1, write: vi.fn(), resize: vi.fn(), close: vi.fn() };
      }
      // Hold the second connect open so the close below lands mid-flight,
      // which is the only window the bug lived in.
      await connecting;
      return { id: 2, write: vi.fn(), resize: vi.fn(), close: revivedClose };
    });

    const session = await openSshTerminalFromSpec(
      { connectionId: conn.id },
      80,
      24,
      { onData: vi.fn() },
    );

    deadDrop?.("dropped");
    await vi.waitFor(() => expect(call).toBe(2), { timeout: 8000 });

    await session.close();
    releaseConnect?.();

    await vi.waitFor(() => expect(revivedClose).toHaveBeenCalled(), {
      timeout: 8000,
    });
  }, 20_000);
});
