import { findAgentLauncherWithCustom } from "@/modules/agents/lib/launcher";
import { useManagedAgentsStore } from "@/modules/agents/store/managedAgentsStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Tab } from "@/modules/tabs";
import {
  findLeafCwd,
  findLeafRemoteCwd,
  isSshLeaf,
  leafSessionId,
  type TerminalPaneHandle,
  whenSessionReady,
  writeToSession,
} from "@/modules/terminal";
import { invoke } from "@tauri-apps/api/core";
import { type RefObject, useEffect, useRef } from "react";
import {
  browserBack,
  browserClose,
  browserConsole,
  browserEval,
  browserExtract,
  browserForward,
  browserList,
  browserNavigate,
  browserReload,
  browserScreenshot,
  browserUrl,
  browserOpen as openBrowser,
} from "../browser/bridge";
import type { Live } from "../store/chatStore";
import { redactSensitive } from "./redact";
import { startScheduler } from "./scheduler";

type TuiWaitResult = "ready" | "gone" | "timeout";

// Markers that mean a coding-agent TUI has finished booting and is showing its
// prompt. Claude's "shortcuts"/"? for" plus generic prompt glyphs and phrases
// the other CLIs (codex, gemini, opencode, …) draw, so one detector serves them
// all. When none appear, `waitForTuiReady` falls back to buffer-stability.
const TUI_READY_MARKERS = [
  "shortcuts",
  "? for",
  "esc to",
  "enter to",
  "ctrl+c",
  "❯",
  "▌",
  "│",
  "╭",
  "> ",
];

