// Pure selection logic for the opt-in idle-tab reaper. Kept apart from the hook
// so the safeguards (never the active tab, never the last tab of a space, never
// unsaved work) are testable without React or timers.

import { nextActiveInSpace, type Tab } from "@/modules/tabs";

/** How often the reaper wakes up to look for idle tabs. */
export const IDLE_TAB_TICK_MS = 30_000;

/**
 * Whether a tab may be closed without asking, ignoring the async
 * "is a process still running in it" check the caller does for terminals.
 *
 * A dirty editor holds unsaved work; an `ai-diff` tab carries a pending
 * approval whose dismissal would reject the agent's change; an extension tab
 * may be running work this layer cannot inspect. All three are off limits.
 */
export function isTabSafeToAutoClose(tab: Tab): boolean {
  if (tab.kind === "editor") return !tab.dirty;
  if (tab.kind === "ai-diff") return false;
  if (tab.kind === "ext") return false;
  return true;
}

/**
 * Tabs left inactive for at least `minIdleMs`, minus the ones closing would
 * destroy. `lastActiveAt` is keyed by tab id; a tab missing from it is treated
 * as unknown rather than idle, so a restored tab gets a full grace period.
 */
export function selectIdleTabsToClose({
  tabs,
  activeId,
  lastActiveAt,
  now,
  minIdleMs,
}: {
  tabs: Tab[];
  activeId: number;
  lastActiveAt: ReadonlyMap<number, number>;
  now: number;
  minIdleMs: number;
}): Tab[] {
  const remaining = [...tabs];
  const selected: Tab[] = [];
  for (const tab of tabs) {
    if (tab.id === activeId) continue;
    if (nextActiveInSpace(remaining, tab.id) === null) continue;
    const since = lastActiveAt.get(tab.id);
    if (since === undefined || now - since < minIdleMs) continue;
    if (!isTabSafeToAutoClose(tab)) continue;
    selected.push(tab);
    const idx = remaining.findIndex((t) => t.id === tab.id);
    if (idx !== -1) remaining.splice(idx, 1);
  }
  return selected;
}

/**
 * Refresh the last-active clock: the active tab is stamped now, every tab seen
 * for the first time is stamped now, and ids that no longer exist are dropped
 * so the map cannot grow with closed tabs.
 */
export function stampTabActivity({
  tabs,
  activeId,
  lastActiveAt,
  now,
}: {
  tabs: Tab[];
  activeId: number;
  lastActiveAt: Map<number, number>;
  now: number;
}): void {
  const live = new Set<number>();
  for (const tab of tabs) {
    live.add(tab.id);
    if (tab.id === activeId || !lastActiveAt.has(tab.id)) {
      lastActiveAt.set(tab.id, now);
    }
  }
  for (const id of [...lastActiveAt.keys()]) {
    if (!live.has(id)) lastActiveAt.delete(id);
  }
}
