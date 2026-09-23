import type { Tab } from "@/modules/tabs";
import { describe, expect, it } from "vitest";
import {
  isTabSafeToAutoClose,
  selectIdleTabsToClose,
  stampTabActivity,
} from "./idleTabReap";

function tab(id: number, spaceId: string, kind: Tab["kind"] = "editor"): Tab {
  const base = { id, kind, spaceId, title: `tab-${id}` };
  if (kind === "editor") {
    return {
      ...base,
      path: `/file-${id}`,
      dirty: false,
      preview: false,
    } as Tab;
  }
  if (kind === "terminal") {
    return {
      ...base,
      paneTree: { kind: "leaf", id, cwd: "/" },
    } as unknown as Tab;
  }
  return base as unknown as Tab;
}

const MINUTE = 60_000;

describe("isTabSafeToAutoClose", () => {
  it("allows a clean editor and a terminal", () => {
    expect(isTabSafeToAutoClose(tab(1, "a", "editor"))).toBe(true);
    expect(isTabSafeToAutoClose(tab(2, "a", "terminal"))).toBe(true);
    expect(isTabSafeToAutoClose(tab(3, "a", "markdown"))).toBe(true);
    expect(isTabSafeToAutoClose(tab(4, "a", "git-diff"))).toBe(true);
  });

  it("refuses a dirty editor so unsaved work is never lost", () => {
    const dirty = { ...tab(1, "a", "editor"), dirty: true } as Tab;
    expect(isTabSafeToAutoClose(dirty)).toBe(false);
  });

  it("refuses an ai-diff (pending approval) and an extension tab", () => {
    expect(isTabSafeToAutoClose(tab(1, "a", "ai-diff"))).toBe(false);
    expect(isTabSafeToAutoClose(tab(2, "a", "ext"))).toBe(false);
  });
});

describe("selectIdleTabsToClose", () => {
  it("returns an idle, closable, non-active tab", () => {
    const tabs = [tab(1, "a"), tab(2, "a")];
    const picked = selectIdleTabsToClose({
      tabs,
      activeId: 1,
      lastActiveAt: new Map([[2, 0]]),
      now: 31 * MINUTE,
      minIdleMs: 30 * MINUTE,
    });
    expect(picked.map((t) => t.id)).toEqual([2]);
  });

  it("never returns the active tab even when it looks idle", () => {
    const tabs = [tab(1, "a"), tab(2, "a")];
    const picked = selectIdleTabsToClose({
      tabs,
      activeId: 2,
      lastActiveAt: new Map([[2, 0]]),
      now: 99 * MINUTE,
      minIdleMs: 30 * MINUTE,
    });
    expect(picked).toEqual([]);
  });

  it("holds a tab until it has been idle long enough", () => {
    const tabs = [tab(1, "a"), tab(2, "a")];
    const picked = selectIdleTabsToClose({
      tabs,
      activeId: 1,
      lastActiveAt: new Map([[2, 29 * MINUTE]]),
      now: 30 * MINUTE,
      minIdleMs: 30 * MINUTE,
    });
    expect(picked).toEqual([]);
  });

  it("keeps the last tab of a space so the space is never emptied", () => {
    const tabs = [tab(1, "a"), tab(2, "b")];
    const picked = selectIdleTabsToClose({
      tabs,
      activeId: 1,
      lastActiveAt: new Map([
        [1, 0],
        [2, 0],
      ]),
      now: 99 * MINUTE,
      minIdleMs: 30 * MINUTE,
    });
    expect(picked).toEqual([]);
  });

  it("treats an unknown tab as freshly used, not idle", () => {
    const tabs = [tab(1, "a"), tab(2, "a")];
    const picked = selectIdleTabsToClose({
      tabs,
      activeId: 1,
      lastActiveAt: new Map(),
      now: 99 * MINUTE,
      minIdleMs: 30 * MINUTE,
    });
    expect(picked).toEqual([]);
  });

  it("drops a dirty editor and an ai-diff from the idle set", () => {
    const tabs = [
      tab(1, "a"),
      { ...tab(2, "a", "editor"), dirty: true } as Tab,
      tab(3, "a", "ai-diff"),
      tab(4, "a", "terminal"),
    ];
    const picked = selectIdleTabsToClose({
      tabs,
      activeId: 1,
      lastActiveAt: new Map([
        [2, 0],
        [3, 0],
        [4, 0],
      ]),
      now: 99 * MINUTE,
      minIdleMs: 30 * MINUTE,
    });
    expect(picked.map((t) => t.id)).toEqual([4]);
  });
});

describe("stampTabActivity", () => {
  it("stamps the active tab and every tab seen for the first time", () => {
    const map = new Map<number, number>();
    stampTabActivity({
      tabs: [tab(1, "a"), tab(2, "a")],
      activeId: 1,
      lastActiveAt: map,
      now: 1000,
    });
    expect(map.get(1)).toBe(1000);
    expect(map.get(2)).toBe(1000);
  });

  it("does not reset the clock of a tab that is merely still open", () => {
    const map = new Map([[2, 500]]);
    stampTabActivity({
      tabs: [tab(1, "a"), tab(2, "a")],
      activeId: 1,
      lastActiveAt: map,
      now: 9000,
    });
    expect(map.get(2)).toBe(500);
  });

  it("moves the stamp forward when a tab becomes active again", () => {
    const map = new Map([
      [1, 100],
      [2, 200],
    ]);
    stampTabActivity({
      tabs: [tab(1, "a"), tab(2, "a")],
      activeId: 2,
      lastActiveAt: map,
      now: 7000,
    });
    expect(map.get(2)).toBe(7000);
    expect(map.get(1)).toBe(100);
  });

  it("forgets tabs that no longer exist", () => {
    const map = new Map([
      [1, 100],
      [2, 200],
      [3, 300],
    ]);
    stampTabActivity({
      tabs: [tab(2, "a"), tab(3, "a")],
      activeId: 2,
      lastActiveAt: map,
      now: 4000,
    });
    expect([...map.keys()].sort()).toEqual([2, 3]);
  });
});
