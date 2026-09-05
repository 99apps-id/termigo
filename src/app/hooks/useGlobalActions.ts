import { usePresence } from "@/lib/usePresence";
import { quoteShellArg } from "@/lib/shellQuote";
import { useZoom } from "@/lib/useZoom";
import { nextAttentionTarget } from "@/modules/agents";
import { useChatStore, useSelectionAskAi } from "@/modules/ai";
import type { EditorPaneHandle } from "@/modules/editor";
import type { SearchInlineHandle } from "@/modules/header";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import {
  type ShortcutHandlers,
  type ShortcutId,
  shouldDisablePaneSwapShortcut,
  useGlobalShortcuts,
} from "@/modules/shortcuts";
import { useSpaces } from "@/modules/spaces";
import type { Tab } from "@/modules/tabs";
import { DEFAULT_SPACE_ID } from "@/modules/tabs/lib/useTabs";
import {
  clearFocusedTerminal,
  leafIds,
  navigateFocusedBlocks,
  type PaneBounds,
  type TerminalPaneHandle,
} from "@/modules/terminal";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTabSwitcher } from "@/modules/tabs";
import { TOGGLE_BLOCK_INPUT_EVENT } from "../components/WorkspaceInputBar";

type Params = {
  tabs: Tab[];
  tabsRef: RefObject<Tab[]>;
  activeId: number;
  setActiveId: (id: number) => void;
  activeTab: Tab | undefined;
  activeTerminalTab: Tab | null;
  activeLeafId: number | null;
  activeSpaceId: string | null;
  inheritedCwdForNewTab: () => string | undefined;
  newTab: (cwd?: string) => number;
  newBlockTab: (cwd?: string) => number;
  newPrivateTab: (cwd?: string) => number;
  openPreviewTab: (url: string, browserInstance?: string) => number;
  setNewEditorOpen: (open: boolean) => void;
  handleClose: (tabId: number) => Promise<boolean>;
  selectByIndex: (index: number, spaceId: string) => void;
  splitActivePane: (tabId: number, direction: "row" | "col") => void;
  swapActivePaneInDirection: (
    tabId: number,
    direction: "left" | "right" | "up" | "down",
    bounds: PaneBounds[],
  ) => void;
  focusNextPaneInTab: (tabId: number, delta: 1 | -1) => void;
  closeActivePane: (tabId: number) => void;
  focusPane: (tabId: number, leafId: number) => void;
  toggleSourceControl: () => void;
  hasComposer: boolean;
  toggleSidebar: () => void;
  toggleExplorerFocus: () => void;
  openCommandPalette: (mode?: "commands" | "content") => void;
  setSwitcherOpen: (open: boolean) => void;
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
  editorRefs: RefObject<Map<number, EditorPaneHandle>>;
  searchInlineRef: RefObject<SearchInlineHandle | null>;
};

