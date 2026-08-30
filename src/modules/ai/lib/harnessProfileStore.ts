// Active harness profile per workspace, persisted so a chosen profile sticks.
//
// Persistence uses zustand's localStorage persist. In Tauri every webview of the
// same app shares the same origin storage, so the settings window and the main
// window (where the agent runs) see the same persisted value. To keep the
// in-memory store fresh when another window writes, we rehydrate on `storage`
// events; the agent also reads persisted state directly in `activeProfileIdFor`
// so a newly chosen profile takes effect immediately.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_PROFILE_ID } from "./harnessProfile";

const STORE_KEY = "termigo-harness-profile";

type State = {
  /** workspace root -> active profile id. */
  byWorkspace: Record<string, string>;
  setActiveProfile: (workspace: string | null, profileId: string) => void;
};

export const useHarnessProfileStore = create<State>()(
  persist(
    (set) => ({
      byWorkspace: {},
      setActiveProfile: (workspace, profileId) =>
        set((s) => {
          if (!workspace)
            return { byWorkspace: { ...s.byWorkspace, __default: profileId } };
          return { byWorkspace: { ...s.byWorkspace, [workspace]: profileId } };
        }),
    }),
    { name: STORE_KEY },
  ),
);

// Rehydrate the in-memory store when another window (typically the settings
// window) persists a change. Storage events fire on the same origin across
// windows, so both stay in sync without a Tauri IPC round-trip.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORE_KEY) {
      void useHarnessProfileStore.persist.rehydrate();
    }
  });
}

/** The job: the persisted `byWorkspace` map, read fresh from localStorage (the
 *  source of truth shared with the settings window) rather than the in-memory
 *  store, so a change made in settings is honored on the next run. */
function readPersistedByWorkspace(): Record<string, string> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      state?: { byWorkspace?: Record<string, string> };
    };
    return parsed.state?.byWorkspace ?? null;
  } catch {
    return null;
  }
}

/** The active profile id for a workspace, falling back to the default. */
export function activeProfileIdFor(
  workspace: string | null | undefined,
): string {
  const byWorkspace =
    readPersistedByWorkspace() ?? useHarnessProfileStore.getState().byWorkspace;
  if (workspace && byWorkspace[workspace]) return byWorkspace[workspace];
  return byWorkspace.__default ?? DEFAULT_PROFILE_ID;
}
