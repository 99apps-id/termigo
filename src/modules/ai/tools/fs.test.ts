import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  READ_BYTE_CAP,
  buildFsTools,
  normalizeWriteFileInput,
  sliceLines,
} from "./fs";
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

describe("sliceLines and read_file windowing", () => {
  it("READ_BYTE_CAP is 64KB", () => {
    expect(READ_BYTE_CAP).toBe(64 * 1024);
  });

  it("slices content with offset and limit correctly", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n");

    const sliced = sliceLines(content, 500, 200);
    expect(sliced.total_lines).toBe(1000);
    expect(sliced.start_line).toBe(500);
    expect(sliced.end_line).toBe(700);
    expect(sliced.truncated).toBe(true);
    expect(sliced.content.startsWith("line 501\n")).toBe(true);
    expect(sliced.content.endsWith("\nline 700")).toBe(true);
  });

  it("returns helpful hint when read_file truncates", async () => {
    const ctx = makeCtx();
    const tools = buildFsTools(ctx);
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`);
    vi.mocked(native.readFile).mockResolvedValue({
      kind: "text",
      content: lines.join("\n"),
      size: 30000,
    });

    const exec = tools.read_file.execute as (
      args: unknown,
      opts: unknown,
    ) => Promise<{ truncated?: boolean; hint?: string }>;

    const res = await exec(
      { path: "large.ts" },
      { toolCallId: "t2", messages: [] },
    );

    expect(res.truncated).toBe(true);
    expect(res.hint).toContain("offset and limit");
  });

  it("create_directory succeeds when directory already exists", async () => {
    const ctx = makeCtx();
    const tools = buildFsTools(ctx);
    vi.mocked(native.createDir).mockRejectedValueOnce(
      new Error("already exists: /workspace/docs"),
    );

    const exec = tools.create_directory.execute as (
      args: unknown,
      opts: unknown,
    ) => Promise<{ ok?: boolean; already_exists?: boolean }>;

    const res = await exec(
      { path: "docs" },
      { toolCallId: "t3", messages: [] },
    );

    expect(res.ok).toBe(true);
    expect(res.already_exists).toBe(true);
  });
});