export function useGlobalActions({
  tabs,
  tabsRef,
  activeId,
  setActiveId,
  activeTab,
  activeTerminalTab,
  activeLeafId,
  activeSpaceId,
  inheritedCwdForNewTab,
  newTab,
  newBlockTab,
  newPrivateTab,
  openPreviewTab,
  setNewEditorOpen,
  handleClose,
  selectByIndex,
  splitActivePane,
  swapActivePaneInDirection,
  focusNextPaneInTab,
  closeActivePane,
  focusPane,
  toggleSourceControl,
  hasComposer,
  toggleSidebar,
  toggleExplorerFocus,
  openCommandPalette,
  setSwitcherOpen,
  terminalRefs,
  editorRefs,
  searchInlineRef,
}: Params) {
  const [zenMode, setZenMode] = useState(false);
  const { zoomIn, zoomOut, zoomReset } = useZoom();

  const openPanel = useChatStore((s) => s.openPanel);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const toggleMini = useChatStore((s) => s.toggleMini);
  const focusInput = useChatStore((s) => s.focusInput);
  const attachSelection = useChatStore((s) => s.attachSelection);

  // Most-recently-used tab ids, most recent first, pruned to live tabs.
  const mruRef = useRef<number[]>([activeId]);
  useEffect(() => {
    mruRef.current = [
      activeId,
      ...mruRef.current.filter((id) => id !== activeId),
    ];
  }, [activeId]);
  useEffect(() => {
    const live = new Set(tabs.map((t) => t.id));
    mruRef.current = mruRef.current.filter((id) => live.has(id));
  }, [tabs]);

  const getSwitcherOrder = useCallback(() => {
    const space = activeSpaceId ?? DEFAULT_SPACE_ID;
    const inSpace = tabsRef.current
      .filter((t) => t.spaceId === space)
      .map((t) => t.id);
    const present = new Set(inSpace);
    const ordered = mruRef.current.filter((id) => present.has(id));
    for (const id of inSpace) if (!ordered.includes(id)) ordered.push(id);
    return [activeId, ...ordered.filter((id) => id !== activeId)];
  }, [activeId, activeSpaceId, tabsRef]);

  const { state: switcherState, step: stepSwitcher } = useTabSwitcher({
    getOrder: getSwitcherOrder,
    onCommit: (id) => {
      if (tabsRef.current.some((t) => t.id === id)) setActiveId(id);
    },
  });

  const cycleSpace = useCallback((delta: 1 | -1) => {
    const { spaces, activeId: sid, setActive } = useSpaces.getState();
    if (spaces.length < 2) return;
    const idx = spaces.findIndex((s) => s.id === sid);
    const next = (idx + delta + spaces.length) % spaces.length;
    setActive(spaces[next].id);
  }, []);

  const captureActiveSelection = useCallback((): string | null => {
    const t = tabs.find((x) => x.id === activeId);
    if (!t) return null;
    if (t.kind === "terminal") {
      const lid = t.activeLeafId;
      return terminalRefs.current?.get(lid)?.getSelection() ?? null;
    }
    if (t.kind === "editor") {
      return editorRefs.current?.get(activeId)?.getSelection() ?? null;
    }
    return null;
  }, [tabs, activeId, terminalRefs, editorRefs]);

  const togglePanelAndFocus = useCallback(() => {
    if (!hasComposer) {
      void openSettingsWindow("models");
      return;
    }
    if (panelOpen) {
      useChatStore.getState().closePanel();
    } else {
      openPanel();
      focusInput(null);
    }
  }, [hasComposer, panelOpen, openPanel, focusInput]);

  const handleAttachFileToAgent = useCallback(
    (path: string) => {
      if (!hasComposer) {
        void openSettingsWindow("models");
        return;
      }
      window.dispatchEvent(
        new CustomEvent<string>("termigo:ai-attach-file", { detail: path }),
      );
      openPanel();
      focusInput(null);
    },
    [hasComposer, openPanel, focusInput],
  );

  const askFromSelection = useCallback(() => {
    if (!hasComposer) {
      void openSettingsWindow("models");
      return;
    }
    const selection = captureActiveSelection();
    if (!selection?.trim()) {
      focusInput(null);
      return;
    }
    const source: "terminal" | "editor" =
      activeTab?.kind === "editor" ? "editor" : "terminal";
    attachSelection(selection, source);
  }, [
    hasComposer,
    captureActiveSelection,
    focusInput,
    attachSelection,
    activeTab,
  ]);

  const { askPopup, setAskPopup, onAskFromSelection } = useSelectionAskAi({
    captureActiveSelection,
    askFromSelection,
  });
  const askPresence = usePresence(Boolean(askPopup), 120);

  const openNewTab = useCallback(() => {
    newTab(inheritedCwdForNewTab());
  }, [newTab, inheritedCwdForNewTab]);

  const openNewPrivateTab = useCallback(() => {
    newPrivateTab(inheritedCwdForNewTab());
  }, [newPrivateTab, inheritedCwdForNewTab]);

  const openNewBlockTab = useCallback(() => {
    newBlockTab(inheritedCwdForNewTab());
  }, [newBlockTab, inheritedCwdForNewTab]);

  const sendCd = useCallback(
    (path: string) => {
      if (activeLeafId === null) return;
      const term = terminalRefs.current?.get(activeLeafId);
      if (!term) return;
      term.write(`cd ${quoteShellArg(path)}\r`);
      term.focus();
    },
    [activeLeafId, terminalRefs],
  );

  const cdInNewTab = useCallback(
    (path: string) => {
      const tabId = newTab(path);
      setTimeout(() => {
        const tab = tabsRef.current.find((x) => x.id === tabId);
        if (tab?.kind !== "terminal") return;
        const t = terminalRefs.current?.get(tab.activeLeafId);
        if (!t) return;
        t.write(`cd ${quoteShellArg(path)}\r`);
        t.focus();
      }, 80);
    },
    [newTab, tabsRef, terminalRefs],
  );

  const livePaneBounds = useCallback((tabId: number): PaneBounds[] => {
    const tab = document.querySelector<HTMLElement>(
      `[data-terminal-tab="${tabId}"]`,
    );
    if (!tab) return [];
    return [...tab.querySelectorAll<HTMLElement>("[data-pane-leaf]")].flatMap(
      (element) => {
        const id = Number(element.dataset.paneLeaf);
        if (!Number.isFinite(id)) return [];
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return [{ id, left, right, top, bottom }];
      },
    );
  }, []);

  const splitActivePaneInActiveTab = useCallback(
    (dir: "row" | "col") => {
      const t = tabsRef.current.find((x) => x.id === activeId);
      if (t?.kind !== "terminal") return;
      splitActivePane(activeId, dir);
    },
    [activeId, splitActivePane, tabsRef],
  );

  const swapActivePane = useCallback(
    (direction: "left" | "right" | "up" | "down") => {
      swapActivePaneInDirection(activeId, direction, livePaneBounds(activeId));
    },
    [activeId, livePaneBounds, swapActivePaneInDirection],
  );

  const handleCloseTabOrPane = useCallback(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t?.kind === "terminal" && leafIds(t.paneTree).length > 1) {
      closeActivePane(activeId);
      return;
    }
    void handleClose(activeId);
  }, [activeId, closeActivePane, handleClose, tabsRef]);

  const activateAgentTarget = useCallback(
    (tabId: number, leafId: number) => {
      const space = tabsRef.current.find((t) => t.id === tabId)?.spaceId;
      if (space && space !== useSpaces.getState().activeId) {
        useSpaces.getState().setActive(space);
      }
      setActiveId(tabId);
      focusPane(tabId, leafId);
    },
    [setActiveId, focusPane, tabsRef],
  );

  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      "commandPalette.open": () => openCommandPalette("commands"),
      "commandPalette.content": () => openCommandPalette("content"),
      "tab.new": openNewTab,
      "tab.newBlock": openNewBlockTab,
      "tab.newPrivate": openNewPrivateTab,
      "tab.newPreview": () => openPreviewTab(""),
      "tab.newEditor": () => setNewEditorOpen(true),
      "tab.close": handleCloseTabOrPane,
      "tab.next": () => stepSwitcher(1),
      "tab.prev": () => stepSwitcher(-1),
      "tab.selectByIndex": (e) =>
        selectByIndex(
          parseInt(e.key, 10) - 1,
          activeSpaceId ?? DEFAULT_SPACE_ID,
        ),
      "space.next": () => cycleSpace(1),
      "space.prev": () => cycleSpace(-1),
      "space.overview": () => setSwitcherOpen(true),
      "pane.splitRight": () => splitActivePaneInActiveTab("row"),
      "pane.splitDown": () => splitActivePaneInActiveTab("col"),
      "pane.focusNext": () => focusNextPaneInTab(activeId, 1),
      "pane.focusPrev": () => focusNextPaneInTab(activeId, -1),
      "pane.swapLeft": () => swapActivePane("left"),
      "pane.swapRight": () => swapActivePane("right"),
      "pane.swapUp": () => swapActivePane("up"),
      "pane.swapDown": () => swapActivePane("down"),
      "pane.source": toggleSourceControl,
      "terminal.clear": () => {
        clearFocusedTerminal();
      },
      "terminal.toggleInput": () =>
        window.dispatchEvent(new CustomEvent(TOGGLE_BLOCK_INPUT_EVENT)),
      "blocks.prev": () => navigateFocusedBlocks(-1),
      "blocks.next": () => navigateFocusedBlocks(1),
      "search.focus": () => {
        const editor = editorRefs.current?.get(activeId);
        if (editor) editor.openSearch();
        else searchInlineRef.current?.focus();
      },
      "ai.toggle": togglePanelAndFocus,
      "ai.toggleMini": () => {
        if (!hasComposer) {
          void openSettingsWindow("models");
          return;
        }
        toggleMini();
      },
      "ai.askSelection": onAskFromSelection,
      "agent.focusAttention": () => {
        const t = nextAttentionTarget();
        if (t) activateAgentTarget(t.tabId, t.leafId);
      },
      "settings.open": () => void openSettingsWindow(),
      "sidebar.toggle": toggleSidebar,
      "explorer.focus": toggleExplorerFocus,
      "view.zoomIn": zoomIn,
      "view.zoomOut": zoomOut,
      "view.zoomReset": zoomReset,
      "view.zenMode": () => setZenMode((v) => !v),
      "editor.undo": () => editorRefs.current?.get(activeId)?.undo(),
      "editor.redo": () => editorRefs.current?.get(activeId)?.redo(),
      "editor.aiComplete": () =>
        editorRefs.current?.get(activeId)?.triggerAiComplete(),
      "editor.codeComplete": () =>
        editorRefs.current?.get(activeId)?.triggerCodeComplete(),
    }),
    [
      activeId,
      openCommandPalette,
      stepSwitcher,
      cycleSpace,
      handleCloseTabOrPane,
      openNewTab,
      openNewBlockTab,
      openNewPrivateTab,
      openPreviewTab,
      setNewEditorOpen,
      activeSpaceId,
      selectByIndex,
      setSwitcherOpen,
      splitActivePaneInActiveTab,
      focusNextPaneInTab,
      swapActivePane,
      toggleSourceControl,
      editorRefs,
      searchInlineRef,
      hasComposer,
      togglePanelAndFocus,
      toggleMini,
      onAskFromSelection,
      activateAgentTarget,
      toggleSidebar,
      toggleExplorerFocus,
      zoomIn,
      zoomOut,
      zoomReset,
    ],
  );

  const shortcutsDisabled = useCallback(
    (id: ShortcutId, e: KeyboardEvent) => {
      const terminalPaneCount =
        activeTab?.kind === "terminal"
          ? leafIds(activeTab.paneTree).length
          : null;
      if (shouldDisablePaneSwapShortcut(id, terminalPaneCount)) return true;
      if (
        id === "editor.undo" ||
        id === "editor.redo" ||
        id === "editor.aiComplete" ||
        id === "editor.codeComplete"
      ) {
        return activeTab?.kind !== "editor";
      }
      if (id === "ai.askSelection") {
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        const inTerminal = !!(target as HTMLElement | null)?.closest?.(
          ".xterm",
        );
        if (!inTerminal) return false;
        const sel = captureActiveSelection();
        return !sel?.trim();
      }
      if (id === "terminal.clear") {
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        return !(target as HTMLElement | null)?.closest?.(".xterm");
      }
      if (
        id === "terminal.toggleInput" ||
        id === "blocks.prev" ||
        id === "blocks.next"
      ) {
        return !(activeTab?.kind === "terminal" && activeTab.blocks === true);
      }
      if (id === "sidebar.toggle") {
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        const inTerminal = !!(target as HTMLElement | null)?.closest?.(
          ".xterm",
        );
        return inTerminal && !e.shiftKey;
      }
      return false;
    },
    [activeTab, captureActiveSelection],
  );

  useGlobalShortcuts(shortcutHandlers, { isDisabled: shortcutsDisabled });

  return {
    zenMode,
    setZenMode,
    switcherState,
    stepSwitcher,
    cycleSpace,
    captureActiveSelection,
    togglePanelAndFocus,
    handleAttachFileToAgent,
    askFromSelection,
    askPopup,
    setAskPopup,
    askPresence,
    openNewTab,
    openNewPrivateTab,
    openNewBlockTab,
    sendCd,
    cdInNewTab,
    splitActivePaneInActiveTab,
    swapActivePane,
    handleCloseTabOrPane,
    activateAgentTarget,
    zoomIn,
    zoomOut,
    zoomReset,
  };
}
