import { describe, expect, it } from "vitest";
import type { Tab, TerminalTab } from "./useTabs";
import {
  getTerminalTabCwd,
  normalizeWorkspaceCwd,
  resolveWorkspaceRoot,
} from "./useWorkspaceCwd";

function makeTerminalTab(over: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 1,
    kind: "terminal",
    spaceId: "default",
    title: "Terminal",
    paneTree: { kind: "leaf", id: 10, cwd: "/home/user/project" },
    activeLeafId: 10,
    ...over,
  };
}

describe("normalizeWorkspaceCwd", () => {
  it("keeps POSIX cwd identity stable across OSC 7 spellings", () => {
    const expected = "/home/iwan/project/termigo";

    expect(normalizeWorkspaceCwd("/home/iwan/project/termigo/")).toBe(expected);
    expect(normalizeWorkspaceCwd("/home/iwan//project/termigo")).toBe(expected);
  });

  it("converts Windows separators without changing the shared boundary", () => {
    expect(normalizeWorkspaceCwd("C:\\project\\termigo\\")).toBe(
      "C:/project/termigo",
    );
  });
});

describe("getTerminalTabCwd", () => {
  it("resolves active leaf cwd from paneTree", () => {
    const tab = makeTerminalTab({
      paneTree: { kind: "leaf", id: 5, cwd: "/home/user/active-leaf" },
      activeLeafId: 5,
      cwd: undefined,
    });
    expect(getTerminalTabCwd(tab)).toBe("/home/user/active-leaf");
  });

  it("resolves active leaf cwd in split pane trees", () => {
    const tab = makeTerminalTab({
      paneTree: {
        kind: "split",
        id: 1,
        dir: "col",
        children: [
          { kind: "leaf", id: 2, cwd: "/home/user/left" },
          { kind: "leaf", id: 3, cwd: "/home/user/right" },
        ],
      },
      activeLeafId: 3,
    });
    expect(getTerminalTabCwd(tab)).toBe("/home/user/right");
  });

  it("falls back to tab.cwd if leaf cwd is not set", () => {
    const tab = makeTerminalTab({
      paneTree: { kind: "leaf", id: 10 },
      activeLeafId: 10,
      cwd: "/home/user/fallback",
    });
    expect(getTerminalTabCwd(tab)).toBe("/home/user/fallback");
  });

  it("returns undefined for non-terminal tabs or undefined tab", () => {
    expect(getTerminalTabCwd(undefined)).toBeUndefined();
    const editorTab: Tab = {
      id: 2,
      kind: "editor",
      spaceId: "default",
      title: "index.ts",
      path: "/home/user/index.ts",
      dirty: false,
      preview: false,
    };
    expect(getTerminalTabCwd(editorTab)).toBeUndefined();
  });
});

describe("resolveWorkspaceRoot", () => {
  it("prioritizes active terminal paneTree cwd over stale tab.cwd", () => {
    const tab = makeTerminalTab({
      paneTree: { kind: "leaf", id: 10, cwd: "/home/user/new-dir" },
      activeLeafId: 10,
      cwd: "/home/user/old-dir",
    });
    expect(resolveWorkspaceRoot(tab, [tab], "/home/user")).toBe(
      "/home/user/new-dir",
    );
  });

  it("normalizes POSIX paths with trailing slashes", () => {
    const tab = makeTerminalTab({
      paneTree: { kind: "leaf", id: 10, cwd: "/home/user/trailing/" },
      activeLeafId: 10,
    });
    expect(resolveWorkspaceRoot(tab, [tab], "/home/user")).toBe(
      "/home/user/trailing",
    );
  });

  it("falls back to lastTerminalCwd when active tab has no cwd", () => {
    const editorTab: Tab = {
      id: 2,
      kind: "editor",
      spaceId: "default",
      title: "file.txt",
      path: "/home/user/file.txt",
      dirty: false,
      preview: false,
    };
    expect(
      resolveWorkspaceRoot(
        editorTab,
        [editorTab],
        "/home/user",
        "/home/user/last-dir",
      ),
    ).toBe("/home/user/last-dir");
  });

  it("falls back to another terminal tab when active tab is non-terminal and no lastTerminalCwd", () => {
    const editorTab: Tab = {
      id: 2,
      kind: "editor",
      spaceId: "default",
      title: "file.txt",
      path: "/home/user/file.txt",
      dirty: false,
      preview: false,
    };
    const terminalTab = makeTerminalTab({
      id: 3,
      paneTree: { kind: "leaf", id: 20, cwd: "/home/user/other-term" },
      activeLeafId: 20,
    });
    expect(
      resolveWorkspaceRoot(editorTab, [editorTab, terminalTab], "/home/user"),
    ).toBe("/home/user/other-term");
  });

  it("falls back to home if no terminal tabs have a cwd", () => {
    expect(resolveWorkspaceRoot(undefined, [], "/home/user")).toBe(
      "/home/user",
    );
  });
});
