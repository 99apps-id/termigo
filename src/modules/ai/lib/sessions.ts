import type { UIMessage } from "@ai-sdk/react";
import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";

export type SessionMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  chatId?: number;
  threadId?: number | null;
};

export type MigrationReport = {
  migrated: number;
  alreadyMigrated: number;
  backupCreated: boolean;
};

const STORE_PATH = "termigo-ai-sessions.json";
const KEY_SESSIONS = "sessions";
const KEY_ACTIVE = "activeId";
const KEY_SESSION_MESSAGES = "messages";
const legacyMessagesKey = (id: string) => `messages:${id}`;
const runMetaKey = (id: string) => `runMeta:${id}`;

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

const MAX_OPEN_SESSION_STORES = 2;
const sessionStores = new Map<string, LazyStore>();
const sessionLocks = new Map<string, Promise<unknown>>();
const cleanLegacyIds = new Set<string>();
let migrationPromise: Promise<MigrationReport | null> | null = null;

/**
 * Per-session LazyStore filename in `app_data_dir`. Percent-encodes any
 * character that could be invalid or ambiguous in cross-platform filenames
 * (notably `:` in Telegram `chatId:threadId` session keys on Windows).
 */
export function sessionStorePath(id: string): string {
  const safe = encodeURIComponent(id).replace(
    /[*!'().]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `termigo-ai-session-${safe}.json`;
}

async function tryInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<
  { ok: true; value: T } | { ok: false; unavailable: boolean; error: unknown }
> {
  try {
    const value = await invoke<T>(cmd, args);
    return { ok: true, value };
  } catch (error) {
    const hasTauri =
      typeof window !== "undefined" &&
      Boolean(
        (window as unknown as { __TAURI_INTERNALS__?: unknown })
          .__TAURI_INTERNALS__,
      );
    const unavailable =
      !hasTauri &&
      (error instanceof TypeError || error instanceof ReferenceError);
    return { ok: false, unavailable, error };
  }
}

/**
 * Stream-migrate all legacy `messages:<id>` keys (including orphan keys) out
 * of `termigo-ai-sessions.json` in Rust with bounded memory before `LazyStore`
 * ever loads the monolithic file. Safe to call concurrently; runs once per
 * process and leaves the legacy file untouched if safety cannot be guaranteed.
 */
export function ensureLegacyMigrated(): Promise<MigrationReport | null> {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      const res = await tryInvoke<MigrationReport>("sessions_migrate_legacy");
      if (res.ok) return res.value;
      if (res.unavailable) return null;
      migrationPromise = null;
      throw res.error;
    })();
  }
  return migrationPromise;
}

/** Reset migration state for unit tests. */
export function _resetMigrationForTest(): void {
  migrationPromise = null;
  cleanLegacyIds.clear();
}

function getSessionStore(id: string): {
  store: LazyStore;
  evicted: Array<[string, LazyStore]>;
} {
  const existing = sessionStores.get(id);
  if (existing) {
    // Refresh LRU position.
    sessionStores.delete(id);
    sessionStores.set(id, existing);
    return { store: existing, evicted: [] };
  }
  const created = new LazyStore(sessionStorePath(id), {
    defaults: {},
    autoSave: false,
  });
  sessionStores.set(id, created);

  const evicted: Array<[string, LazyStore]> = [];
  while (sessionStores.size > MAX_OPEN_SESSION_STORES) {
    const oldest = sessionStores.entries().next().value;
    if (!oldest) break;
    const [oldId, oldStore] = oldest;
    if (oldId === id) break;
    sessionStores.delete(oldId);
    evicted.push([oldId, oldStore]);
  }
  return { store: created, evicted };
}

function scheduleEvictedClose(evicted: Array<[string, LazyStore]>): void {
  for (const [oldId, oldStore] of evicted) {
    void withSessionLock(oldId, async () => {
      await oldStore.save().catch(() => {});
      await oldStore.close().catch(() => {});
    });
  }
}

export async function closeSessionStore(id: string): Promise<void> {
  await withSessionLock(id, async () => {
    const s = sessionStores.get(id);
    if (!s) return;
    sessionStores.delete(id);
    await s.save().catch(() => {});
    await s.close().catch(() => {});
  });
}

function withSessionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.then(
    () => {
      if (sessionLocks.get(id) === settled) {
        sessionLocks.delete(id);
      }
    },
    () => {
      if (sessionLocks.get(id) === settled) {
        sessionLocks.delete(id);
      }
    },
  );
  sessionLocks.set(id, settled);
  return next;
}

