import type { UIMessage } from "@ai-sdk/react";
import { LazyStore } from "@tauri-apps/plugin-store";

export type SessionMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  chatId?: number;
  threadId?: number | null;
};

const STORE_PATH = "termigo-ai-sessions.json";
const KEY_SESSIONS = "sessions";
const KEY_ACTIVE = "activeId";
const messagesKey = (id: string) => `messages:${id}`;
const runMetaKey = (id: string) => `runMeta:${id}`;

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

/**
 * Where the active session's run was left off, persisted so the app can offer
 * "Continue" after a restart. `stopReason` and `stoppedByUser` mirror
 * `agentMeta`; `runRound` keeps the budget ladder where a Continue left it.
 */
export type RunMeta = {
  runRound: number;
  stopReason: string | null;
  stoppedByUser: boolean;
  at: number;
};

export type LoadedSessions = {
  sessions: SessionMeta[];
  activeId: string | null;
};

export async function loadAll(): Promise<LoadedSessions> {
  // Two reads rather than one `entries()`.
  //
  // The comment here used to say entries() saved an IPC roundtrip, and it does,
  // but it also returns EVERY value in the file - and this store holds each
  // session's whole transcript under `messages:<id>`. On a field install that is
  // 17MB and 66k strings dragged across IPC and materialised in the webview on
  // every boot, to read two keys. Per-session messages are still loaded lazily
  // through `loadMessages`; they were only never supposed to be part of boot.
  // Two `get()` calls in parallel transfer two values, and the roundtrip they
  // cost is concurrent.
  const [sessions, activeId] = await Promise.all([
    store.get<SessionMeta[]>(KEY_SESSIONS),
    store.get<string | null>(KEY_ACTIVE),
  ]);
  return { sessions: sessions ?? [], activeId: activeId ?? null };
}

export async function loadMessages(id: string): Promise<UIMessage[] | null> {
  return (await store.get<UIMessage[]>(messagesKey(id))) ?? null;
}

export async function saveSessionsList(sessions: SessionMeta[]): Promise<void> {
  await store.set(KEY_SESSIONS, sessions);
}

export async function saveActiveId(id: string | null): Promise<void> {
  await store.set(KEY_ACTIVE, id);
}

export async function saveMessages(
  id: string,
  messages: UIMessage[],
): Promise<void> {
  await store.set(messagesKey(id), messages);
  try {
    const { indexMessagesBatch } = await import("./fts5");
    const items: Array<{ messageId: string; text: string }> = [];
    for (const m of messages) {
      for (const p of m.parts) {
        if (p.type !== "text") continue;
        const text = (p as { text?: string }).text;
        if (typeof text === "string" && text.trim()) {
          items.push({ messageId: m.id, text });
        }
      }
    }
    if (items.length > 0) {
      void indexMessagesBatch(id, items);
    }
  } catch {
    // search index is best-effort; never break session persistence.
  }
}

export async function deleteSessionData(id: string): Promise<void> {
  await store.delete(messagesKey(id));
  try {
    const { deleteSessionFromIndex } = await import("./fts5");
    void deleteSessionFromIndex(id);
  } catch {
    // best-effort
  }
}

export async function saveRunMeta(id: string, meta: RunMeta): Promise<void> {
  await store.set(runMetaKey(id), meta);
}

export async function loadRunMeta(id: string): Promise<RunMeta | null> {
  return (await store.get<RunMeta>(runMetaKey(id))) ?? null;
}

export async function deleteRunMeta(id: string): Promise<void> {
  await store.delete(runMetaKey(id));
}

/**
 * Whether a run is currently in flight for the session. Set when a run starts,
 * cleared when it settles (finishes, stops, or errors). On boot it tells us a
 * run was cut off mid-flight by the app closing — distinct from a deliberate
 * stop (which writes `RunMeta` with `stoppedByUser`/`stopReason`).
 */
const runInFlightKey = (id: string) => `runInFlight:${id}`;

export async function saveRunInFlight(id: string, at: number): Promise<void> {
  await store.set(runInFlightKey(id), at);
}

export async function loadRunInFlight(id: string): Promise<number | null> {
  return (await store.get<number>(runInFlightKey(id))) ?? null;
}

export async function deleteRunInFlight(id: string): Promise<void> {
  await store.delete(runInFlightKey(id));
}

export function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function sessionKey(chatId: number, threadId?: number | null): string {
  return threadId ? `${chatId}:${threadId}` : `${chatId}`;
}

export function resolveSessionId(
  chatId: number,
  threadId?: number | null,
  fallback?: string | null,
): string | null {
  if (threadId) return `${chatId}:${threadId}`;
  return chatId ? `${chatId}` : fallback ?? null;
}

/** All human-readable text in a conversation, lowercased, with the injected
 *  context wrappers stripped so a search matches what the user and model
 *  actually said — not terminal/selection/file context spliced into a prompt. */
export function extractMessageText(messages: UIMessage[]): string {
  const out: string[] = [];
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type !== "text") continue;
      out.push((p as { text: string }).text);
    }
  }
  return out
    .join("\n")
    .replace(/<terminal-context[\s\S]*?<\/terminal-context>\s*/g, "")
    .replace(/<selection[\s\S]*?<\/selection>\s*/g, "")
    .replace(/<file[\s\S]*?<\/file>\s*/g, "")
    .toLowerCase();
}

/** Build a lowercased content index (sessionId -> concatenated message text)
 *  by loading every session's messages once. Used for full-text history search;
 *  built lazily by the caller (it touches the store for each session). */
export async function buildSessionSearchIndex(
  sessions: SessionMeta[],
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    sessions.map(async (s): Promise<[string, string]> => {
      const messages = await loadMessages(s.id);
      return [s.id, messages ? extractMessageText(messages) : ""];
    }),
  );
  return new Map(entries);
}

export function deriveTitle(messages: UIMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const p of m.parts) {
      if (p.type !== "text") continue;
      const text = (p as { text: string }).text
        .replace(/<terminal-context[\s\S]*?<\/terminal-context>\s*/g, "")
        .replace(/<selection[\s\S]*?<\/selection>\s*/g, "")
        .replace(/<file[\s\S]*?<\/file>\s*/g, "")
        .trim();
      if (!text) continue;
      const first = text.split("\n")[0].trim();
      return first.length > 40 ? `${first.slice(0, 40)}…` : first;
    }
  }
  return "New chat";
}
