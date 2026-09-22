import { describe, expect, it } from "vitest";
import { discoveredWorktrees, WORKTREE_SUBPATH_PREFIX } from "./worktree";

const wt = (name: string, worktreePath: string | null) =>
  ({ name, kind: "worktree", worktreePath }) as const;
const local = (name: string) =>
  ({ name, kind: "local", worktreePath: null }) as const;

describe("discoveredWorktrees", () => {
  it("finds a Termigo sandbox from git's worktree entries", () => {
    const found = discoveredWorktrees([
      wt("termigo-sandbox/abc123", "/repo/.wt/abc123"),
    ]);
    expect(found).toEqual([
      {
        id: "abc123",
        worktreePath: "/repo/.wt/abc123",
        branchName: "termigo-sandbox/abc123",
      },
    ]);
  });

  // Git reports native separators, so a Windows path has to parse too.
  it("parses a Windows path", () => {
    const found = discoveredWorktrees([
      wt("termigo-sandbox/win7", "C:\\repo\\.wt\\win7"),
    ]);
    expect(found.map((w) => w.id)).toEqual(["win7"]);
  });

  it("parses a relative worktree path", () => {
    const found = discoveredWorktrees([
      wt("termigo-sandbox/rel1", ".wt/rel1"),
    ]);
    expect(found.map((w) => w.id)).toEqual(["rel1"]);
  });

  // THE dangerous case. A worktree the user created for their own work must never
  // be reported as a Termigo sandbox, because the report is what `worktree_discard`
  // acts on.
  it("ignores the user's own worktrees that are not Termigo sandboxes", () => {
    const found = discoveredWorktrees([
      wt("feature/login", "/repo/../repo-feature-login"),
      wt("hotfix", "/repo/.worktrees/hotfix"),
      wt("other", "/repo/vendor/worktrees/thing"),
    ]);
    expect(found).toEqual([]);
  });

  // A directory merely NAMED like the marker is not the marker.
  it("requires the marker to be a whole path segment", () => {
    const found = discoveredWorktrees([
      wt("x", "/repo/not.termigo/wt/x"),
      wt("y", "/repo/my.termigo/wt/y"),
    ]);
    expect(found).toEqual([]);
  });

  it("ignores ordinary branches", () => {
    expect(discoveredWorktrees([local("main"), local("dev")])).toEqual([]);
  });

  it("ignores a worktree entry with no path", () => {
    expect(discoveredWorktrees([wt("termigo-sandbox/a", null)])).toEqual([]);
  });

  // Git lists a worktree once per checkout but the shape is not guaranteed, and a
  // duplicate id would produce two rows for one directory.
  it("returns each sandbox once even when git lists it twice", () => {
    const found = discoveredWorktrees([
      wt("termigo-sandbox/dup", "/repo/.wt/dup"),
      wt("termigo-sandbox/dup", "/repo/.wt/dup"),
    ]);
    expect(found).toHaveLength(1);
  });

  it("finds several sandboxes at once", () => {
    const found = discoveredWorktrees([
      wt("termigo-sandbox/a", "/repo/.wt/a"),
      local("main"),
      wt("termigo-sandbox/b", "/repo/.wt/b"),
    ]);
    expect(found.map((w) => w.id).sort()).toEqual(["a", "b"]);
  });

  it("exposes the marker the rest of the code builds paths from", () => {
    expect(WORKTREE_SUBPATH_PREFIX).toBe(".wt/");
  });
});
