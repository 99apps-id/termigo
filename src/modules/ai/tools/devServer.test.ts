import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeFns = vi.hoisted(() => ({
  shellBgList: vi.fn(),
  shellBgKill: vi.fn(),
  shellBgSpawn: vi.fn(),
  shellBgLogs: vi.fn(),
  httpProbe: vi.fn(),
  readFile: vi.fn(),
}));
vi.mock("../lib/native", () => ({ native: nativeFns }));

import type { ToolContext } from "./context";
import { buildDevServerTools } from "./devServer";

function createMockCtx(remote: { sessionId: number; cwd: string | null } | null = null): ToolContext {
  return {
    getCwd: () => "C:/workspace",
    getWorkspaceRoot: () => "C:/workspace",
    getSessionId: () => "chat-1",
    getRemoteSession: () => remote,
    openPreview: vi.fn(() => true),
    readCache: new Map(),
  } as unknown as ToolContext;
}

function exec(tools: Record<string, unknown>, name: string, args: unknown) {
  const t = tools[name] as {
    execute: (a: unknown, o: unknown) => Promise<unknown>;
  };
  return t.execute(args, {});
}

describe("dev_server tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses when an SSH session is active", async () => {
    const ctx = createMockCtx({ sessionId: 1, cwd: "/remote" });
    const tools = buildDevServerTools(ctx);
    const res = (await exec(tools, "dev_server", { command: "pnpm dev" })) as { error: string };
    expect(res.error).toBeDefined();
    expect(res.error).toContain("dev_server");
  });

  it("reuses an existing running server if restart is false", async () => {
    const ctx = createMockCtx(null);
    nativeFns.shellBgList.mockResolvedValueOnce([
      { handle: 42, command: "pnpm dev", exited: false },
    ]);
    nativeFns.shellBgLogs.mockResolvedValue({
      bytes: "ready on http://localhost:3000",
      next_offset: 100,
      exited: false,
    });
    nativeFns.httpProbe.mockResolvedValue({ ok: true, status: 200 });

    const tools = buildDevServerTools(ctx);
    const res = (await exec(tools, "dev_server", { command: "pnpm dev", restart: false })) as {
      handle: number;
      reused: boolean;
      ready: boolean;
      url: string;
    };

    expect(nativeFns.shellBgKill).not.toHaveBeenCalled();
    expect(nativeFns.shellBgSpawn).not.toHaveBeenCalled();
    expect(res.handle).toBe(42);
    expect(res.reused).toBe(true);
    expect(res.ready).toBe(true);
    expect(res.url).toBe("http://localhost:3000");
  });

  it("kills the existing dev server and spawns a new one when restart is true", async () => {
    const ctx = createMockCtx(null);
    nativeFns.shellBgList.mockResolvedValueOnce([
      { handle: 42, command: "pnpm dev", exited: false },
    ]);
    nativeFns.shellBgKill.mockResolvedValueOnce(undefined);
    nativeFns.shellBgSpawn.mockResolvedValueOnce(99);
    nativeFns.shellBgLogs.mockResolvedValue({
      bytes: "listening on http://localhost:3000",
      next_offset: 80,
      exited: false,
    });
    nativeFns.httpProbe.mockResolvedValue({ ok: true, status: 200 });

    const tools = buildDevServerTools(ctx);
    const res = (await exec(tools, "dev_server", { command: "pnpm dev", restart: true })) as {
      handle: number;
      note: string;
      ready: boolean;
      url: string;
    };

    expect(nativeFns.shellBgKill).toHaveBeenCalledWith(42);
    expect(nativeFns.shellBgSpawn).toHaveBeenCalledWith("pnpm dev", "C:/workspace");
    expect(res.handle).toBe(99);
    expect(res.note).toContain("restarted previous server #42");
    expect(res.ready).toBe(true);
    expect(res.url).toBe("http://localhost:3000");
  });
});
