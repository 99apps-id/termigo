import { create } from "zustand";

/**
 * Session-scoped list of artifacts the agent produced: canvas renders,
 * previews opened, files created/written. An "Artifacts" panel lets the user
 * reopen / jump to them without re-asking the model (BatikCode
 * `setArtifactsTool` + `chatArtifactsWidget` parity). In-memory per session,
 * cleared when the session is deleted.
 */
export type ArtifactKind = "canvas" | "preview" | "file";

export type Artifact = {
  id: string;
  kind: ArtifactKind;
  /** Short human title (e.g. canvas title, file basename, host). */
  title: string;
  /** The payload an opener needs: canvas HTML, a URL, or a file path. */
  payload: string;
  at: number;
};

const MAX_ARTIFACTS_PER_SESSION = 50;

let seq = 0;

type ArtifactsState = {
  bySession: Record<string, Artifact[]>;
  add: (
    sessionId: string,
    info: { kind: ArtifactKind; title: string; payload: string },
  ) => void;
  remove: (sessionId: string, id: string) => void;
  clearSession: (sessionId: string) => void;
};

export const useArtifactsStore = create<ArtifactsState>((set) => ({
  bySession: {},

  add(sessionId, info) {
    if (!sessionId) return;
    const artifact: Artifact = {
      id: `art-${++seq}`,
      kind: info.kind,
      title: info.title,
      payload: info.payload,
      at: Date.now(),
    };
    set((s) => {
      const list = s.bySession[sessionId] ?? [];
      const next = [...list, artifact];
      if (next.length > MAX_ARTIFACTS_PER_SESSION) {
        next.splice(0, next.length - MAX_ARTIFACTS_PER_SESSION);
      }
      return { bySession: { ...s.bySession, [sessionId]: next } };
    });
  },

  remove(sessionId, id) {
    set((s) => {
      const list = s.bySession[sessionId];
      if (!list) return {};
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: list.filter((a) => a.id !== id),
        },
      };
    });
  },

  clearSession(sessionId) {
    set((s) => {
      if (!(sessionId in s.bySession)) return s;
      const next = { ...s.bySession };
      delete next[sessionId];
      return { bySession: next };
    });
  },
}));
