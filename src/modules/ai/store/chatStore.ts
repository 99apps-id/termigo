import type { Chat, UIMessage } from "@ai-sdk/react";
import { create } from "zustand";
import {
  DEFAULT_MODEL_ID,
  endpointIdFromCompatModel,
  getModel,
  isCompatModelId,
  type ModelId,
  type ProviderId,
  providerNeedsKey,
} from "../config";
import type { AgentStopReason, AgentUsage, RunDiagnostics } from "../lib/agent";
import {
  type CustomEndpointKeys,
  EMPTY_PROVIDER_KEYS,
  type ProviderKeys,
} from "../lib/keyring";
import { pushRecentModel } from "../lib/modelPrefs";
import {
  deleteRunInFlight,
  deleteRunMeta,
  deleteSessionData,
  deriveTitle,
  loadAll,
  loadMessages,
  loadRunInFlight,
  loadRunMeta,
  newSessionId,
  type RunMeta,
  type SessionMeta,
  saveActiveId,
  saveMessages,
  saveRunInFlight,
  saveRunMeta,
  saveSessionsList,
} from "../lib/sessions";
import {
  EMPTY_QUEUE,
  enqueue,
  remove as removeSteer,
  type SteerMessage,
  type SteerQueue,
} from "../lib/steer";
import { useApprovalQueue } from "./approvalQueueStore";
import { useArtifactsStore } from "./artifactsStore";
import { useSubagentRunStore } from "./subagentRunStore";
import { useTodosStore } from "./todoStore";

export type Live = {
  getCwd: () => string | null;
  getRemoteSession: () => import("../tools/context").RemoteFsSession | null;
  getTerminalContext: () => string | null;
  isActiveTerminalPrivate: () => boolean;
  injectIntoActivePty: (text: string) => boolean;
  getWorkspaceRoot: () => string | null;
  getActiveFile: () => string | null;
  openPreview: (url: string, browserInstance?: string) => boolean;
  openCanvas: (html: string, title?: string) => boolean;
  browserOpen: (
    instance: string,
    url: string,
  ) => Promise<{ url: string | null } | { error: string }>;
  browserNavigate: (
    instance: string,
    url: string,
  ) => Promise<{ url: string | null } | { error: string }>;
  browserBack: (instance: string) => Promise<{ ok: true } | { error: string }>;
  browserForward: (
    instance: string,
  ) => Promise<{ ok: true } | { error: string }>;
  browserReload: (
    instance: string,
  ) => Promise<{ ok: true } | { error: string }>;
  browserExtract: (
    instance: string,
  ) => Promise<{ text: string } | { error: string }>;
  browserEval: (
    instance: string,
    js: string,
  ) => Promise<{ ok: true } | { error: string }>;
  browserScreenshot: (
    instance: string,
  ) => Promise<{ screenshot: string } | { error: string }>;
  browserConsole: (
    instance: string,
  ) => Promise<{ console: string } | { error: string }>;
  browserUrl: (
    instance: string,
  ) => Promise<{ url: string } | { error: string }>;
  browserClose: (instance: string) => Promise<{ ok: true } | { error: string }>;
  browserList: () => Promise<string[]>;
  spawnManagedAgent: (
    prompt: string,
    sessionId: string,
    agent?: string,
  ) => { tabId: number; leafId: number } | null;
  readLeafBuffer: (leafId: number) => string | null;
};

export type AgentRunStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "awaiting-approval"
  | "error";