async function waitForTuiReady(
  readBuf: () => string | null,
  timeoutMs = 12000,
): Promise<TuiWaitResult> {
  const start = Date.now();
  let lastBuf = "";
  let stableSince = 0;
  while (Date.now() - start < timeoutMs) {
    const buf = readBuf();
    if (buf === null) return "gone";
    const low = buf.toLowerCase();
    if (TUI_READY_MARKERS.some((m) => low.includes(m))) return "ready";
    // Fallback: a non-empty buffer that stops changing for ~1.2s is a booted
    // TUI whose prompt we simply do not have a marker for.
    if (buf.length > 0) {
      if (buf === lastBuf) {
        if (stableSince && Date.now() - stableSince > 1200) return "ready";
      } else {
        lastBuf = buf;
        stableSince = Date.now();
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return "timeout";
}

type Params = {
  setLive: (live: Live) => void;
  activeId: number;
  tabs: Tab[];
  explorerRoot: string | null;
  launchCwd: string | null;
  home: string | null;
  openPreviewTab: (url: string, browserInstance?: string) => void;
  openCanvasTab: (html: string, title?: string) => void;
  newAgentTab: (
    cwd: string | undefined,
    title: string,
  ) => { tabId: number; leafId: number };
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
};

/**
 * Publishes the live workspace context (cwd, terminal buffer, active file,
 * managed-agent spawning, ...) into the chat store so AI tools can read and
 * act on the foreground state.
 *
 * The live object's getters read the latest state through a ref, so the bridge
 * is published once instead of re-running on every tab/cwd change — cwd updates
 * arrive from terminal OSC on shell output and would otherwise churn constantly.
 */
export function useAiLiveBridge(params: Params) {
  const { setLive, terminalRefs } = params;
  const ref = useRef(params);
  ref.current = params;

  useEffect(() => {
    // Start the background scheduler in the main window (idempotent). It ticks
    // on a timer and submits due /schedule tasks as agent runs.
    startScheduler();

    const findCwd = () => {
      const { activeId, tabs, explorerRoot, launchCwd, home } = ref.current;
      const active = tabs.find((x) => x.id === activeId);
      if (active?.kind === "terminal") {
        return (
          findLeafCwd(active.paneTree, active.activeLeafId) ??
          active.cwd ??
          null
        );
      }
      for (let i = tabs.length - 1; i >= 0; i--) {
        const t = tabs[i];
        if (t.kind !== "terminal") continue;
        const cwd = findLeafCwd(t.paneTree, t.activeLeafId) ?? t.cwd;
        if (cwd) return cwd;
      }
      return explorerRoot ?? launchCwd ?? home ?? null;
    };

    setLive({
      getCwd: findCwd,
      getRemoteSession: () => {
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        if (t?.kind !== "terminal") return null;
        const leafId = t.activeLeafId;
        // Only the active SSH leaf counts: a remote read against a stale
        // session (e.g. a second SSH tab that connected earlier) would hit
        // the wrong host. The leaf carries its own session id, so this is
        // exact even with several SSH tabs open.
        if (!isSshLeaf(t.paneTree, leafId)) return null;
        const sessionId = leafSessionId(leafId);
        if (sessionId === null) return null;
        const cwd = findLeafRemoteCwd(t.paneTree, leafId) ?? null;
        return { sessionId, cwd };
      },
      getTerminalContext: () => {
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        if (t?.kind !== "terminal") return null;
        if (t.private) return null;
        const buf = terminalRefs.current.get(t.activeLeafId)?.getBuffer(300);
        return buf ? redactSensitive(buf) : null;
      },
      isActiveTerminalPrivate: () => {
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "terminal" && t.private === true;
      },
      injectIntoActivePty: (text) => {
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        if (t?.kind !== "terminal") return false;
        const term = terminalRefs.current.get(t.activeLeafId);
        if (!term) return false;
        term.write(text);
        term.focus();
        return true;
      },
      getWorkspaceRoot: () => {
        const { explorerRoot, launchCwd } = ref.current;
        return explorerRoot ?? launchCwd ?? null;
      },
      getActiveFile: () => {
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "editor" ? t.path : null;
      },
      openPreview: (url: string, browserInstance?: string) => {
        ref.current.openPreviewTab(url, browserInstance);
        return true;
      },
      openCanvas: (html: string, title?: string) => {
        ref.current.openCanvasTab(html, title);
        return true;
      },
      browserOpen: async (instance, url) => {
        try {
          return await openBrowser(instance, url);
        } catch (e) {
          return { error: String(e) };
        }
      },
      browserNavigate: async (instance, url) => {
        try {
          return await browserNavigate(instance, url);
        } catch (e) {
          return { error: String(e) };
        }
      },
      browserBack: async (instance) => {
        try {
          await browserBack(instance);
          return { ok: true as const };
        } catch (e) {
          return { error: String(e) };
        }
      },
      browserForward: async (instance) => {
        try {
          await browserForward(instance);
          return { ok: true as const };
        } catch (e) {
          return { error: String(e) };
        }
      },
      browserReload: async (instance) => {
        try {
          await browserReload(instance);
          return { ok: true as const };
        } catch (e) {
          return { error: String(e) };
        }
      },
      browserExtract: async (instance) => {
        try {
          return { text: await browserExtract(instance) };
        } catch (e) {
          return { error: String(e) };
        }
      },
      browserEval: async (instance, js) => {
        try {
          await browserEval(instance, js);
          return { ok: true as const };
        } catch (e) {
          return { error: String(e) };
        }
      },
      browserScreenshot: async (instance) => {
        try {
          return { screenshot: await browserScreenshot(instance) };
        } catch (e) {
          return { error: String(e) };
        }
      },
      browserConsole: async (instance) => {
        try {
          return { console: await browserConsole(instance) };
        } catch (e) {
          return { error: String(e) };
        }
      },
      browserUrl: async (instance) => {
        try {
          return { url: await browserUrl(instance) };
        } catch (e) {
          return { error: String(e) };
        }
      },
      browserClose: async (instance) => {
        try {
          await browserClose(instance);
          return { ok: true as const };
        } catch (e) {
          return { error: String(e) };
        }
      },
      browserList: async () => {
        try {
          return await browserList();
        } catch {
          return [];
        }
      },
      spawnManagedAgent: (
        prompt: string,
        sessionId: string,
        agentId = "claude",
      ) => {
        const trimmed = prompt.trim();
        if (!trimmed) return null;
        const oneLine = trimmed.replace(/\s*\r?\n\s*/g, " ");
        const cwd = findCwd();
        const short =
          oneLine.length > 32 ? `${oneLine.slice(0, 32)}…` : oneLine;
        // Resolve the launcher: the user's configured command wins, else the
        // built-in default. Custom agents use their stored command. Unknown ids
        // fall back to Claude.
        const prefs = usePreferencesStore.getState();
        const launcher = findAgentLauncherWithCustom(
          agentId,
          prefs.customAgentLaunchers,
        );
        const launchCommands = prefs.agentLaunchCommands as Record<
          string,
          string | undefined
        >;
        const command = (
          launchCommands[launcher.id] ?? launcher.defaultCommand
        ).trim();
        const { tabId, leafId } = ref.current.newAgentTab(
          cwd ?? undefined,
          `${launcher.id} · ${short}`,
        );
        useManagedAgentsStore.getState().register({
          leafId,
          tabId,
          sessionId,
          task: oneLine,
          cwd,
          agent: launcher.id,
        });
        // Hooks let Termigo observe the agent's activity; only some CLIs support
        // them. Skip the enable call (and its wait) for those that do not.
        const hooksReady = launcher.supportsHooks
          ? invoke("agent_enable_hooks", { agent: launcher.id }).catch(() => {})
          : Promise.resolve();
        void (async () => {
          await Promise.all([whenSessionReady(leafId), hooksReady]);
          if (!writeToSession(leafId, `${command}\r`)) {
            useManagedAgentsStore.getState().remove(leafId);
            return;
          }
          const readBuf = () => {
            const term = terminalRefs.current.get(leafId);
            return term ? term.getBuffer(120) : null;
          };
          const result = await waitForTuiReady(readBuf);
          if (result !== "ready") {
            if (result === "timeout") {
              console.warn(
                `[termigo] ${launcher.id} TUI did not appear in time; aborting prompt send`,
              );
            }
            useManagedAgentsStore.getState().remove(leafId);
            return;
          }
          if (!writeToSession(leafId, `\x1b[200~${trimmed}\x1b[201~`)) {
            useManagedAgentsStore.getState().remove(leafId);
            return;
          }
          setTimeout(() => writeToSession(leafId, "\r"), 120);
          useManagedAgentsStore.getState().setPhase(leafId, "working");
        })();
        return { tabId, leafId };
      },
      readLeafBuffer: (leafId: number) => {
        const buf = terminalRefs.current.get(leafId)?.getBuffer(300);
        return buf ? redactSensitive(buf) : null;
      },
    });
  }, [setLive, terminalRefs]);
}
