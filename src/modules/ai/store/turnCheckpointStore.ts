import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import type { TurnCheckpoint } from "../lib/turnCheckpoints";

/**
 * Per-turn git snapshots: each fresh user turn is indexed against the HEAD
 * the auto-checkpoint left behind, so the transcript can offer rewind on the
 * turn itself instead of only the latest checkpoint on an error banner.
 *
 * Persisted to disk so rewind survives a restart; entries reference shas in
 * the user's own history, which needs no extra storage. A row whose message
 * is gone (edited away, session cleared) is pruned, never resurrected.
 */
const STORE_PATH = "termigo-turn-checkpoints.json";
const KEY_BY_SESSION = "bySession";
const turnCheckpointStore = new LazyStore(STORE_PATH, {
  defaults: {},
  autoSave: 200,
});

const MAX_TURNS_PER_SESSION = 50;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let hydratePromise: Promise<void> | null = null;

function scheduleSave(bySession: Record<string, TurnCheckpoint[]>) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void turnCheckpointStore.set(KEY_BY_SESSION, bySession).catch(() => {});
  }, 300);
}

export function ensureTurnCheckpointsHydrated(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const raw =
        await turnCheckpointStore.get<Record<string, TurnCheckpoint[]>>(
          KEY_BY_SESSION,
        );
      if (raw && typeof raw === "object") {
        const clean: Record<string, TurnCheckpoint[]> = {};
        for (const [sessionId, rows] of Object.entries(raw)) {
          if (!Array.isArray(rows)) continue;
          clean[sessionId] = rows
            .filter(
              (r) =>
                r &&
                typeof r.messageId === "string" &&
                typeof r.sha === "string",
            )
            .slice(-MAX_TURNS_PER_SESSION);
        }
        // MERGE, do not replace. This runs fire-and-forget at import, so a
        // checkpoint recorded (or a session cleared) before the read resolved
        // was overwritten by the disk copy and silently vanished: the forked
        // session lost its rewind affordance with nothing to show for it.
        useTurnCheckpointStore.setState((state) => ({
          bySession: mergeBySession(state.bySession, clean),
        }));
      }
    } catch {
      // No file yet, or the store plugin is unavailable (tests / non-Tauri):
      // the in-memory store is a perfectly good fallback.
    }
  })();
  return hydratePromise;
}

/**
 * Disk copy under live state.
 *
 * A session the live store has explicitly cleared stays cleared: hydration is
 * a load, not a resurrection. Anything else is the union, with the longer list
 * winning per session so neither side loses a row.
 */
function mergeBySession(
  live: Record<string, TurnCheckpoint[]>,
  disk: Record<string, TurnCheckpoint[]>,
): Record<string, TurnCheckpoint[]> {
  const out: Record<string, TurnCheckpoint[]> = { ...disk };
  for (const [sessionId, rows] of Object.entries(live)) {
    const fromDisk = disk[sessionId];
    if (!fromDisk) {
      out[sessionId] = rows;
      continue;
    }
    const ids = new Set(rows.map((r) => r.messageId));
    const merged = [...fromDisk.filter((r) => !ids.has(r.messageId)), ...rows];
    out[sessionId] = merged.slice(-MAX_TURNS_PER_SESSION);
  }
  return out;
}

void ensureTurnCheckpointsHydrated();

type TurnCheckpointState = {
  bySession: Record<string, TurnCheckpoint[]>;
  /** Index a turn; a repeat for the same message replaces it in place. */
  record: (sessionId: string, entry: TurnCheckpoint) => void;
  /** Drop a turn and every newer one: their history was edited away. */
  pruneAfter: (sessionId: string, messageId: string) => void;
  entryFor: (sessionId: string, messageId: string) => TurnCheckpoint | null;
  clearSession: (sessionId: string) => void;
};

export const useTurnCheckpointStore = create<TurnCheckpointState>(
  (set, get) => ({
    bySession: {},
    record: (sessionId, entry) => {
      const rows = get().bySession[sessionId] ?? [];
      const idx = rows.findIndex((r) => r.messageId === entry.messageId);
      const next =
        idx >= 0
          ? rows.map((r, i) => (i === idx ? entry : r))
          : [...rows, entry].slice(-MAX_TURNS_PER_SESSION);
      const bySession = { ...get().bySession, [sessionId]: next };
      set({ bySession });
      scheduleSave(bySession);
    },
    pruneAfter: (sessionId, messageId) => {
      const rows = get().bySession[sessionId];
      if (!rows) return;
      const idx = rows.findIndex((r) => r.messageId === messageId);
      if (idx < 0) return;
      const bySession = {
        ...get().bySession,
        [sessionId]: rows.slice(0, idx),
      };
      set({ bySession });
      scheduleSave(bySession);
    },
    entryFor: (sessionId, messageId) =>
      get().bySession[sessionId]?.find((r) => r.messageId === messageId) ??
      null,
    clearSession: (sessionId) => {
      if (!get().bySession[sessionId]) return;
      const bySession = { ...get().bySession };
      delete bySession[sessionId];
      set({ bySession });
      scheduleSave(bySession);
    },
  }),
);
