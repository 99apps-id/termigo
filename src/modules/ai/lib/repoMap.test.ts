import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRepoMapCache,
  extractKeyDeclarations,
  formatRepoMapBlock,
  formatRepoTree,
  generateRepoMap,
  getOrGenerateRepoMap,
  shouldSkipRepoMapPath,
} from "./repoMap";
import { native } from "./native";

vi.mock("./native", () => ({
  native: {
    glob: vi.fn(),
    readFile: vi.fn(),
  },
}));

describe("shouldSkipRepoMapPath", () => {
  it("skips dependency and build directories", () => {
    expect(shouldSkipRepoMapPath("node_modules/pkg/index.js")).toBe(true);
    expect(shouldSkipRepoMapPath("dist/bundle.js")).toBe(true);
    expect(shouldSkipRepoMapPath("target/debug/app.exe")).toBe(true);
    expect(shouldSkipRepoMapPath(".git/objects/abc")).toBe(true);
    expect(shouldSkipRepoMapPath(".next/static/chunks/app.js")).toBe(true);
  });

  it("skips minified files and lockfiles", () => {
    expect(shouldSkipRepoMapPath("src/vendor/jquery.min.js")).toBe(true);
    expect(shouldSkipRepoMapPath("package-lock.json")).toBe(true);
    expect(shouldSkipRepoMapPath("Cargo.lock")).toBe(true);
  });

  it("keeps valid source files", () => {
    expect(shouldSkipRepoMapPath("src/App.tsx")).toBe(false);
    expect(shouldSkipRepoMapPath("src/modules/ai/lib/agent.ts")).toBe(false);
    expect(shouldSkipRepoMapPath("cli/cmd/termigo/main.go")).toBe(false);
    expect(shouldSkipRepoMapPath("src-tauri/src/main.rs")).toBe(false);
  });
});

describe("extractKeyDeclarations", () => {
  it("extracts TypeScript exported functions, classes, and types", () => {
    const code = `
export function runStream(a: string) {}
export class SessionManager {}
export interface ToolContext {}
export type RunResult = { ok: boolean };
export const DEFAULT_TIMEOUT = 100;
function privateHelper() {}
`;
    const symbols = extractKeyDeclarations(code);
    expect(symbols).toContain("runStream");
    expect(symbols).toContain("SessionManager");
    expect(symbols).toContain("ToolContext");
    expect(symbols).toContain("RunResult");
    expect(symbols).toContain("DEFAULT_TIMEOUT");
    expect(symbols).not.toContain("privateHelper");
  });

  it("extracts Rust pub functions and structs", () => {
    const code = `
pub fn init_pty() {}
pub struct ProcessPool {}
pub enum Status { Active, Idle }
fn internal_only() {}
`;
    const symbols = extractKeyDeclarations(code);
    expect(symbols).toContain("init_pty");
    expect(symbols).toContain("ProcessPool");
    expect(symbols).toContain("Status");
    expect(symbols).not.toContain("internal_only");
  });

  it("extracts Go exported functions and types", () => {
    const code = `
func RunCommand(ctx context.Context) error {}
func internalHelper() {}
type AgentConfig struct {}
type Service interface {}
`;
    const symbols = extractKeyDeclarations(code);
    expect(symbols).toContain("RunCommand");
    expect(symbols).toContain("AgentConfig");
    expect(symbols).toContain("Service");
    expect(symbols).not.toContain("internalHelper");
  });

  it("extracts Python top-level classes and functions", () => {
    const code = `
def process_data(item):
    pass

class DataPipeline:
    def __init__(self):
        pass

def _private_func():
    pass
`;
    const symbols = extractKeyDeclarations(code);
    expect(symbols).toContain("process_data");
    expect(symbols).toContain("DataPipeline");
    expect(symbols).not.toContain("_private_func");
  });
});

describe("formatRepoTree and formatRepoMapBlock", () => {
  it("formats file entries cleanly and caps characters", () => {
    const entries = [
      { relPath: "src/App.tsx", symbols: ["App"] },
      { relPath: "src/main.ts", symbols: ["bootstrap"] },
    ];
    const tree = formatRepoTree(entries, 500);
    expect(tree).toContain("- src/App.tsx (App)");
    expect(tree).toContain("- src/main.ts (bootstrap)");
  });

  it("respects character limit and appends more files indicator", () => {
    const entries = [
      { relPath: "src/a.ts", symbols: ["A"] },
      { relPath: "src/b.ts", symbols: ["B"] },
      { relPath: "src/c.ts", symbols: ["C"] },
    ];
    const tree = formatRepoTree(entries, 30);
    expect(tree).toContain("... (+");
  });

  it("formats repo map block", () => {
    expect(formatRepoMapBlock(null)).toBe("");
    expect(formatRepoMapBlock("## REPOSITORY MAP\n- src/App.tsx")).toContain(
      "## REPOSITORY MAP\n- src/App.tsx",
    );
  });
});

describe("generateRepoMap & getOrGenerateRepoMap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRepoMapCache();
  });

  it("returns null on empty or missing workspace root", async () => {
    const res = await generateRepoMap("");
    expect(res).toBeNull();
  });

  it("generates repo map from native.glob and native.readFile hits", async () => {
    vi.mocked(native.glob).mockResolvedValueOnce({
      hits: [
        { path: "/repo/src/index.ts", mtime: 100, size: 200 },
        { path: "/repo/node_modules/pkg/index.js", mtime: 100, size: 200 },
      ],
      truncated: false,
    });

    vi.mocked(native.readFile).mockResolvedValueOnce({
      kind: "text",
      content: "export function main() {}\nexport class AppRunner {}",
    });

    const res = await generateRepoMap("/repo");
    expect(res).toContain("## REPOSITORY MAP (Compact Top-Level Architecture)");
    expect(res).toContain("src/index.ts (main, AppRunner)");
    expect(res).not.toContain("node_modules");
  });

  it("caches generated repo map in memory", async () => {
    vi.mocked(native.glob).mockResolvedValue({
      hits: [{ path: "/repo/src/index.ts", mtime: 100, size: 200 }],
      truncated: false,
    });
    vi.mocked(native.readFile).mockResolvedValue({
      kind: "text",
      content: "export const VERSION = '1.0';",
    });

    const first = await getOrGenerateRepoMap("/repo");
    const second = await getOrGenerateRepoMap("/repo");

    expect(first).toBe(second);
    expect(native.glob).toHaveBeenCalledTimes(1);
  });
});