/**
 * Where the active session's run was left off, persisted so the app can offer
 * "Continue" after a restart. `stopReason` and `stoppedByUser` mirror
 * `agentMeta`; `runRound` keeps the round counter where a Continue left it.
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
  await ensureLegacyMigrated();
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
  await ensureLegacyMigrated();
  return withSessionLock(id, async () => {
    const nativeLoad = await tryInvoke<UIMessage[] | null>(
      "sessions_load_messages",
      { id },
    );
    if (nativeLoad.ok) {
      if (nativeLoad.value !== null && nativeLoad.value !== undefined) {
        return nativeLoad.value;
      }
      // Fallback if startup migration was skipped or a legacy key remained.
      const legacy = await store.get<UIMessage[]>(legacyMessagesKey(id));
      if (legacy === undefined || legacy === null) {
        cleanLegacyIds.add(id);
        return null;
      }
      const nativeSave = await tryInvoke<void>("sessions_save_messages", {
        id,
        messages: legacy,
      });
      if (!nativeSave.ok) {
        throw nativeSave.error;
      }
      try {
        await store.delete(legacyMessagesKey(id));
        await store.save();
        cleanLegacyIds.add(id);
      } catch {
        // Non-fatal: the atomic per-session file already holds the full copy.
      }
      return legacy;
    }
    if (!nativeLoad.unavailable) {
      throw nativeLoad.error;
    }

    // LazyStore fallback (used in node tests or non-Tauri environments).
    const cached = sessionStores.get(id);
    const sessionStore =
      cached ??
      new LazyStore(sessionStorePath(id), { defaults: {}, autoSave: false });

    try {
      const existing =
        await sessionStore.get<UIMessage[]>(KEY_SESSION_MESSAGES);
      if (existing !== undefined && existing !== null) {
        return existing;
      }

      // Legacy fallback & lossless migration from monolithic termigo-ai-sessions.json.
      const legacy = await store.get<UIMessage[]>(legacyMessagesKey(id));
      if (legacy === undefined || legacy === null) {
        cleanLegacyIds.add(id);
        return null;
      }

      // Flush the per-session store BEFORE deleting from the legacy store so a
      // crash or write failure never loses messages. If flushing fails, roll back
      // the in-memory set so a subsequent retry completes the migration cleanly.
      await sessionStore.set(KEY_SESSION_MESSAGES, legacy);
      try {
        await sessionStore.save();
      } catch (err) {
        await sessionStore.delete(KEY_SESSION_MESSAGES).catch(() => {});
        throw err;
      }

      try {
        await store.delete(legacyMessagesKey(id));
        await store.save();
        cleanLegacyIds.add(id);
      } catch {
        // Non-fatal: the per-session store already holds the full copy.
      }

      return legacy;
    } finally {
      if (!cached) {
        await sessionStore.close().catch(() => {});
      }
    }
  });
}

/**
 * Storage cap for one tool-output string inside a persisted transcript.
 *
 * The disk copy used to keep every tool result verbatim forever: a single
 * `read_file` of a large source or a build log left a multi-megabyte blob in
 * `termigo-ai-sessions.json`, and the store file only ever grew. The SEND path
 * already compacts these away (compact.ts elides pre-tail tool results), so the
 * full text is only ever re-read by the history UI — where the head and tail of
 * a huge output are what a human actually scrolls to.
 */
export const MAX_PERSISTED_OUTPUT_CHARS = 64_000;
const PERSIST_HEAD_CHARS = 48_000;
const PERSIST_TAIL_CHARS = 8_000;

function capBigString(s: string): string {
  const omitted = s.length - PERSIST_HEAD_CHARS - PERSIST_TAIL_CHARS;
  return `${s.slice(0, PERSIST_HEAD_CHARS)}\n\n… [${omitted.toLocaleString()} chars truncated for session storage] …\n\n${s.slice(-PERSIST_TAIL_CHARS)}`;
}

/** Cap oversized strings in a tool output: the output itself, or its top-level
 *  string fields ({stdout, stderr}, {content}, {text}). Shallow on purpose —
 *  deeply nested blobs are rare and a deep walk on every debounced save would
 *  cost more than it protects. Returns the input reference when nothing
 *  changed, so callers can skip copying. */
function capOutput(output: unknown): unknown {
  if (typeof output === "string") {
    return output.length > MAX_PERSISTED_OUTPUT_CHARS
      ? capBigString(output)
      : output;
  }
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const rec = output as Record<string, unknown>;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      const capped =
        typeof v === "string" && v.length > MAX_PERSISTED_OUTPUT_CHARS
          ? capBigString(v)
          : v;
      if (capped !== v) changed = true;
      next[k] = capped;
    }
    return changed ? next : output;
  }
  return output;
}

