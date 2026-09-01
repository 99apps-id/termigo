import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listConnections, getState } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listConnections: vi.fn(),
  getState: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./connections", () => ({ listConnections }));
vi.mock("./sshActiveSession", () => ({
  useSshActiveSessionStore: { getState },
}));

import { openForwardForConnection } from "./tunnel";

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(43123);
  listConnections.mockReset().mockResolvedValue([{ id: "connection-a" }]);
  getState.mockReset();
});

describe("openForwardForConnection", () => {
  it("opens a forward on the session belonging to the requested connection", async () => {
    getState.mockReturnValue({
      session: {
        sessionId: 17,
        connectionId: "connection-a",
        hostLabel: "dev@example.com",
      },
    });

    await expect(
      openForwardForConnection("connection-a", "127.0.0.1", 5432),
    ).resolves.toEqual({ localPort: 43123 });
    expect(invoke).toHaveBeenCalledWith("ssh_forward_open", {
      id: 17,
      localPort: 0,
      remoteHost: "127.0.0.1",
      remotePort: 5432,
    });
  });

  it("refuses to open a forward on a different connection's session", async () => {
    getState.mockReturnValue({
      session: {
        sessionId: 18,
        connectionId: "connection-b",
        hostLabel: "prod@example.com",
      },
    });

    await expect(
      openForwardForConnection("connection-a", "127.0.0.1", 5432),
    ).rejects.toThrow(/belongs to prod@example\.com/);
    expect(invoke).not.toHaveBeenCalled();
  });
});
