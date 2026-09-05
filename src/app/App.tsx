import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getLaunchDir } from "@/lib/launchDir";
import { PLATFORM } from "@/lib/platform";
import { usePresence } from "@/lib/usePresence";
import { isMarkdownPath } from "@/lib/utils";
import {
  type AgentLaunchRequest,
  AgentNotificationsBridge,
  findAgentLauncherWithCustom,
  validateAgentLaunchCommand,
} from "@/modules/agents";
import {
  AgentRunBridge,
  AiDockPanel,
  AiMiniWindow,
  LocalAgentNotificationsBridge,
  SelectionAskAi,
  useAiBootstrap,
  useAiLiveBridge,
  useChatStore,
} from "@/modules/ai";
import { setArtifactOpener } from "@/modules/ai/lib/artifactOpen";
import { AiComposerProvider } from "@/modules/ai/lib/composer";
import { CommandPalette, createCommandItems } from "@/modules/command-palette";
import { useControlBridge } from "@/modules/control";
import { runAgentTask } from "@/modules/control/lib/runAgentTask";
import {
  getPentestStatus,
  requestPentestReport,
  startPentestRun,
} from "@/modules/control/lib/startPentestRun";
import {
  type EditorPaneHandle,
  NewEditorDialog,
  useApplyEditorFontSize,
  useEditorFileSync,
} from "@/modules/editor";
import { FileExplorer, type FileExplorerHandle } from "@/modules/explorer";
import { RightPanelHost } from "@/modules/extensions/components/RightPanelHost";
import { useRightPanelStore } from "@/modules/extensions/rightPanelStore";
import type { GitHistorySearchHandle } from "@/modules/git-history";
import {
  Header,
  type SearchInlineHandle,
  type SearchTarget,
} from "@/modules/header";
import { setLspNavigator } from "@/modules/lsp";
import type { PreviewPaneHandle } from "@/modules/preview";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SidebarRail,
  useSidebarPanel,
} from "@/modules/sidebar";
import {
  SourceControlPanel,
  useRepositoryTargeting,
  useSourceControlContext,
} from "@/modules/source-control";
import {
  SpaceSwitcher,
  useSpacePersistence,
  useSpaces,
  useSpacesBoot,
} from "@/modules/spaces";
import { HostKeyPromptDialog } from "@/modules/ssh/HostKeyPromptDialog";
import { SshFileExplorer } from "@/modules/ssh/SshFileExplorer";
import { useSshActiveSessionStore } from "@/modules/ssh/sshActiveSession";
import { useSshRightPanelStore } from "@/modules/ssh/sshRightPanelStore";
import { StatusBar } from "@/modules/statusbar";
import {
  type CloseTabsPlan,
  type Tab,
  TabSwitcherHud,
  useTabs,
  useWindowTitle,
  useWorkspaceCwd,
} from "@/modules/tabs";
import { labelFor } from "@/modules/tabs/lib/tabLabel";
import { DEFAULT_SPACE_ID } from "@/modules/tabs/lib/useTabs";
import { useTelegramBot } from "@/modules/telegram/useTelegramBot";
import {
  useTerminalFileDrop,
  whenSessionReady,
  writeToSession,
} from "@/modules/terminal";
import { findLeafCwd, findLeafRemoteCwd } from "@/modules/terminal/lib/panes";
import { ThemeProvider, useThemeFileEditing } from "@/modules/theme";
import { UpdaterDialog } from "@/modules/updater";
import {
  useWorkspaceEnvStore,
  type WorkspaceEnv,
  workspaceScopeKey,
} from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { CloseDialogs } from "./components/CloseDialogs";
import { WorkspaceInputBar } from "./components/WorkspaceInputBar";
import { WorkspaceSurface } from "./components/WorkspaceSurface";
import { useAppCloseGuard } from "./hooks/useAppCloseGuard";
import { useGlobalActions } from "./hooks/useGlobalActions";
import { useTabCloseGuards } from "./hooks/useTabCloseGuards";
import { useTerminalLifecycle } from "./hooks/useTerminalLifecycle";
import { useWorkspaceBoot } from "./hooks/useWorkspaceBoot";
import { useWorkspaceSwitcher } from "./hooks/useWorkspaceSwitcher";

