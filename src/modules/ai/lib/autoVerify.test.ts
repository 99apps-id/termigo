import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_VERIFY_TOOLS, withAutoVerify } from "./autoVerify";

// withAutoVerify imports the runner, so mock the runner module to observe the
// wrapper's control flow without spawning real shells.
vi.mock("./autoVerifyRunner", () => ({
  autoVerifyEditedFile: vi.fn().mockResolvedValue(null),
}));

import { autoVerifyEditedFile } from "./autoVerifyRunner";

type Exec = (args: Record<string, unknown>, opts?: object) => Promise<unknown>;

type ToolLike = { execute: Exec };

function mkTool(result: unknown): ToolLike {
  return {
    execute: vi.fn(async () => result) as unknown as Exec,
  };
}

function ctx() {
  return { getSessionId: () => "s1", getWorkspaceRoot: () => "/w" } as never;
}

const options = { toolCallId: "t" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("withAutoVerify (full-agentic verify step)", () => {
  it("wraps only the mutating edit tools", () => {
    expect(AUTO_VERIFY_TOOLS.has("write_file")).toBe(true);
    expect(AUTO_VERIFY_TOOLS.has("edit")).toBe(true);
    expect(AUTO_VERIFY_TOOLS.has("multi_edit")).toBe(true);
    expect(AUTO_VERIFY_TOOLS.has("bash_run")).toBe(false);
    expect(AUTO_VERIFY_TOOLS.has("read_file")).toBe(false);
  });

  it("runs the original and keeps the result when verify is skipped", async () => {
    const tool = mkTool({ path: "/w/a.ts", ok: true });
    const wrapped = withAutoVerify("write_file", tool, ctx());
    const out = await wrapped.execute({ path: "/w/a.ts" }, options);
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(out).toEqual({ path: "/w/a.ts", ok: true });
  });

  it("does not verify an error result", async () => {
    const tool = mkTool({ error: "denied", path: "/w/a.ts" });
    const wrapped = withAutoVerify("write_file", tool, ctx());
    const out = await wrapped.execute({ path: "/w/a.ts" }, options);
    expect(autoVerifyEditedFile).not.toHaveBeenCalled();
    expect(out).toEqual({ error: "denied", path: "/w/a.ts" });
  });

  it("does not verify a user-reverted result", async () => {
    const tool = mkTool({ path: "/w/a.ts", ok: true, reverted_by_user: true });
    const wrapped = withAutoVerify("edit", tool, ctx());
    const out = await wrapped.execute({ path: "/w/a.ts" }, options);
    expect(autoVerifyEditedFile).not.toHaveBeenCalled();
    expect(out).toHaveProperty("reverted_by_user", true);
  });

  it("does not wrap non-edit tools", async () => {
    const tool = mkTool({ ok: true });
    const wrapped = withAutoVerify("bash_run", tool, ctx());
    await wrapped.execute({ command: "ls" }, options);
    expect(autoVerifyEditedFile).not.toHaveBeenCalled();
  });

  it("folds the verification outcome into a successful edit result", async () => {
    vi.mocked(autoVerifyEditedFile).mockResolvedValueOnce({
      formatted: true,
      formatter: "biome format (pnpm)",
      lint: { ran: true, passed: true, command: "pnpm lint" },
    });
    const tool = mkTool({ path: "/w/a.ts", ok: true });
    const wrapped = withAutoVerify("write_file", tool, ctx());
    const out = (await wrapped.execute({ path: "/w/a.ts" }, options)) as Record<
      string,
      unknown
    >;
    expect(autoVerifyEditedFile).toHaveBeenCalledOnce();
    expect(out.verification).toMatchObject({ formatted: true });
  });
});
