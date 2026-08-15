import { describe, expect, it, vi } from "vitest";

// Every tool that cannot act on the remote host has to say so rather than
// quietly acting on this one. These are the three the audit found still
// silently local.

const sshExec = vi.fn();
vi.mock("@/modules/ssh/bridge", () => ({
  sshExec: (...a: unknown[]) => sshExec(...a),
}));

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

vi.mock("../lib/native", () => ({
  native: { shellSessionRun: vi.fn(), shellSessionOpen: vi.fn() },
}));

import { buildManagedAgentTools } from "./agent";
import { buildFetchTools } from "./fetch";
import { buildShellTools } from "./shell";
import type { ToolContext } from "./context";

function ctxWith(remote: { sessionId: number; cwd: string | null } | null) {
  return {
    getCwd: () => "C:/workspace",
    getWorkspaceRoot: () => "C:/workspace",
    getSessionId: () => "chat-1",
    getRemoteSession: () => remote,
    spawnAgent: vi.fn(() => 1),
    readAgentOutput: vi.fn(),
    readCache: new Map(),
  } as unknown as ToolContext;
}

function exec(tools: Record<string, unknown>, name: string, args: unknown) {
  const t = tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> };
  return t.execute(args, {});
}

describe("spawn_coding_agent", () => {
  // A local agent happily does local work, so delegating to it while the user
  // is on a server looks like it succeeded.
  it("refuses while an SSH terminal is focused", async () => {
    const tools = buildManagedAgentTools(ctxWith({ sessionId: 4, cwd: "/srv" }));
    const out = await exec(tools, "spawn_coding_agent", { prompt: "fix the build" });
    expect(String((out as { error: string }).error)).toContain("coding agent");
  });

  it("still works with no session open", async () => {
    const tools = buildManagedAgentTools(ctxWith(null));
    const out = await exec(tools, "spawn_coding_agent", { prompt: "fix the build" });
    expect(out).not.toHaveProperty("error");
  });
});

describe("bash_run on the remote host", () => {
  it("runs from the remote shell's directory when it is known", async () => {
    sshExec.mockResolvedValue({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    const tools = buildShellTools(ctxWith({ sessionId: 9, cwd: "/srv/app" }));
    const out = await exec(tools, "bash_run", { command: "ls" });

    expect(sshExec).toHaveBeenCalledWith(9, "cd '/srv/app' && ls", undefined);
    expect(out).toMatchObject({ remote: true, cwd: "/srv/app" });
    expect(out).not.toHaveProperty("note");
  });

  // Shells the OSC 7 hook does not fit (fish, dash) never report a directory,
  // so the command lands in the SSH user's home and a relative path quietly
  // means something else.
  it("says where it ran when the shell reported no directory", async () => {
    sshExec.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    const tools = buildShellTools(ctxWith({ sessionId: 9, cwd: null }));
    const out = await exec(tools, "bash_run", { command: "ls" });

    expect(sshExec).toHaveBeenCalledWith(9, "ls", undefined);
    expect(String((out as { note: string }).note)).toContain("home");
  });

  it("quotes a directory that would otherwise break the command", async () => {
    sshExec.mockClear();
    sshExec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, truncated: false });
    const tools = buildShellTools(ctxWith({ sessionId: 9, cwd: "/srv/my app" }));
    await exec(tools, "bash_run", { command: "ls" });
    expect(sshExec).toHaveBeenCalledWith(9, "cd '/srv/my app' && ls", undefined);
  });
});

describe("fetch", () => {
  // With a session open the model may well think this reached the server, and
  // a page that differs between the two networks would mislead it silently.
  it("reports which machine it fetched from", async () => {
    invoke.mockResolvedValue({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: Array.from(new TextEncoder().encode("hello")),
    });
    const out = await exec(buildFetchTools(), "fetch", { url: "https://x.dev" });
    expect(out).toMatchObject({ fetchedFrom: "local machine", content: "hello" });
  });

  // Not a parameter the model can set: the guard exists so an agent reading a
  // fetched page cannot be talked into probing the machine's own network.
  it("never lets the model reach the private network", async () => {
    invoke.mockClear();
    invoke.mockResolvedValue({ status: 200, headers: {}, body: [] });
    await exec(buildFetchTools(), "fetch", { url: "http://169.254.169.254/" });
    expect(invoke).toHaveBeenCalledWith(
      "ai_http_request",
      expect.objectContaining({ allowPrivateNetwork: false }),
    );
  });
});