export default function App() {
  const {
    tabs,
    activeId,
    setActiveId,
    allocId,
    booted,
    replaceTabs,
    moveTabToSpace,
    reorderTab,
    reorderTabByGap,
    newTabInSpace,
    removeTabsForSpace,
    markBooted,
    setActiveSpaceForNewTabs,
    newTab,
    newBlockTab,
    newAgentTab,
    newAgentGroupTab,
    newPrivateTab,
    openFileTab,
    pinTab,
    newPreviewTab,
    openCanvasTab,
    newMarkdownTab,
    setMarkdownView,
    setOverrideLanguage,
    openAiDiffTab,
    closeAiDiffTab,
    openGitDiffTab,
    openCommitHistoryTab,
    openApiClientTab,
    openCommitFileDiffTab,
    closeTab,
    closeTabs,
    updateTab,
    selectByIndex,
    setLeafCwd,
    setLeafTitle,
    focusPane,
    focusNextPaneInTab,
    swapActivePaneInDirection,
    splitActivePane,
    closeActivePane,
    closePaneByLeaf,
    resetWorkspace,
    newSshTab,
  } = useTabs(getLaunchDir() ? { cwd: getLaunchDir() } : undefined);

  // Boot the extension host once the tab store exists
  useEffect(() => {
    void import("@/modules/extensions/store").then(({ useExtensionsStore }) =>
      useExtensionsStore.getState().init(),
    );
  }, []);

  // Relay Telegram messages to the in-app agent
  useTelegramBot();

  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);

  const activeTerminalTab = useMemo(() => {
    const t = tabs.find((x) => x.id === activeId);
    return t && t.kind === "terminal" ? t : null;
  }, [tabs, activeId]);
  const activeLeafId = activeTerminalTab?.activeLeafId ?? null;

  const searchInlineRef = useRef<SearchInlineHandle | null>(null);
  const editorRefs = useRef<Map<number, EditorPaneHandle>>(new Map());
  const previewRefs = useRef<Map<number, PreviewPaneHandle>>(new Map());
  const [activeEditorHandle, setActiveEditorHandle] =
    useState<EditorPaneHandle | null>(null);
  const [gitHistoryHandle, setGitHistoryHandle] =
    useState<GitHistorySearchHandle | null>(null);
  useApplyEditorFontSize();
  const explorerRef = useRef<FileExplorerHandle>(null);

  const activeTab = tabs.find((t) => t.id === activeId);
  const isTerminalTab = activeTab?.kind === "terminal";
  const isBlockTab = activeTerminalTab?.blocks === true;
  const isEditorTab = activeTab?.kind === "editor";
  const isGitHistoryTab = activeTab?.kind === "git-history";

  const openPreviewTab = useCallback(
    (url: string, browserInstance?: string) => {
      const id = newPreviewTab(url, browserInstance);
      if (!url) {
        setTimeout(() => previewRefs.current.get(id)?.focusAddressBar(), 0);
      }
      return id;
    },
    [newPreviewTab],
  );

  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const setWorkspaceEnv = useWorkspaceEnvStore((s) => s.setEnv);

  const clearTerminalStateRef = useRef<() => void>(() => {});
  const clearWorkspaceState = useCallback(() => {
    clearTerminalStateRef.current();
    editorRefs.current.clear();
    previewRefs.current.clear();
    setActiveEditorHandle(null);
  }, []);

  const {
    home,
    launchCwd,
    launchCwdResolved,
    switchWorkspace,
    adoptWorkspaceEnv,
    isSwitchingWorkspaceRef,
  } = useWorkspaceSwitcher({
    tabsRef,
    workspaceEnv,
    setWorkspaceEnv,
    resetWorkspace,
    clearWorkspaceState,
  });

  // Terminal lifecycle management (sessions, handles, search addons, attention)
  const {
    searchAddons,
    activeSearchAddon,
    terminalRefs,
    clearTerminalState,
    handleSearchReady,
    registerTerminalHandle,
    handleTerminalCwd,
    handleTerminalTitle,
    handleLeafExit,
    insertHistoryCommand,
  } = useTerminalLifecycle({
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
  });
  clearTerminalStateRef.current = clearTerminalState;

  const activeSpaceId = useSpaces((s) => s.activeId);
  const spacesHydrated = useSpaces((s) => s.hydrated);
  const activeSpaceIdRef = useRef(activeSpaceId);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
    activeIdRef.current = activeId;
    activeSpaceIdRef.current = activeSpaceId;
  }, [tabs, activeId, activeSpaceId]);
  const sourceControlSpaceId = activeSpaceId ?? DEFAULT_SPACE_ID;

  const handleWorkspaceChange = useCallback(
    async (env: WorkspaceEnv) => {
      const switched = await switchWorkspace(env);
      if (switched && activeSpaceId) {
        useSpaces.getState().setEnv(activeSpaceId, env);
      }
    },
    [switchWorkspace, activeSpaceId],
  );

  useSpacesBoot({
    ready: launchCwdResolved,
    launchCwd,
    home,
    allocId,
    replaceTabs,
    markBooted,
    setActiveSpaceForNewTabs,
    adoptWorkspaceEnv,
  });

  useSpacePersistence({
    tabs,
    activeId,
    activeSpaceId: activeSpaceId ?? DEFAULT_SPACE_ID,
    enabled: spacesHydrated,
  });

  const prevSpaceRef = useRef(activeSpaceId);
  useEffect(() => {
    if (!spacesHydrated || !activeSpaceId) return;
    setActiveSpaceForNewTabs(activeSpaceId);
    const prev = prevSpaceRef.current;
    prevSpaceRef.current = activeSpaceId;
    if (prev === null || prev === activeSpaceId) return;
    const meta = useSpaces
      .getState()
      .spaces.find((s) => s.id === activeSpaceId);
    if (meta) void adoptWorkspaceEnv(meta.env);
    const inSpace = tabsRef.current.filter((t) => t.spaceId === activeSpaceId);
    if (inSpace.length === 0) return;
    if (inSpace.some((t) => t.id === activeId)) return;
    setActiveId(inSpace[inSpace.length - 1].id);
  }, [
    activeSpaceId,
    activeId,
    spacesHydrated,
    setActiveSpaceForNewTabs,
    setActiveId,
    adoptWorkspaceEnv,
  ]);

  const [switcherOpen, setSwitcherOpen] = useState(false);

  const spaceTabs = useMemo(
    () => tabs.filter((t) => t.spaceId === (activeSpaceId ?? DEFAULT_SPACE_ID)),
    [tabs, activeSpaceId],
  );

  const {
    sidebarRef,
    sidebarWidthRef,
    sidebarView,
    initialSidebarCollapsed,
    persistSidebarView,
    persistSidebarCollapsed,
    toggleSidebar,
    cycleSidebarView,
    openSidebarView,
    persistSidebarWidth,
    toggleExplorerFocus,
  } = useSidebarPanel(explorerRef);

  const [newEditorOpen, setNewEditorOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [paletteInitialMode, setPaletteInitialMode] = useState<
    "commands" | "content"
  >("commands");
  const openCommandPalette = useCallback(
    (mode: "commands" | "content" = "commands") => {
      setPaletteInitialMode(mode);
      setCommandPaletteOpen(true);
    },
    [],
  );
  const miniOpen = useChatStore((s) => s.mini.open);
  const miniPresence = usePresence(miniOpen, 200);
  const openMini = useChatStore((s) => s.openMini);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const setLive = useChatStore((s) => s.setLive);
  const respondToApproval = useChatStore((s) => s.respondToApproval);

  const { hasComposer, keysLoaded } = useAiBootstrap();

  useEditorFileSync({ tabs, tabsRef, editorRefs });
  useThemeFileEditing({ tabsRef, openFileTab });

  const { explorerRoot, inheritedCwdForNewTab } = useWorkspaceCwd(
    activeTab,
    tabs,
    launchCwd ?? home,
  );

  useWindowTitle(activeTab, explorerRoot);

  useEffect(() => {
    setActiveEditorHandle(editorRefs.current.get(activeId) ?? null);
  }, [activeId]);

  const disposeTab = useCallback(
    (id: number) => {
      editorRefs.current.delete(id);
      previewRefs.current.delete(id);
      closeTab(id);
    },
    [closeTab],
  );

  const disposeTabs = useCallback(
    (anchorId: number, plan: CloseTabsPlan) => {
      const closedIds = closeTabs(anchorId, plan);
      for (const id of closedIds) {
        editorRefs.current.delete(id);
        previewRefs.current.delete(id);
      }
    },
    [closeTabs],
  );

  const {
    pendingCloseTab,
    pendingTerminalCloseTab,
    pendingDeleteTabs,
    pendingCloseMany,
    closeManyConfirming,
    handleClose,
    handleCloseTabsToRight,
    handleCloseOtherTabs,
    confirmClose,
    cancelClose,
    confirmTerminalClose,
    cancelTerminalClose,
    confirmDeleteClose,
    cancelDeleteClose,
    confirmCloseMany,
    cancelCloseMany,
    handlePathDeleted,
  } = useTabCloseGuards({
    tabs,
    activeId,
    disposeTab,
    disposeTabs,
  });

  const { pendingAppClose, confirmAppClose, cancelAppClose } =
    useAppCloseGuard(tabsRef);

  const handleOpenFile = useCallback(
    (path: string, pin?: boolean) => {
      if (isMarkdownPath(path)) newMarkdownTab(path);
      else openFileTab(path, pin ?? false);
    },
    [openFileTab, newMarkdownTab],
  );

  // Boot & launch files management (cold and warm start)
  useWorkspaceBoot({
    booted,
    handleOpenFile,
  });

  const terminalPathDropTarget = useTerminalFileDrop();
  const toggleSourceControlRef = useRef<() => void>(() => {});

  // Global user actions, shortcuts, zoom, zen mode, selection AI, tab/pane navigation
  const {
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
  } = useGlobalActions({
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
    toggleSourceControl: () => toggleSourceControlRef.current(),
    hasComposer,
    toggleSidebar,
    toggleExplorerFocus,
    openCommandPalette,
    setSwitcherOpen,
    terminalRefs,
    editorRefs,
    searchInlineRef,
  });

  const launchAgentGroup = useCallback(
    (request: AgentLaunchRequest) => {
      const command = validateAgentLaunchCommand(request.command);
      if (!command.ok) return;
      const launcher = findAgentLauncherWithCustom(
        request.agent,
        usePreferencesStore.getState().customAgentLaunchers,
      );

      void (async () => {
        const first = command.command.trim().split(/\s+/)[0] ?? "";
        try {
          const found = await invoke<{
            onPath: boolean;
            foundAt: string | null;
            foundIn: string | null;
          }>("agent_locate_command", { command: first });
          if (found.onPath) return;
          toast.error(`${launcher.label} is not on your PATH`, {
            description: found.foundAt
              ? `Found it in ${found.foundIn}. Set the start command to:\n${found.foundAt}`
              : `Install its CLI, then restart Termigo so the new PATH is picked up. A running app does not see PATH changes.`,
            duration: 12_000,
          });
        } catch {
          // Courtesy check
        }
      })();
      const title =
        request.instances === 1
          ? launcher.label
          : `${launcher.label} × ${request.instances}`;
      const { leafIds: agentLeafIds } = newAgentGroupTab(
        inheritedCwdForNewTab(),
        title,
        request.instances,
      );
      const hooksReady = launcher.supportsHooks
        ? invoke("agent_enable_hooks", {
            agent: request.agent,
          }).catch((error) => {
            console.warn(
              `[termigo] could not enable ${request.agent} notifications:`,
              error,
            );
          })
        : Promise.resolve();

      for (const leafId of agentLeafIds) {
        void (async () => {
          await Promise.all([whenSessionReady(leafId), hooksReady]);
          if (!writeToSession(leafId, `${command.command}\r`)) {
            console.error(
              `[termigo] agent terminal ${leafId} closed before launch`,
            );
          }
        })();
      }
    },
    [inheritedCwdForNewTab, newAgentGroupTab],
  );

  const handlePathRenamed = useCallback(
    (from: string, to: string) => {
      for (const t of tabs) {
        if (t.kind !== "editor") continue;
        if (t.path === from) {
          const i = to.lastIndexOf("/");
          updateTab(t.id, { path: to, title: i === -1 ? to : to.slice(i + 1) });
        } else if (t.path.startsWith(`${from}/`)) {
          const suffix = t.path.slice(from.length);
          const newPath = `${to}${suffix}`;
          const i = newPath.lastIndexOf("/");
          updateTab(t.id, {
            path: newPath,
            title: i === -1 ? newPath : newPath.slice(i + 1),
          });
        }
      }
    },
    [tabs, updateTab],
  );

  const activeTerminalLeafCwd =
    activeTab?.kind === "terminal"
      ? (findLeafCwd(activeTab.paneTree, activeTab.activeLeafId) ??
        activeTab.cwd ??
        null)
      : null;

  const activeFilePath = (() => {
    if (activeTab?.kind === "editor") return activeTab.path;
    if (activeTab?.kind === "git-diff") {
      if (/^([A-Za-z]:|\/|\\)/.test(activeTab.path)) return activeTab.path;
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    if (activeTab?.kind === "git-commit-file") {
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    return null;
  })();
  const explorerActiveFilePath =
    activeTab?.kind === "editor" || activeTab?.kind === "markdown"
      ? activeTab.path
      : null;
  const isRepositoryContextCurrent = useCallback(
    (spaceId: string, workspaceKey: string) => {
      const currentSpaceId = useSpaces.getState().activeId ?? DEFAULT_SPACE_ID;
      const currentWorkspaceKey = workspaceScopeKey(
        useWorkspaceEnvStore.getState().env,
      );
      return spaceId === currentSpaceId && workspaceKey === currentWorkspaceKey;
    },
    [],
  );
  const openSourceControl = useCallback(() => {
    openSidebarView("source-control");
  }, [openSidebarView]);
  const {
    repositoryTarget: sourceControlRepositoryTarget,
    openInSourceControl: handleOpenRepositoryInSourceControl,
    openGitHistory: handleOpenGitHistoryForPath,
    followActiveContext: handleFollowRepositoryContext,
  } = useRepositoryTargeting({
    spaceId: sourceControlSpaceId,
    workspaceKey: workspaceScopeKey(workspaceEnv),
    isContextCurrent: isRepositoryContextCurrent,
    openSourceControl,
    openCommitHistoryTab,
  });
  const { sourceControl, toggleSourceControl, openGitGraphFromContext } =
    useSourceControlContext({
      activeTab,
      tabs,
      activeTerminalLeafCwd,
      explorerRoot,
      launchCwd,
      launchCwdResolved,
      home,
      sidebarView,
      repositoryTarget: sourceControlRepositoryTarget,
      cycleSidebarView,
      openCommitHistoryTab,
    });
  toggleSourceControlRef.current = toggleSourceControl;
  const explorerGitDecorations = usePreferencesStore(
    (s) => s.explorerGitDecorations,
  );

  const registerEditorHandle = useCallback(
    (id: number, h: EditorPaneHandle | null) => {
      if (h) {
        editorRefs.current.set(id, h);
        const pending = pendingEditorNavigation.current.get(id);
        if (pending != null) {
          pendingEditorNavigation.current.delete(id);
          if (pending.line === undefined) h.focus();
          else h.gotoLine(pending.line, { focus: pending.focus });
        }
      } else {
        editorRefs.current.delete(id);
      }
      if (id === activeId) setActiveEditorHandle(h);
    },
    [activeId],
  );

  const registerPreviewHandle = useCallback(
    (id: number, h: PreviewPaneHandle | null) => {
      if (h) previewRefs.current.set(id, h);
      else previewRefs.current.delete(id);
    },
    [],
  );

  const handlePreviewUrl = useCallback(
    (id: number, url: string) => updateTab(id, { url }),
    [updateTab],
  );

  const handleFocusLeaf = useCallback(
    (tabId: number, leafId: number) => focusPane(tabId, leafId),
    [focusPane],
  );

  const onActivateAgent = activateAgentTarget;

  const onActivateLocalAgent = useCallback(() => {
    useChatStore.getState().openPanel();
    useChatStore.getState().focusInput(null);
  }, []);

  const handleEditorDirty = useCallback(
    (id: number, dirty: boolean) => updateTab(id, { dirty }),
    [updateTab],
  );

  const handleRenameTab = useCallback(
    (id: number, title: string) => updateTab(id, { customTitle: title.trim() }),
    [updateTab],
  );

  const searchTarget = useMemo<SearchTarget>(() => {
    if (isTerminalTab && activeLeafId !== null && activeSearchAddon)
      return {
        kind: "terminal",
        addon: activeSearchAddon,
        focus: () => terminalRefs.current.get(activeLeafId)?.focus(),
      };
    if (isEditorTab && activeEditorHandle)
      return {
        kind: "editor",
        handle: activeEditorHandle,
        focus: () => activeEditorHandle.focus(),
      };
    if (isGitHistoryTab && gitHistoryHandle)
      return {
        kind: "git-history",
        handle: gitHistoryHandle,
        focus: () => {},
      };
    return null;
  }, [
    isTerminalTab,
    isEditorTab,
    isGitHistoryTab,
    activeLeafId,
    activeSearchAddon,
    activeEditorHandle,
    gitHistoryHandle,
    terminalRefs,
  ]);

  const activeCwd = activeTerminalLeafCwd;

  const handleNewSpace = useCallback(() => {
    const { spaces, create, setActive } = useSpaces.getState();
    const meta = create({
      name: `Space ${spaces.length + 1}`,
      root: activeCwd ?? home ?? null,
      env: workspaceEnv,
    });
    setActiveSpaceForNewTabs(meta.id);
    newTab(activeCwd ?? undefined);
    setActive(meta.id);
    return meta.id;
  }, [activeCwd, home, workspaceEnv, newTab, setActiveSpaceForNewTabs]);

  const handleDeleteSpace = useCallback(
    (id: string) => {
      const nextSpaceId = useSpaces.getState().remove(id);
      if (!nextSpaceId) return;
      const root = useSpaces
        .getState()
        .spaces.find((s) => s.id === nextSpaceId)?.root;
      removeTabsForSpace(id, nextSpaceId, root ?? undefined);
    },
    [removeTabsForSpace],
  );

  const handleMoveTab = useCallback(
    (tabId: number, targetSpaceId: string) => {
      if (moveTabToSpace(tabId, targetSpaceId)) {
        useSpaces.getState().setActive(targetSpaceId);
      }
    },
    [moveTabToSpace],
  );

  const handleReorderTab = useCallback(
    (tabId: number, targetTabId: number, edge: "top" | "bottom") => {
      if (reorderTab(tabId, targetTabId, edge)) {
        const target = tabsRef.current.find((x) => x.id === targetTabId);
        if (target) useSpaces.getState().setActive(target.spaceId);
      }
    },
    [reorderTab],
  );

  const handleNewTabInSpace = useCallback(
    (spaceId: string) => {
      const root = useSpaces
        .getState()
        .spaces.find((s) => s.id === spaceId)?.root;
      newTabInSpace(spaceId, root ?? undefined);
    },
    [newTabInSpace],
  );

  const jumpToTab = useCallback(
    (tabId: number) => {
      const t = tabsRef.current.find((x) => x.id === tabId);
      if (!t) return;
      setActiveId(tabId);
      useSpaces.getState().setActive(t.spaceId);
      setSwitcherOpen(false);
    },
    [setActiveId],
  );

  const spaceSwitcher = (
    <SpaceSwitcher
      open={switcherOpen}
      onOpenChange={setSwitcherOpen}
      tabs={tabs}
      onNewSpace={() => void handleNewSpace()}
      onDeleteSpace={handleDeleteSpace}
      onNewTabInSpace={handleNewTabInSpace}
      onJumpTab={jumpToTab}
      onCloseTab={handleClose}
      onMoveTabToSpace={handleMoveTab}
      onReorderTab={handleReorderTab}
      onReorderSpaces={(ids) => useSpaces.getState().reorder(ids)}
    />
  );

  const allCommandItems = useMemo(
    () =>
      createCommandItems({
        tabs,
        activeId,
        searchTarget,
        explorerRoot,
        home,
        openNewTab,
        openNewBlock: openNewBlockTab,
        openNewPrivate: openNewPrivateTab,
        openNewEditor: () => setNewEditorOpen(true),
        openNewPreview: () => openPreviewTab(""),
        openApiClient: openApiClientTab,
        openGitGraph: openGitGraphFromContext,
        toggleSourceControl,
        closeActiveTabOrPane: handleCloseTabOrPane,
        splitPaneRight: () => splitActivePaneInActiveTab("row"),
        splitPaneDown: () => splitActivePaneInActiveTab("col"),
        focusSearch: () => searchInlineRef.current?.focus(),
        focusExplorerSearch: () => explorerRef.current?.focusSearch(),
        toggleSidebar,
        toggleAi: togglePanelAndFocus,
        askAiSelection: askFromSelection,
        openSettings: () => void openSettingsWindow(),
        openKeyboardShortcuts: () => void openSettingsWindow("shortcuts"),
        spaces: useSpaces.getState().spaces,
        activeSpaceId,
        openSpacesOverview: () => setSwitcherOpen(true),
        newSpace: () => void handleNewSpace(),
        switchSpace: (id) => useSpaces.getState().setActive(id),
      }),
    [
      tabs,
      activeId,
      searchTarget,
      explorerRoot,
      home,
      openNewTab,
      openNewBlockTab,
      openNewPrivateTab,
      openPreviewTab,
      openApiClientTab,
      openGitGraphFromContext,
      toggleSourceControl,
      handleCloseTabOrPane,
      splitActivePaneInActiveTab,
      toggleSidebar,
      togglePanelAndFocus,
      askFromSelection,
      activeSpaceId,
      handleNewSpace,
    ],
  );
  const commandPaletteItems = commandPaletteOpen ? allCommandItems : [];

  const pendingEditorNavigation = useRef<
    Map<number, { line?: number; focus: boolean }>
  >(new Map());
  const openContentHit = useCallback(
    (path: string, line: number) => {
      const isAbsolute = /^([A-Za-z]:[\\/]|\\\\|\/|~)/.test(path);
      const root = explorerRoot ?? launchCwd ?? home ?? null;
      const resolved =
        isAbsolute || !root
          ? path
          : `${root.replace(/[\\/]$/, "")}/${path.replace(/^[\\/]/, "")}`;
      const id = openFileTab(resolved, true);
      if (id == null) return;
      const h = editorRefs.current.get(id);
      if (h) h.gotoLine(line);
      else pendingEditorNavigation.current.set(id, { line, focus: true });
    },
    [openFileTab, explorerRoot, launchCwd, home],
  );

  const openControlFile = useCallback(
    ({
      path,
      line,
      focus,
      spaceId,
    }: {
      path: string;
      line?: number;
      focus: boolean;
      spaceId: string;
    }) => {
      if (focus && useSpaces.getState().activeId !== spaceId) {
        useSpaces.getState().setActive(spaceId);
      }
      const id = openFileTab(path, true, {
        spaceId,
        activate: focus,
      });
      const editor = editorRefs.current.get(id);
      if (line !== undefined) {
        if (editor) editor.gotoLine(line, { focus });
        else pendingEditorNavigation.current.set(id, { line, focus });
      } else if (focus) {
        if (editor) editor.focus();
        else pendingEditorNavigation.current.set(id, { focus: true });
      }
      return id;
    },
    [openFileTab],
  );

  const focusControlTab = useCallback(
    (target: {
      query: string;
      spaceId: string;
    }): {
      ok: boolean;
      label?: string;
    } => {
      const q = target.query.trim().toLowerCase();
      if (!q) return { ok: false };
      const currentTabs = tabsRef.current ?? [];
      const inSpace = currentTabs.filter((t) => t.spaceId === target.spaceId);
      const pool = inSpace.length > 0 ? inSpace : currentTabs;
      const score = (t: Tab): number => {
        const label = labelFor(t).toLowerCase();
        const path =
          "path" in t ? ((t.path as string) ?? "").toLowerCase() : "";
        const cwd =
          "cwd" in t ? ((t.cwd as string | undefined) ?? "").toLowerCase() : "";
        if (label === q || path === q) return 0;
        if (label.startsWith(q) || path.startsWith(q) || cwd.startsWith(q)) {
          return 1;
        }
        if (label.includes(q) || path.includes(q) || cwd.includes(q)) return 2;
        return -1;
      };
      let best: Tab | null = null;
      let bestScore = Infinity;
      for (const t of pool) {
        const s = score(t);
        if (s >= 0 && s < bestScore) {
          bestScore = s;
          best = t;
        }
      }
      if (!best) return { ok: false };
      if (useSpaces.getState().activeId !== best.spaceId) {
        useSpaces.getState().setActive(best.spaceId);
      }
      setActiveId(best.id);
      return { ok: true, label: labelFor(best) };
    },
    [setActiveId],
  );

  const runPentest = useCallback(
    (request: { target: string; category: string }) =>
      startPentestRun(request.target, request.category),
    [],
  );
  const readPentestStatus = useCallback(
    () => Promise.resolve({ ok: true as const, result: getPentestStatus() }),
    [],
  );
  const runPentestReport = useCallback(
    (request: { target: string }) => requestPentestReport(request.target),
    [],
  );
  const runAgent = useCallback((request: { prompt: string }) => {
    return runAgentTask(request.prompt);
  }, []);
  const answerQuery = useCallback((request: { prompt: string }) => {
    return import("@/modules/control/lib/queryAgent").then(({ runQuery }) =>
      runQuery(request.prompt),
    );
  }, []);
  const runCommandById = useCallback(
    async (request: { command: string }) => {
      const item = allCommandItems.find((c) => c.id === request.command);
      if (!item) {
        return { ok: false, message: `unknown command '${request.command}'` };
      }
      try {
        item.run();
        return { ok: true, label: item.title };
      } catch (error) {
        return { ok: false, message: String(error) };
      }
    },
    [allCommandItems],
  );

  const readAppStatus = useCallback(async () => {
    let appVersion: string | null = null;
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      appVersion = await getVersion();
    } catch {
      // outside the Tauri host
    }
    let arch: string | null = null;
    try {
      const mod = await import("@tauri-apps/plugin-os");
      arch = mod.arch();
    } catch {
      // outside the Tauri host
    }
    let costTodayUsd = 0;
    try {
      const { costToday } = await import("@/modules/ai/lib/costLedger");
      costTodayUsd = await costToday();
    } catch {
      // ledger unreadable yet
    }
    const chat = useChatStore.getState();
    const meta = chat.agentMeta;
    return {
      ok: true as const,
      result: {
        app_version: appVersion,
        protocol: 1,
        os: PLATFORM,
        arch,
        ui: {
          agent: {
            status: meta.status,
            step: meta.step,
            stopReason: meta.stopReason,
            runRound: meta.runRound,
          },
          model: { id: chat.selectedModelId ?? null },
          workspace: {
            root: chat.live.getWorkspaceRoot() ?? null,
            cwd: chat.live.getCwd() ?? null,
          },
          session: { activeId: chat.activeSessionId ?? null },
          costTodayUsd,
        },
      },
    };
  }, []);

  useControlBridge({
    ready: spacesHydrated && launchCwdResolved,
    tabsRef,
    activeTabIdRef: activeIdRef,
    activeSpaceIdRef,
    onOpen: openControlFile,
    onFocus: focusControlTab,
    onPentestRun: runPentest,
    onPentestStatus: readPentestStatus,
    onPentestReport: runPentestReport,
    onAgentRun: runAgent,
    onStatus: readAppStatus,
    onQuery: answerQuery,
    onRunCommand: runCommandById,
  });

  useEffect(() => {
    setLspNavigator({ openFile: openContentHit });
    return () => setLspNavigator(null);
  }, [openContentHit]);

  useEffect(() => {
    setArtifactOpener({
      openFile: (path) => openFileTab(path, true),
      openPreview: (url) => {
        openPreviewTab(url);
      },
      openCanvas: (html, title) => {
        openCanvasTab(html, title);
      },
    });
    return () => setArtifactOpener(null);
  }, [openFileTab, openPreviewTab, openCanvasTab]);

  useEffect(() => {
    const root = explorerRoot ?? launchCwd ?? home ?? null;
    void import("@/modules/ai/store/customCommandsStore").then(
      ({ useCustomCommandsStore }) =>
        useCustomCommandsStore.getState().loadFor(root),
    );
    void import("@/modules/ai/store/approvalRulesStore").then(
      ({ useApprovalRulesStore }) =>
        useApprovalRulesStore.getState().loadFor(root),
    );
  }, [explorerRoot, launchCwd, home]);

  useAiLiveBridge({
    setLive,
    activeId,
    tabs,
    explorerRoot,
    launchCwd,
    home,
    openPreviewTab,
    openCanvasTab,
    newAgentTab,
    terminalRefs,
  });

  const sshPanelOpen = useSshRightPanelStore((s) => s.open);
  const extActivePanels = useRightPanelStore((s) => s.panels);
  const activeSshSession = useSshActiveSessionStore((s) => s.session);

  const activeRemoteCwd = useMemo(() => {
    if (!activeTerminalTab) return null;
    return (
      findLeafRemoteCwd(
        activeTerminalTab.paneTree,
        activeTerminalTab.activeLeafId,
      ) ?? null
    );
  }, [activeTerminalTab]);

  const openedForSession = useRef<number | null>(null);
  useEffect(() => {
    const id = activeSshSession?.sessionId ?? null;
    if (id === null || openedForSession.current === id) return;
    openedForSession.current = id;
    useSshRightPanelStore.getState().openPanel();
  }, [activeSshSession]);

  const shell = (
    <ThemeProvider>
      <TooltipProvider>
        <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
          {!zenMode && (
            <Header
              tabs={spaceTabs}
              activeId={activeId}
              onSelect={setActiveId}
              onNew={openNewTab}
              onNewBlock={openNewBlockTab}
              onNewPrivate={openNewPrivateTab}
              onNewPreview={() => openPreviewTab("")}
              onNewEditor={() => setNewEditorOpen(true)}
              onNewGitGraph={openGitGraphFromContext}
              onLaunchAgents={launchAgentGroup}
              onClose={handleClose}
              onCloseTabsToRight={handleCloseTabsToRight}
              onCloseOtherTabs={handleCloseOtherTabs}
              onPin={pinTab}
              onRename={handleRenameTab}
              onReorder={reorderTabByGap}
              onToggleSidebar={toggleSidebar}
              onOpenCommandPalette={() => openCommandPalette("commands")}
              onActivateAgent={onActivateAgent}
              onActivateLocalAgent={onActivateLocalAgent}
              onOpenSettings={() => void openSettingsWindow()}
              onConnectSsh={(conn) => newSshTab(conn.id, conn.name)}
              spaceSwitcher={spaceSwitcher}
              searchTarget={searchTarget}
              searchRef={searchInlineRef}
              onOverrideLanguage={setOverrideLanguage}
            />
          )}

          <main className="zoom-content flex min-h-0 flex-1 flex-col">
            <ResizablePanelGroup
              orientation="horizontal"
              className="min-h-0 flex-1"
              onLayoutChanged={(_, { isUserInteraction }) => {
                const width = sidebarRef.current?.getSize().inPixels ?? 0;
                persistSidebarWidth(width, isUserInteraction);
              }}
            >
              <ResizablePanel
                id="sidebar"
                panelRef={sidebarRef}
                defaultSize={
                  initialSidebarCollapsed
                    ? "0px"
                    : `${sidebarWidthRef.current}px`
                }
                minSize={`${SIDEBAR_MIN_WIDTH}px`}
                maxSize={`${SIDEBAR_MAX_WIDTH}px`}
                collapsible
                collapsedSize={0}
                onResize={(size) => {
                  persistSidebarCollapsed(size.inPixels <= 0);
                }}
              >
                <div className="flex h-full min-h-0 flex-col border-r border-border bg-card">
                  <div
                    key={sidebarView}
                    className="min-h-0 flex-1 termigo-panel-in"
                  >
                    {sidebarView === "explorer" ? (
                      <FileExplorer
                        ref={explorerRef}
                        rootPath={explorerRoot}
                        gitStatus={
                          explorerGitDecorations ? sourceControl.status : null
                        }
                        activeFilePath={explorerActiveFilePath}
                        onOpenFile={handleOpenFile}
                        onPathRenamed={handlePathRenamed}
                        onPathDeleted={handlePathDeleted}
                        onRevealInTerminal={cdInNewTab}
                        onOpenInSourceControl={
                          handleOpenRepositoryInSourceControl
                        }
                        onOpenGitHistory={handleOpenGitHistoryForPath}
                        onAttachToAgent={handleAttachFileToAgent}
                        pathDropTarget={terminalPathDropTarget}
                      />
                    ) : (
                      <SourceControlPanel
                        open
                        sourceControl={sourceControl}
                        onOpenDiff={openGitDiffTab}
                        onOpenGitGraph={openGitGraphFromContext}
                        onOpenFile={handleOpenFile}
                        onNavigateToPath={cdInNewTab}
                        repositoryTarget={sourceControlRepositoryTarget}
                        onFollowRepositoryContext={
                          handleFollowRepositoryContext
                        }
                      />
                    )}
                  </div>
                  <SidebarRail
                    activeView={sidebarView}
                    onSelectView={persistSidebarView}
                    changedCount={sourceControl.changedCount}
                  />
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel id="workspace" defaultSize="78%" minSize="30%">
                <div className="flex h-full min-h-0 flex-col">
                  <div className="relative min-h-0 flex-1">
                    <WorkspaceSurface
                      tabs={tabs}
                      activeId={activeId}
                      activeTab={activeTab}
                      registerTerminalHandle={registerTerminalHandle}
                      onSearchReady={handleSearchReady}
                      onCwd={handleTerminalCwd}
                      onTitle={handleTerminalTitle}
                      onExit={handleLeafExit}
                      onFocusLeaf={handleFocusLeaf}
                      registerEditorHandle={registerEditorHandle}
                      onEditorDirtyChange={handleEditorDirty}
                      onEditorCloseTab={disposeTab}
                      registerPreviewHandle={registerPreviewHandle}
                      onPreviewUrlChange={handlePreviewUrl}
                      onAiDiffAccept={(id) => respondToApproval(id, true)}
                      onAiDiffReject={(id) => respondToApproval(id, false)}
                      onOpenCommitFile={openCommitFileDiffTab}
                      onGitHistorySearchHandle={setGitHistoryHandle}
                      onSetMarkdownView={setMarkdownView}
                    />
                  </div>

                  <WorkspaceInputBar
                    isBlockTab={isBlockTab}
                    isTerminalTab={isTerminalTab}
                    activeLeafId={activeLeafId}
                    cwd={activeCwd}
                    home={home}
                    hasComposer={hasComposer}
                    panelOpen={panelOpen}
                    keysLoaded={keysLoaded}
                    onConnect={() => void openSettingsWindow("models")}
                  />
                </div>
              </ResizablePanel>
              {sshPanelOpen && activeSshSession ? (
                <ResizablePanel
                  id="ssh-remote"
                  defaultSize="28%"
                  minSize="16%"
                  maxSize="45%"
                >
                  <div className="flex h-full min-h-0 flex-col border-l border-border bg-card">
                    <SshFileExplorer
                      sessionId={activeSshSession.sessionId}
                      hostLabel={activeSshSession.hostLabel}
                      currentCwd={activeRemoteCwd}
                      onClose={() =>
                        useSshRightPanelStore.getState().closePanel()
                      }
                    />
                  </div>
                </ResizablePanel>
              ) : null}
              {extActivePanels.length > 0 ? (
                <ResizablePanel
                  id="ext-right"
                  defaultSize="28%"
                  minSize="16%"
                  maxSize="45%"
                >
                  <div className="flex h-full min-h-0 flex-col border-l border-border/60 bg-card">
                    {extActivePanels.map((p) => (
                      <RightPanelHost
                        key={`${p.extensionId}:${p.panelId}`}
                        extensionId={p.extensionId}
                        panelId={p.panelId}
                      />
                    ))}
                  </div>
                </ResizablePanel>
              ) : null}
              {hasComposer && panelOpen ? (
                <ResizablePanel
                  id="ai-chat"
                  defaultSize="30%"
                  minSize="20%"
                  maxSize="50%"
                >
                  <AiDockPanel />
                </ResizablePanel>
              ) : null}
            </ResizablePanelGroup>
          </main>

          {!zenMode && (
            <StatusBar
              cwd={activeCwd}
              filePath={activeFilePath}
              home={home}
              onCd={sendCd}
              onWorkspaceChange={handleWorkspaceChange}
              onOpenMini={openMini}
              onOpenAi={togglePanelAndFocus}
              hasComposer={hasComposer}
              privateActive={
                activeTab?.kind === "terminal" && activeTab.private === true
              }
            />
          )}

          <AgentNotificationsBridge
            tabs={tabs}
            activeId={activeId}
            onActivate={onActivateAgent}
          />
          <Toaster position="bottom-right" />

          {hasComposer ? (
            <>
              <AgentRunBridge
                openAiDiffTab={openAiDiffTab}
                closeAiDiffTab={closeAiDiffTab}
              />
              <LocalAgentNotificationsBridge />
            </>
          ) : null}

          {hasComposer && miniPresence.mounted && !panelOpen ? (
            <AiMiniWindow state={miniPresence.state} />
          ) : null}
          {askPresence.mounted ? (
            <SelectionAskAi
              state={askPresence.state}
              x={askPopup?.x ?? 0}
              y={askPopup?.y ?? 0}
              onAsk={onAskFromSelection}
              onDismiss={() => setAskPopup(null)}
            />
          ) : null}

          {switcherState && (
            <TabSwitcherHud tabs={spaceTabs} state={switcherState} />
          )}

          <CommandPalette
            open={commandPaletteOpen}
            onOpenChange={setCommandPaletteOpen}
            initialMode={paletteInitialMode}
            commandItems={commandPaletteItems}
            workspaceRoot={explorerRoot}
            onOpenContentHit={openContentHit}
            insertCommand={insertHistoryCommand}
          />

          <NewEditorDialog
            open={newEditorOpen}
            onOpenChange={setNewEditorOpen}
            rootPath={explorerRoot ?? home}
            onCreated={(path) => openFileTab(path)}
          />

          <UpdaterDialog />

          <CloseDialogs
            tabs={tabs}
            pendingCloseTab={pendingCloseTab}
            onCancelClose={cancelClose}
            onConfirmClose={confirmClose}
            pendingTerminalCloseTab={pendingTerminalCloseTab}
            onCancelTerminalClose={cancelTerminalClose}
            onConfirmTerminalClose={confirmTerminalClose}
            pendingDeleteTabs={pendingDeleteTabs}
            onCancelDeleteClose={cancelDeleteClose}
            onConfirmDeleteClose={confirmDeleteClose}
            pendingCloseMany={pendingCloseMany}
            closeManyConfirming={closeManyConfirming}
            onCancelCloseMany={cancelCloseMany}
            onConfirmCloseMany={confirmCloseMany}
            pendingAppClose={pendingAppClose}
            onCancelAppClose={cancelAppClose}
            onConfirmAppClose={confirmAppClose}
          />
        </div>
      </TooltipProvider>
      <HostKeyPromptDialog />
    </ThemeProvider>
  );

  return <AiComposerProvider>{shell}</AiComposerProvider>;
}