/**
 * The transcript as it should hit disk: identical to the input except that
 * oversized tool outputs are truncated. Never mutates the input (the live chat
 * still renders the full result until the session is reloaded). Text, reasoning
 * and file parts are left alone — those are the user's and the model's words.
 */
export function capPersistedMessages(messages: UIMessage[]): UIMessage[] {
  let changed = false;
  const out = messages.map((m) => {
    let partsChanged = false;
    const parts = m.parts.map((p) => {
      const part = p as unknown as Record<string, unknown>;
      if (!part || typeof part !== "object" || !("output" in part)) return p;
      const capped = capOutput(part.output);
      if (capped === part.output) return p;
      partsChanged = true;
      return { ...(p as object), output: capped } as typeof p;
    });
    if (!partsChanged) return m;
    changed = true;
    return { ...m, parts };
  });
  return changed ? out : messages;
}

export async function saveSessionsList(sessions: SessionMeta[]): Promise<void> {
  await ensureLegacyMigrated();
  await store.set(KEY_SESSIONS, sessions);
}

export async function saveActiveId(id: string | null): Promise<void> {
  await ensureLegacyMigrated();
  await store.set(KEY_ACTIVE, id);
}

export async function saveMessages(
  id: string,
  messages: UIMessage[],
): Promise<void> {
  await ensureLegacyMigrated();
  const capped = capPersistedMessages(messages);
  await withSessionLock(id, async () => {
    const nativeSave = await tryInvoke<void>("sessions_save_messages", {
      id,
      messages: capped,
    });
    if (nativeSave.ok) {
      if (!cleanLegacyIds.has(id)) {
        if (await store.has(legacyMessagesKey(id))) {
          try {
            await store.delete(legacyMessagesKey(id));
            await store.save();
            cleanLegacyIds.add(id);
          } catch {
            // Non-fatal: atomic per-session file already has the latest copy.
          }
        } else {
          cleanLegacyIds.add(id);
        }
      }
      return;
    }
    if (!nativeSave.unavailable) {
      throw nativeSave.error;
    }

    const { store: sessionStore, evicted } = getSessionStore(id);
    scheduleEvictedClose(evicted);

    await sessionStore.set(KEY_SESSION_MESSAGES, capped);
    await sessionStore.save();

    if (!cleanLegacyIds.has(id)) {
      if (await store.has(legacyMessagesKey(id))) {
        try {
          await store.delete(legacyMessagesKey(id));
          await store.save();
          cleanLegacyIds.add(id);
        } catch {
          // Non-fatal: the per-session store already has the latest copy.
        }
      } else {
        cleanLegacyIds.add(id);
      }
    }
  });
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
  await ensureLegacyMigrated();
  await withSessionLock(id, async () => {
    const nativeDel = await tryInvoke<void>("sessions_delete_messages", {
      id,
    });
    if (!nativeDel.ok && !nativeDel.unavailable) {
      throw nativeDel.error;
    }

    const existing = sessionStores.get(id);
    if (existing) {
      sessionStores.delete(id);
      await existing.clear().catch(() => {});
      await existing.save().catch(() => {});
      await existing.close().catch(() => {});
    } else if (!nativeDel.ok && nativeDel.unavailable) {
      const temp = new LazyStore(sessionStorePath(id), {
        defaults: {},
        autoSave: false,
      });
      await temp.clear().catch(() => {});
      await temp.save().catch(() => {});
      await temp.close().catch(() => {});
    }

    if (!cleanLegacyIds.has(id)) {
      if (await store.has(legacyMessagesKey(id))) {
        await store.delete(legacyMessagesKey(id));
      }
      cleanLegacyIds.add(id);
    }
    await store.delete(runMetaKey(id));
    await store.delete(runInFlightKey(id));
  });
  try {
    const { deleteSessionFromIndex } = await import("./fts5");
    void deleteSessionFromIndex(id);
  } catch {
    // best-effort
  }
}

export async function saveRunMeta(id: string, meta: RunMeta): Promise<void> {
  await ensureLegacyMigrated();
  await store.set(runMetaKey(id), meta);
}

export async function loadRunMeta(id: string): Promise<RunMeta | null> {
  await ensureLegacyMigrated();
  return (await store.get<RunMeta>(runMetaKey(id))) ?? null;
}

export async function deleteRunMeta(id: string): Promise<void> {
  await ensureLegacyMigrated();
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
  await ensureLegacyMigrated();
  await store.set(runInFlightKey(id), at);
}

export async function loadRunInFlight(id: string): Promise<number | null> {
  await ensureLegacyMigrated();
  return (await store.get<number>(runInFlightKey(id))) ?? null;
}

export async function deleteRunInFlight(id: string): Promise<void> {
  await ensureLegacyMigrated();
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
  return chatId ? `${chatId}` : (fallback ?? null);
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
