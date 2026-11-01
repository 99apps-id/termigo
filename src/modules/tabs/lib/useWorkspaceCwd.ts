import { canonicalDirPath } from "@/lib/path";
import { findLeafCwd } from "@/modules/terminal/lib/panes";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Tab } from "./useTabs";

type Result = {
  explorerRoot: string | null;
  inheritedCwdForNewTab: () => string | undefined;
};

export function normalizeWorkspaceCwd(cwd: string): string {
  return canonicalDirPath(cwd);
}

export function getTerminalTabCwd(tab: Tab | undefined): string | undefined {
  if (tab?.kind !== "terminal") return undefined;
  return findLeafCwd(tab.paneTree, tab.activeLeafId) ?? tab.cwd;
}

export function resolveWorkspaceRoot(
  activeTab: Tab | undefined,
  tabs: Tab[],
  home: string | null,
  lastTerminalCwd: string | null = null,
): string | null {
  const activeCwd = getTerminalTabCwd(activeTab);
  if (activeCwd) return normalizeWorkspaceCwd(activeCwd);
  if (lastTerminalCwd) return lastTerminalCwd;
  for (const t of tabs) {
    const cwd = getTerminalTabCwd(t);
    if (cwd) return normalizeWorkspaceCwd(cwd);
  }
  return home;
}

export function useWorkspaceCwd(
  activeTab: Tab | undefined,
  tabs: Tab[],
  home: string | null,
): Result {
  const lastTerminalCwd = useRef<string | null>(null);

  const activeCwd = getTerminalTabCwd(activeTab);

  useEffect(() => {
    if (activeCwd) {
      lastTerminalCwd.current = normalizeWorkspaceCwd(activeCwd);
    }
  }, [activeCwd]);

  const explorerRoot = useMemo<string | null>(
    () => resolveWorkspaceRoot(activeTab, tabs, home, lastTerminalCwd.current),
    [activeTab, tabs, home],
  );

  const inheritedCwdForNewTab = useCallback((): string | undefined => {
    if (activeCwd) return normalizeWorkspaceCwd(activeCwd);
    // Editor tabs inherit the last terminal's cwd (or workspace home), not
    // the file's folder -- opening a new terminal from a file shouldn't
    // hijack the user's working directory context.
    return lastTerminalCwd.current ?? home ?? undefined;
  }, [activeCwd, home]);

  return { explorerRoot, inheritedCwdForNewTab };
}
