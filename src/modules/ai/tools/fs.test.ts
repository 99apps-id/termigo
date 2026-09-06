import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFsTools, normalizeWriteFileInput } from "./fs";
import type { ToolContext } from "./context";

vi.mock("../lib/native", () => ({
  native: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    canonicalize: vi.fn(async (p: string) => p),
    createDir: vi.fn(),
  },
}));

import { native } from "../lib/native";

function makeCtx(): ToolContext {
  return {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    getRemoteSession: () => null,
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    openPreview: () => true,
    openCanvas: () => true,
    browserOpen: vi.fn(),
    browserNavigate: vi.fn(),
    browserBack: vi.fn(),
    browserForward: vi.fn(),
    browserReload: vi.fn(),
    browserExtract: vi.fn(),
    browserEval: vi.fn(),
    browserScreenshot: vi.fn(),
    browserConsole: vi.fn(),
    browserUrl: vi.fn(),
    browserClose: vi.fn(),
    browserList: vi.fn(),
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache: new Map(),
    getSessionId: () => "sess-1",
  };
}

describe("normalizeWriteFileInput", () => {
  it("normalizes path aliases file_path, file, filename, target", () => {
    expect(
      normalizeWriteFileInput({ file_path: "report.md", content: "data" }),
    ).toEqual({ path: "report.md", file_path: "report.md", content: "data" });

    expect(
      normalizeWriteFileInput({ file: "src/app.ts", text: "code" }),
    ).toEqual({ path: "src/app.ts", file: "src/app.ts", content: "code", text: "code" });

    expect(
      normalizeWriteFileInput({ filename: "notes.txt", body: "my notes" }),
    ).toEqual({ path: "notes.txt", filename: "notes.txt", content: "my notes", body: "my notes" });
  });

  it("normalizes content aliases text, body, contents, data", () => {
    expect(
      normalizeWriteFileInput({ path: "out.log", contents: "line 1\nline 2" }),
    ).toEqual({ path: "out.log", content: "line 1\nline 2", contents: "line 1\nline 2" });
  });

  it("leaves standard inputs intact", () => {
    expect(
      normalizeWriteFileInput({ path: "readme.md", content: "# Title" }),
    ).toEqual({ path: "readme.md", content: "# Title" });
  });
});

describe("write_file tool execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes file and updates cache with normalized inputs", async () => {
    const ctx = makeCtx();
    const tools = buildFsTools(ctx);
    vi.mocked(native.writeFile).mockResolvedValue(undefined);

    const exec = tools.write_file.execute as (
      args: unknown,
      opts: unknown,
    ) => Promise<{ ok?: boolean; bytesWritten?: number; path?: string }>;

    const result = await exec(
      { file_path: "report.md", text: "# Hello World", overwrite: true },
      { toolCallId: "t1", messages: [] },
    );

    expect(result.ok).toBe(true);
    expect(result.bytesWritten).toBe(13);
    expect(native.writeFile).toHaveBeenCalledWith("/workspace/report.md", "# Hello World");
  });
});
