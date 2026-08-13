// Tracks the most recently connected SSH session so the remote file explorer
// can show a live tree without the caller plumbing per-tab state through the
// whole app. Mirrors TEDI's "swap to whichever SSH session was last
// connected" behaviour.
import { create } from "zustand";

export type ActiveSshSession = {
  sessionId: number;
  hostLabel: string;
};

type State = {
  session: ActiveSshSession | null;
  setSession: (session: ActiveSshSession) => void;
  clearSession: (sessionId: number) => void;
};

export const useSshActiveSessionStore = create<State>((set) => ({
  session: null,
  setSession: (session) => set({ session }),
  clearSession: (sessionId) =>
    set((s) => (s.session?.sessionId === sessionId ? { session: null } : s)),
}));
