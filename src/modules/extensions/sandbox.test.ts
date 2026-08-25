import { describe, expect, it, vi } from "vitest";
import { createSandboxDispatcher, type SandboxExecutor } from "./sandbox";

function makeExecutor(): SandboxExecutor {
  return {
    invoke: vi.fn(async () => "ok"),
    storageGet: vi.fn(async () => "stored"),
    storageSet: vi.fn(async () => {}),
    storageDelete: vi.fn(async () => {}),
    settingsGet: vi.fn(async () => undefined),
    settingsSet: vi.fn(async () => {}),
    secretsGet: vi.fn(async () => "secret"),
    secretsSet: vi.fn(async () => {}),
    secretsDelete: vi.fn(async () => {}),
    aiGetState: vi.fn(() => ({ status: "idle" })),
    aiSetModel: vi.fn(async () => {}),
    aiSetSubagentsEnabled: vi.fn(async () => {}),
    aiSendPrompt: vi.fn(async () => true),
    aiStop: vi.fn(),
    onToolRegister: vi.fn(),
    onCommandRegister: vi.fn(),
    onDomUnsupported: vi.fn(),
    log: vi.fn(),
  };
}

function dispatch(declared: string[], req: unknown) {
  const executor = makeExecutor();
  const handle = createSandboxDispatcher({ id: "ext", declared }, executor);
  return handle(req as never).then((resp) => ({ executor, resp }));
}

describe("sandbox dispatcher", () => {
  it("allows invoke when the permission is declared", async () => {
    const { executor, resp } = await dispatch(["invoke:fs_read_file"], {
      id: 1,
      kind: "invoke",
      command: "fs_read_file",
      args: { path: "/x" },
    });
    expect(resp).toEqual({ id: 1, ok: true, value: "ok" });
    expect(executor.invoke).toHaveBeenCalledWith("fs_read_file", { path: "/x" });
  });

  it("denies invoke when the permission is missing and never calls the backend", async () => {
    const { executor, resp } = await dispatch(["settings:read"], {
      id: 2,
      kind: "invoke",
      command: "shell_run_command",
      args: { command: "rm -rf /" },
    });
    expect(resp.ok).toBe(false);
    expect((resp as { error: string }).error).toMatch(/lacks permission "invoke:shell_run_command"/);
    expect(executor.invoke).not.toHaveBeenCalled();
  });

  it("gates settings write and secrets read", async () => {
    const { resp } = await dispatch(["settings:read"], {
      id: 3,
      kind: "settings:set",
      key: "x",
      value: 1,
    });
    expect(resp.ok).toBe(false);

    const { resp: r2 } = await dispatch(["settings:read"], {
      id: 4,
      kind: "secrets:get",
      name: "token",
    });
    expect(r2.ok).toBe(false);
  });

  it("does not gate isolated per-extension storage", async () => {
    const { executor, resp } = await dispatch([], {
      id: 5,
      kind: "storage:get",
      key: "state",
    });
    expect(resp).toEqual({ id: 5, ok: true, value: "stored" });
    expect(executor.storageGet).toHaveBeenCalledWith("state");
  });

  it("routes logger without a permission", async () => {
    const { executor, resp } = await dispatch([], {
      id: 6,
      kind: "logger",
      level: "warn",
      args: ["hello"],
    });
    expect(resp.ok).toBe(true);
    expect(executor.log).toHaveBeenCalledWith("warn", ["hello"]);
  });
});
