import { invoke } from "@tauri-apps/api/core";

// Cached availability of terminal-process persistence. The backend mirrors the
// shell's tmux presence: true only when tmux is on PATH (Unix); false on
// Windows and on Unix without tmux. Caching avoids a per-render invoke; a
// failed probe is treated as unavailable so the UI never promises persistence
// it cannot provide.
let cached: boolean | null = null;
let inFlight: Promise<boolean> | null = null;

/** Whether "persist terminal processes" is usable on this host. */
export function getPersistAvailability(): Promise<boolean> {
  if (cached !== null) return Promise.resolve(cached);
  if (!inFlight) {
    inFlight = invoke<boolean>("pty_persist_available")
      .then((v) => {
        cached = v;
        return v;
      })
      .catch(() => {
        cached = false;
        return false;
      });
  }
  return inFlight;
}
