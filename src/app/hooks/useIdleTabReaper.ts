import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Tab } from "@/modules/tabs";
import { leafHasForegroundProcess, leafIds } from "@/modules/terminal";
import { useEffect, useLayoutEffect, useRef } from "react";
import {
  IDLE_TAB_TICK_MS,
  selectIdleTabsToClose,
  stampTabActivity,
} from "./idleTabReap";

type Params = {
  tabs: Tab[];
  activeId: number;
  disposeTab: (id: number) => void;
};

/**
 * Opt-in reaper for tabs left inactive past `autoCloseIdleTabsMinutes`. Closing
 * a tab is destructive (a terminal loses its scrollback and shell), so this is
 * off unless the user sets a minute count, and it only ever closes tabs the
 * safeguards in `selectIdleTabsToClose` plus a live-process probe allow.
 */
export function useIdleTabReaper({ tabs, activeId, disposeTab }: Params): void {
  const minutes = usePreferencesStore((s) => s.autoCloseIdleTabsMinutes);
  const lastActiveAt = useRef(new Map<number, number>());
  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);
  const disposeRef = useRef(disposeTab);
  const reaping = useRef(false);

  useLayoutEffect(() => {
    tabsRef.current = tabs;
    activeIdRef.current = activeId;
    disposeRef.current = disposeTab;
    stampTabActivity({
      tabs,
      activeId,
      lastActiveAt: lastActiveAt.current,
      now: Date.now(),
    });
  }, [tabs, activeId, disposeTab]);

  useEffect(() => {
    if (minutes <= 0) return;
    const minIdleMs = minutes * 60_000;
    const timer = setInterval(() => {
      void (async () => {
        if (reaping.current) return;
        reaping.current = true;
        try {
          const candidates = selectIdleTabsToClose({
            tabs: tabsRef.current,
            activeId: activeIdRef.current,
            lastActiveAt: lastActiveAt.current,
            now: Date.now(),
            minIdleMs,
          });
          for (const tab of candidates) {
            if (tab.kind === "terminal") {
              const leaves = leafIds(tab.paneTree);
              const busy = await Promise.all(
                leaves.map(leafHasForegroundProcess),
              );
              if (busy.some(Boolean)) continue;
            }
            // The probe awaited: the user may have switched back or a guard may
            // now refuse the close, so re-check before acting.
            if (tab.id === activeIdRef.current) continue;
            if (disposeRef.current) disposeRef.current(tab.id);
          }
        } finally {
          reaping.current = false;
        }
      })();
    }, IDLE_TAB_TICK_MS);
    return () => clearInterval(timer);
  }, [minutes]);
}