export type AgentMeta = {
  status: AgentRunStatus;
  step: string | null;
  approvalsPending: number;
  /**
   * The approvals the main agent is waiting on, in the order they were asked.
   *
   * The count alone was enough while the only way to answer was clicking the
   * card in front of you. `/approve 2` needs to name one, and the ids live in
   * the message list, which is React-side only - so the bridge publishes them
   * here for anything outside React to address.
   */
  pendingApprovals: { id: string; toolName: string; summary: string }[];
  error: string | null;
  tokens: AgentUsage;
  lastInputTokens: number;
  lastCachedTokens: number;
  /** Which guard ended the run early, or null when it finished on its own.
   *  Drives whether the transcript offers to continue, and what it says. */
  stopReason: AgentStopReason | null;
  /** Rounds spent on the current task (0-based). Reset by a new user message,
   *  raised by Continue, and read to pick this round's step budget. */
  runRound: number;
  /**
   * The agentic-loop round, i.e. how many fresh model calls this run has made
   * (each `sendMessages`). Increments every time the agent starts a new round
   * and is reset when a new user turn begins. Lets the UI show "Round N · step
   * X" so a user can tell a long run is still progressing, rather than looking
   * stuck. Distinct from `runRound` (the resume budget tier).
   */
  round: number;
  /** The user pressed stop, so the transcript can offer to resume. */
  stoppedByUser: boolean;
  compactionNotice: { droppedCount: number; at: number } | null;
  /** The last fact written to project memory, so a silent write is visible. */
  memoryNotice: { fact: string; at: number } | null;
};

const ZERO_USAGE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
};

const IDLE_META: AgentMeta = {
  status: "idle",
  step: null,
  approvalsPending: 0,
  pendingApprovals: [],
  error: null,
  tokens: ZERO_USAGE,
  lastInputTokens: 0,
  lastCachedTokens: 0,
  stopReason: null,
  runRound: 0,
  round: 0,
  stoppedByUser: false,
  compactionNotice: null,
  memoryNotice: null,
};

export type MiniState = {
  open: boolean;
};

export type PendingSelection = {
  id: string;
  text: string;
  source: "terminal" | "editor";
};

export type ApprovalResponder = (approvalId: string, approved: boolean) => void;

type StoreState = {
  live: Live;
  setLive: (live: Live) => void;

  /**
   * Set by AgentRunBridge each render. Lets surfaces outside the chat hook
   * tree (e.g. the AI diff tab in the editor area) resolve a pending tool
   * approval through the active session's `addToolApprovalResponse`.
   */
  approvalResponder: ApprovalResponder | null;
  setApprovalResponder: (fn: ApprovalResponder | null) => void;
  respondToApproval: (approvalId: string, approved: boolean) => void;

  apiKeys: ProviderKeys;
  setApiKeys: (keys: ProviderKeys) => void;
  setApiKey: (provider: ProviderId, key: string | null) => void;

  customEndpointKeys: CustomEndpointKeys;
  setCustomEndpointKeys: (keys: CustomEndpointKeys) => void;

  selectedModelId: string;
  setSelectedModelId: (id: string) => void;

  mini: MiniState;
  openMini: () => void;
  closeMini: () => void;
  toggleMini: () => void;

  panelOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;

  focusSignal: number;
  pendingPrefill: string | null;
  focusInput: (prefill?: string | null) => void;
  consumePrefill: () => string | null;

  pendingSelections: PendingSelection[];
  attachSelection: (text: string, source: "terminal" | "editor") => void;
  consumeSelections: () => PendingSelection[];

  agentMeta: AgentMeta;
  patchAgentMeta: (patch: Partial<AgentMeta>) => void;
  resetAgentMeta: () => void;

  /** Performance summary of the last finished run, for the on-screen view. */
  lastRun: RunDiagnostics | null;
  setLastRun: (r: RunDiagnostics | null) => void;

  /** Text typed while a run was in flight, waiting for it to end. */
  steerQueue: SteerQueue;
  queueSteer: (message: SteerMessage) => void;
  cancelSteer: (index: number) => void;
  clearSteer: () => void;

  /**
   * Persist the active session's run state so the transcript can offer
   * "Continue" after an app restart. Persists when a run ended stopped or hit
   * a guard; clears it when a run starts fresh.
   */
  syncRunMeta: () => void;

  /**
   * Persist that the active session's run is now in flight. Combined with
   * `syncRunMeta`, this lets a run cut off by an app restart be offered as
   * "Resume" rather than silently lost.
   */
  markRunStarted: () => void;

  // Sessions
  sessionsHydrated: boolean;
  sessions: SessionMeta[];
  activeSessionId: string | null;
  hydrateSessions: () => Promise<void>;
  newSession: () => string;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  /** Persist messages of a session and bump its updatedAt + auto-title. */
  persistMessages: (id: string, messages: UIMessage[]) => void;
};

