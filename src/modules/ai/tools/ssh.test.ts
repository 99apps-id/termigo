import { describe, expect, it, vi } from "vitest";
import { buildSshTools } from "./ssh";
import type { ToolContext } from "./context";

const sshExecMock = vi.fn();
vi.mock("@/modules/ssh/bridge", () => ({
  sshExec: (...args: unknown[]) => sshExecMock(...args),
}));

const mockConnections = [
  {
    id: "conn-1",
    name: "Production VPS",
    host: "192.168.1.100",
    port: 22,
    user: "root",
    authMode: "key",
    hasPassword: false,
    hasPrivateKey: true,
    hasKeyPassphrase: false,
    description: "Main VPS",
  },
  {
    id: "conn-2",
    name: "Staging Server",
    host: "staging.example.com",
    port: 2222,
    user: "deploy",
    authMode: "password",
    hasPassword: true,
    hasPrivateKey: false,
    hasKeyPassphrase: false,
  },
];

vi.mock("@/modules/ssh/connections", () => ({
  listConnections: vi.fn().mockImplementation(async () => mockConnections),
  upsertConnection: vi.fn().mockResolvedValue(undefined),
  newConnectionId: vi.fn().mockReturnValue("conn-new"),
}));

let mockActiveSession: {
  sessionId: number;
  connectionId: string;
  hostLabel: string;
} | null = null;

vi.mock("@/modules/ssh/sshActiveSession", () => ({
  useSshActiveSessionStore: {
    getState: () => ({
      session: mockActiveSession,
      setSession: (s: typeof mockActiveSession) => {
        mockActiveSession = s;
      },
      clearSession: () => {
        mockActiveSession = null;
      },
    }),
  },
}));

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    getCwd: () => null,
    getRemoteSession: () => null,
    getWorkspaceRoot: () => null,
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    listTerminals: () => [],
    getTerminalContextFor: () => null,
    injectIntoActivePty: () => false,
    openPreview: () => false,
    openCanvas: () => false,
    browserOpen: async () => ({ error: "disabled" }),
    browserNavigate: async () => ({ error: "disabled" }),
    browserBack: async () => ({ ok: true as const }),
    browserForward: async () => ({ ok: true as const }),
    browserReload: async () => ({ ok: true as const }),
    browserExtract: async () => ({ text: "" }),
    browserEval: async () => ({ ok: true as const }),
    browserScreenshot: async () => ({ screenshot: "" }),
    browserConsole: async () => ({ console: "" }),
    browserUrl: async () => ({ url: "" }),
    browserClose: async () => ({ ok: true as const }),
    browserList: async () => [],
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache: new Map(),
    getSessionId: () => "test-session",
    ...overrides,
  };
}

describe("buildSshTools", () => {
  it("lists saved connections and includes active session status", async () => {
    mockActiveSession = {
      sessionId: 42,
      connectionId: "conn-1",
      hostLabel: "root@192.168.1.100",
    };

    const ctx = makeCtx();
    const tools = buildSshTools(ctx);
    const result = (await tools.ssh_list_connections.execute(
      {},
      { toolCallId: "1" },
    )) as { count: number; connections: Array<{ id: string }>; active_session: unknown };

    expect(result.count).toBe(2);
    expect(result.connections[0].id).toBe("conn-1");
    expect(result.active_session).toMatchObject({
      sessionId: 42,
      connectionId: "conn-1",
      hostLabel: "root@192.168.1.100",
    });
  });

  it("filters saved connections by name or host", async () => {
    const ctx = makeCtx();
    const tools = buildSshTools(ctx);
    const result = (await tools.ssh_list_connections.execute(
      { filter: "staging" },
      { toolCallId: "2" },
    )) as { count: number; connections: Array<{ id: string; name: string }> };

    expect(result.count).toBe(1);
    expect(result.connections[0].name).toBe("Staging Server");
  });

  it("connects to a saved connection via openSshTab", async () => {
    const openSshTab = vi.fn().mockReturnValue(101);
    const ctx = makeCtx({ openSshTab });
    const tools = buildSshTools(ctx);

    const result = (await tools.ssh_connect.execute(
      { connection_id: "conn-1" },
      { toolCallId: "3" },
    )) as { connected: boolean; tab_id: number; connection_id: string };

    expect(openSshTab).toHaveBeenCalledWith("conn-1", "Production VPS");
    expect(result.connected).toBe(true);
    expect(result.tab_id).toBe(101);
    expect(result.connection_id).toBe("conn-1");
  });

  it("runs remote command on the active SSH session", async () => {
    mockActiveSession = {
      sessionId: 42,
      connectionId: "conn-1",
      hostLabel: "root@192.168.1.100",
    };

    sshExecMock.mockResolvedValueOnce({
      stdout: "Linux vps 6.1.0-kali #1 SMP\n",
      stderr: "",
      exitCode: 0,
      truncated: false,
    });

    const ctx = makeCtx({
      getRemoteSession: () => ({ sessionId: 42, cwd: "/root" }),
    });
    const tools = buildSshTools(ctx);

    const result = (await tools.ssh_run_command.execute(
      { command: "uname -a" },
      { toolCallId: "4" },
    )) as { stdout: string; exit_code: number; remote: boolean; session_id: number };

    expect(sshExecMock).toHaveBeenCalledWith(42, "uname -a", 60);
    expect(result.remote).toBe(true);
    expect(result.session_id).toBe(42);
    expect(result.stdout).toContain("Linux vps");
    expect(result.exit_code).toBe(0);
  });

  it("returns an error when running command without active SSH session", async () => {
    mockActiveSession = null;
    const ctx = makeCtx({ getRemoteSession: () => null });
    const tools = buildSshTools(ctx);

    const result = (await tools.ssh_run_command.execute(
      { command: "uptime" },
      { toolCallId: "5" },
    )) as { error: string };

    expect(result.error).toContain("No active SSH session");
  });

  it("reports active session details via ssh_active_session", async () => {
    mockActiveSession = {
      sessionId: 99,
      connectionId: "conn-2",
      hostLabel: "deploy@staging.example.com",
    };

    const ctx = makeCtx({
      getRemoteSession: () => ({ sessionId: 99, cwd: "/home/deploy/app" }),
    });
    const tools = buildSshTools(ctx);

    const result = (await tools.ssh_active_session.execute(
      {},
      { toolCallId: "6" },
    )) as { connected: boolean; session_id: number; cwd: string; host_label: string };

    expect(result.connected).toBe(true);
    expect(result.session_id).toBe(99);
    expect(result.cwd).toBe("/home/deploy/app");
    expect(result.host_label).toBe("deploy@staging.example.com");
  });
});
