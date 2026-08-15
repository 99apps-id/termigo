import { describe, expect, it, vi } from "vitest";

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
  listConnections: async () => [],
  pinFingerprint: async () => {},
  resolveJumpHops: async () => [],
}));

const openSsh = vi.fn();
vi.mock("../bridge", () => ({ openSsh: (...a: unknown[]) => openSsh(...a) }));

import { openSshTerminalSession } from "./ssh-terminal";
import type { SshConnection } from "../connections";
import type { SshHandlers } from "../bridge";

const conn = {
  id: "c1",
  name: "vps",
  host: "vps.example.com",
  port: 22,
  user: "root",
  authMode: "key",
} as unknown as SshConnection;

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
    expect(onExit).toHaveBeenCalledWith(0);
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

    expect(onExit).toHaveBeenCalledWith(-1);
    expect(clearSession).not.toHaveBeenCalled();
  });
});