const NOOP_LIVE: Live = {
  getCwd: () => null,
  getRemoteSession: () => null,
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  injectIntoActivePty: () => false,
  getWorkspaceRoot: () => null,
  getActiveFile: () => null,
  openPreview: () => false,
  openCanvas: () => false,
  browserOpen: async () => ({ error: "browser bridge unavailable" }),
  browserNavigate: async () => ({ error: "browser bridge unavailable" }),
  browserBack: async () => ({ error: "browser bridge unavailable" }),
  browserForward: async () => ({ error: "browser bridge unavailable" }),
  browserReload: async () => ({ error: "browser bridge unavailable" }),
  browserExtract: async () => ({ error: "browser bridge unavailable" }),
  browserEval: async () => ({ error: "browser bridge unavailable" }),
  browserScreenshot: async () => ({ error: "browser bridge unavailable" }),
  browserConsole: async () => ({ error: "browser bridge unavailable" }),
  browserUrl: async () => ({ error: "browser bridge unavailable" }),
  browserClose: async () => ({ error: "browser bridge unavailable" }),
  browserList: async () => [],
  spawnManagedAgent: () => null,
  readLeafBuffer: () => null,
};

const CHATS_LRU_CAP = 8;
export const chats = new Map<string, Chat<UIMessage>>();

export function touchChat(id: string, c: Chat<UIMessage>) {
  if (chats.has(id)) chats.delete(id);
  chats.set(id, c);
  while (chats.size > CHATS_LRU_CAP) {
    const oldest = chats.keys().next().value;
    if (!oldest || oldest === id) break;
    if (useChatStore.getState().activeSessionId === oldest) break;
    flushPersistEntry(oldest);
    void chats.get(oldest)?.stop();
    chats.delete(oldest);
  }
}
// Initial messages for a session, populated at hydration time and consumed
// when the matching Chat is constructed.
export const seedMessages = new Map<string, UIMessage[]>();

// Trailing debounce for per-token message persistence. Streaming fires
// `persistMessages` on every token; without this we'd JSON-serialize the
// full message array and round-trip to the store plugin per token, which
// stalls the UI. Flush on idle (status transition) via `flushPersist`.
const PERSIST_DEBOUNCE_MS = 300;
const pendingPersist = new Map<
  string,
  { latest: UIMessage[]; timer: ReturnType<typeof setTimeout> }
>();

function flushPersistEntry(id: string) {
  const entry = pendingPersist.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingPersist.delete(id);
  void saveMessages(id, entry.latest);
}

export function flushPersist(id?: string): void {
  if (id) {
    flushPersistEntry(id);
    return;
  }
  for (const key of Array.from(pendingPersist.keys())) flushPersistEntry(key);
}

/**
 * The `AgentMeta` patch to apply when a session is opened after a restart, so
 * the transcript can offer "Continue"/"Resume".
 *
 * - `RunMeta` with a stop (user stop or a guard) → restore that stop so the
 *   existing "Continue" affordance shows.
 * - `RunMeta` with no stop but still in flight → the app closed mid-run; treat
 *   as `"interrupted"` and offer "Resume".
 * - No `RunMeta` but a stale in-flight marker → same interrupted case, the run
 *   had not yet recorded where it stopped.
 */
export function runInterruptedPatch(
  meta: RunMeta | null,
  inFlight: number | null,
): Partial<AgentMeta> | null {
  if (meta) {
    if (meta.stopReason !== null || meta.stoppedByUser) {
      return {
        runRound: meta.runRound,
        stopReason: (meta.stopReason as AgentStopReason | null) ?? null,
        stoppedByUser: meta.stoppedByUser,
      };
    }
    if (inFlight !== null) {
      return {
        runRound: meta.runRound,
        stopReason: "interrupted",
        stoppedByUser: false,
      };
    }
    return null;
  }
  if (inFlight !== null) {
    return { stopReason: "interrupted", stoppedByUser: false };
  }
  return null;
}

