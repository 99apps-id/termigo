import { native } from "@/modules/ai/lib/native";
import type { Tab } from "@/modules/tabs";
import {
  disposeSession,
  hasLeaf,
  leafIds,
  ptyIdForLeaf,
  type TerminalPaneHandle,
  useAgentActivityStore,
  writeToSession,
} from "@/modules/terminal";
import { isSshLeaf } from "@/modules/terminal/lib/panes";
import { DEV_URL_EVENT } from "@/modules/terminal/lib/useTerminalSession";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { SearchAddon } from "@xterm/addon-search";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

type Params = {
  tabs: Tab[];
  tabsRef: RefObject<Tab[]>;
  activeId: number;
  activeLeafId: number | null;
  isTerminalTab: boolean;
  closePaneByLeaf: (leafId: number) => void;
  setLeafCwd: (leafId: number, cwd: string) => void;
  setLeafTitle: (leafId: number, title: string) => void;
  openPreviewTab: (url: string, browserInstance?: string) => number;
  isSwitchingWorkspaceRef: RefObject<boolean>;
};

export function useTerminalLifecycle({
  tabs,
  tabsRef,
  activeId,
  activeLeafId,
  isTerminalTab,
  closePaneByLeaf,
  setLeafCwd,
  setLeafTitle,
  openPreviewTab,
  isSwitchingWorkspaceRef,
}: Params) {
  const searchAddons = useRef<Map<number, SearchAddon>>(new Map());
  const [activeSearchAddon, setActiveSearchAddon] =
    useState<SearchAddon | null>(null);
  const terminalRefs = useRef<Map<number, TerminalPaneHandle>>(new Map());
  const liveLeavesRef = useRef<Set<number>>(new Set());
  const authorizedCwds = useRef<Set<string>>(new Set());

  const clearTerminalState = useCallback(() => {
    for (const id of liveLeavesRef.current) disposeSession(id);
    liveLeavesRef.current.clear();
    searchAddons.current.clear();
    terminalRefs.current.clear();
    setActiveSearchAddon(null);
  }, []);

  const handleSearchReady = useCallback(
    (leafId: number, addon: SearchAddon) => {
      searchAddons.current.set(leafId, addon);
      if (leafId === activeLeafId) setActiveSearchAddon(addon);
    },
    [activeLeafId],
  );

  const registerTerminalHandle = useCallback(
    (leafId: number, h: TerminalPaneHandle | null) => {
      if (h) terminalRefs.current.set(leafId, h);
      else terminalRefs.current.delete(leafId);
    },
    [],
  );

  useEffect(() => {
    setActiveSearchAddon(
      activeLeafId !== null
        ? (searchAddons.current.get(activeLeafId) ?? null)
        : null,
    );
  }, [activeLeafId]);

  // Drives session disposal off the pane tree, not React lifecycles -
  // split/unsplit re-mount components but the leaf is still live.
  useEffect(() => {
    const live = new Set<number>();
    for (const t of tabs) {
      if (t.kind === "terminal") {
        for (const id of leafIds(t.paneTree)) live.add(id);
      }
    }
    for (const id of liveLeavesRef.current) {
      if (!live.has(id)) disposeSession(id);
    }
    liveLeavesRef.current = live;
    for (const k of [...terminalRefs.current.keys()])
      if (!live.has(k)) terminalRefs.current.delete(k);
    for (const k of [...searchAddons.current.keys()])
      if (!live.has(k)) searchAddons.current.delete(k);
  }, [tabs]);

  // Acknowledge attention when a terminal tab becomes active
  useEffect(() => {
    const tab = tabsRef.current.find((t) => t.id === activeId);
    if (tab?.kind !== "terminal") return;
    const ptyIds = leafIds(tab.paneTree).flatMap((leafId) => {
      const ptyId = ptyIdForLeaf(leafId);
      return ptyId === null ? [] : [ptyId];
    });
    useAgentActivityStore.getState().acknowledgeAttention(ptyIds);
  }, [activeId, tabsRef]);

  // A dev server printed a local url in a terminal.
  useEffect(() => {
    const onDevUrl = (e: Event) => {
      const url = (e as CustomEvent<string>).detail;
      if (!url) return;
      toast(`Dev server: ${url}`, {
        id: `dev-url:${url}`,
        action: {
          label: "Buka",
          onClick: () => openPreviewTab(url),
        },
      });
    };
    window.addEventListener(DEV_URL_EVENT, onDevUrl);
    return () => window.removeEventListener(DEV_URL_EVENT, onDevUrl);
  }, [openPreviewTab]);

  const handleTerminalCwd = useCallback(
    (leafId: number, cwd: string) => {
      setLeafCwd(leafId, cwd);
      // An SSH leaf reports remote paths. Authorizing one would canonicalize a
      // remote path against the local filesystem, which fails.
      const onSsh = tabsRef.current.some(
        (t) => t.kind === "terminal" && isSshLeaf(t.paneTree, leafId),
      );
      if (onSsh) return;
      if (cwd && !authorizedCwds.current.has(cwd)) {
        authorizedCwds.current.add(cwd);
        native.workspaceAuthorize(cwd).catch(() => {
          authorizedCwds.current.delete(cwd);
        });
      }
    },
    [setLeafCwd, tabsRef],
  );

  const handleTerminalTitle = useCallback(
    (leafId: number, title: string) => setLeafTitle(leafId, title),
    [setLeafTitle],
  );

  const handleLeafExit = useCallback(
    (leafId: number, _code: number) => {
      // Never quit or close panes if a workspace switch is in progress.
      if (isSwitchingWorkspaceRef.current) return;
      const all = tabsRef.current;
      const tab = all.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (tab?.kind !== "terminal") return;
      // Last pane of the last tab: quit instead of respawning a shell.
      if (leafIds(tab.paneTree).length === 1 && all.length === 1) {
        void getCurrentWindow().close();
      } else {
        closePaneByLeaf(leafId);
      }
    },
    [closePaneByLeaf, isSwitchingWorkspaceRef, tabsRef],
  );

  const insertHistoryCommand = useMemo(
    () =>
      isTerminalTab && activeLeafId !== null
        ? (cmd: string) => {
            writeToSession(activeLeafId, cmd);
            terminalRefs.current.get(activeLeafId)?.focus();
          }
        : null,
    [isTerminalTab, activeLeafId],
  );

  return {
    searchAddons,
    activeSearchAddon,
    terminalRefs,
    liveLeavesRef,
    clearTerminalState,
    handleSearchReady,
    registerTerminalHandle,
    handleTerminalCwd,
    handleTerminalTitle,
    handleLeafExit,
    insertHistoryCommand,
  };
}