async function loadInterruptedPatch(
  id: string,
): Promise<Partial<AgentMeta> | null> {
  const [meta, inFlight] = await Promise.all([
    loadRunMeta(id),
    loadRunInFlight(id),
  ]);
  return runInterruptedPatch(meta, inFlight);
}

async function hasInterruptedRun(id: string): Promise<boolean> {
  const [meta, inFlight] = await Promise.all([
    loadRunMeta(id),
    loadRunInFlight(id),
  ]);
  if (inFlight !== null) return true;
  return meta !== null && (meta.stopReason !== null || meta.stoppedByUser);
}

export const useChatStore = create<StoreState>((set, get) => ({
  live: NOOP_LIVE,
  setLive: (live) => set({ live }),

  approvalResponder: null,
  setApprovalResponder: (fn) => set({ approvalResponder: fn }),
  respondToApproval: (approvalId, approved) => {
    const fn = get().approvalResponder;
    if (fn) fn(approvalId, approved);
  },

  apiKeys: { ...EMPTY_PROVIDER_KEYS },
  setApiKeys: (keys) => set({ apiKeys: keys }),
  setApiKey: (provider, key) => {
    set({ apiKeys: { ...get().apiKeys, [provider]: key } });
  },

  customEndpointKeys: {},
  setCustomEndpointKeys: (keys) => set({ customEndpointKeys: keys }),

  selectedModelId: DEFAULT_MODEL_ID,
  setSelectedModelId: (id) => {
    set({ selectedModelId: id });
    void pushRecentModel(id);
  },

  mini: { open: false },
  openMini: () => set({ mini: { open: true } }),
  closeMini: () => set({ mini: { open: false } }),
  toggleMini: () => set((s) => ({ mini: { open: !s.mini.open } })),

  panelOpen: false,
  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),

  focusSignal: 0,
  pendingPrefill: null,
  focusInput: (prefill = null) =>
    set((s) => ({
      panelOpen: true,
      focusSignal: s.focusSignal + 1,
      pendingPrefill: prefill ?? null,
    })),
  consumePrefill: () => {
    const v = get().pendingPrefill;
    if (v != null) set({ pendingPrefill: null });
    return v;
  },

  pendingSelections: [],
  attachSelection: (text, source) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = `sel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({
      panelOpen: true,
      focusSignal: s.focusSignal + 1,
      pendingSelections: [
        ...s.pendingSelections,
        { id, text: trimmed, source },
      ],
    }));
  },
  consumeSelections: () => {
    const v = get().pendingSelections;
    if (v.length > 0) set({ pendingSelections: [] });
    return v;
  },

  agentMeta: IDLE_META,
  patchAgentMeta: (patch) =>
    set((s) => ({ agentMeta: { ...s.agentMeta, ...patch } })),
  resetAgentMeta: () => set({ agentMeta: IDLE_META }),

  lastRun: null,
  setLastRun: (r) => set({ lastRun: r }),

  steerQueue: EMPTY_QUEUE,
  queueSteer: (message) =>
    set((s) => ({ steerQueue: enqueue(s.steerQueue, message) })),
  cancelSteer: (index) =>
    set((s) => ({ steerQueue: removeSteer(s.steerQueue, index) })),
  clearSteer: () => set({ steerQueue: EMPTY_QUEUE }),

  syncRunMeta: () => {
    const { activeSessionId, agentMeta } = get();
    const id = activeSessionId;
    if (!id) return;
    // A settled run is no longer "in flight" — whether it finished, stopped, or
    // errored. Clearing the marker here means a restart no longer reads it as
    // an interrupted run.
    void deleteRunInFlight(id);
    const interrupted =
      agentMeta.stopReason !== null || agentMeta.stoppedByUser;
    if (interrupted) {
      void saveRunMeta(id, {
        runRound: agentMeta.runRound,
        stopReason: agentMeta.stopReason,
        stoppedByUser: agentMeta.stoppedByUser,
        at: Date.now(),
      });
    } else {
      void deleteRunMeta(id);
    }
  },

  markRunStarted: () => {
    const { activeSessionId, agentMeta } = get();
    const id = activeSessionId;
    if (!id) return;
    void saveRunInFlight(id, Date.now());
    void saveRunMeta(id, {
      runRound: agentMeta.runRound,
      stopReason: null,
      stoppedByUser: false,
      at: Date.now(),
    });
  },

  sessionsHydrated: false,
  sessions: [],
  activeSessionId: null,

  hydrateSessions: async () => {
    if (get().sessionsHydrated) return;
    const { sessions, activeId } = await loadAll();

    // Reuse the most recent untitled "New chat" session if one exists from
    // the previous run — no point stacking empty placeholder sessions every
    // launch. Otherwise prepend a fresh one.
    const reusable = sessions[0]?.title === "New chat" ? sessions[0] : null;
    let nextSessions: SessionMeta[];
    let freshId: string;
    if (reusable) {
      nextSessions = sessions;
      freshId = reusable.id;
    } else {
      freshId = newSessionId();
      const fresh: SessionMeta = {
        id: freshId,
        title: "New chat",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      nextSessions = [fresh, ...sessions];
      void saveSessionsList(nextSessions);
    }

    // If a run was cut off mid-flight (the app closed while the model was
    // working), reopen that session so the user can resume immediately rather
    // than hunting through history. Otherwise keep the fresh placeholder.
    const resumed =
      activeId && sessions.some((s) => s.id === activeId)
        ? await hasInterruptedRun(activeId)
        : false;
    const targetId = resumed && activeId ? activeId : freshId;
    if (targetId !== freshId) {
      const msgs = await loadMessages(targetId);
      if (msgs && msgs.length > 0) seedMessages.set(targetId, msgs);
    }
    void saveActiveId(targetId);

    set({
      sessions: nextSessions,
      activeSessionId: targetId,
      sessionsHydrated: true,
    });
    // Restore an interrupted run so the active chat can offer "Continue"/"Resume"
    // after the app was closed mid-run.
    void loadInterruptedPatch(targetId).then((patch) => {
      if (!patch) return;
      if (useChatStore.getState().activeSessionId !== targetId) return;
      useChatStore.getState().patchAgentMeta(patch);
    });
  },

  newSession: () => {
    notifySessionLeft(get().activeSessionId);
    const id = newSessionId();
    const meta: SessionMeta = {
      id,
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const next = [meta, ...get().sessions];
    set({ sessions: next, activeSessionId: id, agentMeta: IDLE_META });
    void saveSessionsList(next);
    void saveActiveId(id);
    return id;
  },

  switchSession: (id) => {
    if (get().activeSessionId === id) return;
    if (!get().sessions.some((s) => s.id === id)) return;
    notifySessionLeft(get().activeSessionId);

    // Lazily seed the chat with persisted messages the first time we open
    // this session. Subsequent switches reuse the cached Chat instance.
    const flip = () => {
      set({ activeSessionId: id, agentMeta: IDLE_META });
      void saveActiveId(id);
      // Restore an interrupted run for the switched-to session so it can offer
      // "Continue"/"Resume". Guard on still-active so a fast double switch
      // cannot apply the first session's meta to the second.
      void loadInterruptedPatch(id).then((patch) => {
        if (useChatStore.getState().activeSessionId !== id) return;
        if (patch) useChatStore.getState().patchAgentMeta(patch);
      });
    };
    if (chats.has(id) || seedMessages.has(id)) {
      flip();
      return;
    }
    void loadMessages(id).then((m) => {
      if (m && m.length > 0 && !chats.has(id)) seedMessages.set(id, m);
      flip();
    });
  },

  deleteSession: (id) => {
    const remaining = get().sessions.filter((s) => s.id !== id);
    chats.get(id)?.stop();
    chats.delete(id);
    seedMessages.delete(id);
    const pend = pendingPersist.get(id);
    if (pend) {
      clearTimeout(pend.timer);
      pendingPersist.delete(id);
    }
    void deleteSessionData(id);
    void useTodosStore.getState().clearSession(id);
    void useSubagentRunStore.getState().clearSession(id);
    void useArtifactsStore.getState().clearSession(id);

    if (remaining.length === 0) {
      const fresh: SessionMeta = {
        id: newSessionId(),
        title: "New chat",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      set({ sessions: [fresh], activeSessionId: fresh.id });
      void saveSessionsList([fresh]);
      void saveActiveId(fresh.id);
      return;
    }

    const wasActive = get().activeSessionId === id;
    const nextActive = wasActive ? remaining[0].id : get().activeSessionId;
    set({ sessions: remaining, activeSessionId: nextActive });
    void saveSessionsList(remaining);
    if (wasActive) void saveActiveId(nextActive);
  },

  renameSession: (id, title) => {
    const next = get().sessions.map((s) =>
      s.id === id ? { ...s, title, updatedAt: Date.now() } : s,
    );
    set({ sessions: next });
    void saveSessionsList(next);
  },

  persistMessages: (id, messages) => {
    // Debounce the message-blob write so streaming doesn't pound the store.
    const existing = pendingPersist.get(id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const entry = pendingPersist.get(id);
      if (!entry) return;
      pendingPersist.delete(id);
      void saveMessages(id, entry.latest);
    }, PERSIST_DEBOUNCE_MS);
    pendingPersist.set(id, { latest: messages, timer });

    // Update zustand session list only when the derived title actually
    // changes — otherwise we'd rewrite the sessions array (and trigger
    // re-renders + a store write) on every token.
    const sessions = get().sessions;
    const meta = sessions.find((s) => s.id === id);
    if (!meta) return;
    const isUntitled = !meta.title || meta.title === "New chat";
    if (!isUntitled) return;
    const nextTitle = deriveTitle(messages);
    if (nextTitle === meta.title) return;
    const next = sessions.map((s) =>
      s.id === id ? { ...s, title: nextTitle, updatedAt: Date.now() } : s,
    );
    set({ sessions: next });
    void saveSessionsList(next);
  },
}));

export function getAgentMeta(): AgentMeta {
  return useChatStore.getState().agentMeta;
}

export function getActiveProviderKey(): string | null {
  const { selectedModelId, apiKeys, customEndpointKeys } =
    useChatStore.getState();
  if (isCompatModelId(selectedModelId)) {
    const eid = endpointIdFromCompatModel(selectedModelId);
    return customEndpointKeys[eid] ?? null;
  }
  return apiKeys[getModel(selectedModelId as ModelId).provider] ?? null;
}

export function hasKeyForModel(modelId: string): boolean {
  const { apiKeys } = useChatStore.getState();
  if (isCompatModelId(modelId)) {
    return true;
  }
  const provider = getModel(modelId as ModelId).provider;
  return providerNeedsKey(provider) ? !!apiKeys[provider] : true;
}

/**
 * Called with a session's messages when the user leaves it. Registered by
 * chatRuntime, which is where the model and workspace root are both reachable;
 * importing that from here would close an import cycle.
 */
let onSessionLeft: ((sessionId: string, messages: UIMessage[]) => void) | null =
  null;

export function setSessionLeftHandler(
  fn: ((sessionId: string, messages: UIMessage[]) => void) | null,
): void {
  onSessionLeft = fn;
}

function notifySessionLeft(sessionId: string | null): void {
  if (!sessionId || !onSessionLeft) return;
  const messages = chats.get(sessionId)?.messages;
  if (!messages || messages.length === 0) return;
  onSessionLeft(sessionId, [...messages]);
}

export function getChat(sessionId?: string): Chat<UIMessage> | undefined {
  if (sessionId) return chats.get(sessionId);
  const id = useChatStore.getState().activeSessionId;
  return id ? chats.get(id) : undefined;
}

export function stop(): void {
  const id = useChatStore.getState().activeSessionId;
  if (!id) return;
  // Deny anything blocked on the user before stopping the stream. A sub-agent
  // waiting on an approval is not reached by aborting the chat - it is waiting
  // on a promise, and Stop has to be an answer to that question too, or the
  // agent hangs until the app closes.
  useApprovalQueue.getState().cancelAll();
  void chats.get(id)?.stop();
}
