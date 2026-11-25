import { canonicalDirPath } from "@/lib/path";
import { IS_WINDOWS } from "@/lib/platform";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import type { IMarker, Terminal } from "@xterm/xterm";

const MAX_OSC52_CLIPBOARD_BYTES = 1024 * 1024;

/**
 * Cross-handler state shared between the OSC 7 cwd handler and the OSC 133
 * prompt-marker handler. Tracks whether we are currently inside an executing
 * command (between OSC 133 C and the next OSC 133 D / A), so the cwd handler
 * can ignore OSC 7 updates emitted by *command output* (e.g. a remote SSH
 * server, a `cat` of an attacker-controlled file). Only OSC 7 issued by the
 * local shell -- which fires between commands and at prompt time -- should be honored.
 */
export type ShellIntegrationState = {
  inCommand: boolean;
  /**
   * Whether this terminal has ever seen a shell-integration marker.
   *
   * OSC 133 and OSC 7 are ordinary bytes on the same stream as command
   * output, so a `printf` can forge them. That is inherent to in-band shell
   * integration (VS Code lives with the same property), but a terminal with
   * NO integration at all has no legitimate source of OSC 7: accepting it
   * there lets any program the user runs retarget the workspace. Requiring
   * one marker first means the attacker has to forge a plausible prompt
   * sequence, and the real shell's markers interleave with theirs.
   */
  sawMarker: boolean;
};

export function createShellIntegrationState(): ShellIntegrationState {
  return { inCommand: false, sawMarker: false };
}

export function registerCwdHandler(
  term: Terminal,
  onCwd: (cwd: string) => void,
  state?: ShellIntegrationState,
): () => void {
  const d = term.parser.registerOscHandler(7, (data) => {
    // Reject OSC 7 emitted while a command is running: command stdout/stderr
    // is untrusted (it can come from a remote shell, an SSH session, a `cat`
    // of attacker-controlled bytes). The local shell only emits OSC 7
    // between commands via its precmd/PROMPT_COMMAND hook.
    if (state?.inCommand) return true;
    // No marker seen yet means no shell integration is installed, so there is
    // no legitimate source for a cwd report on this pane.
    if (state && !state.sawMarker) return true;
    const cwd = parseOsc7(data);
    if (cwd) onCwd(cwd);
    return true;
  });
  return () => d.dispose();
}

export type PromptTracker = {
  getMarker: () => IMarker | null;
  dispose: () => void;
};

export function registerPromptTracker(
  term: Terminal,
  state?: ShellIntegrationState,
  // Fires on C (process executing) and A/D/B (back at prompt).
  onCommandState?: (running: boolean) => void,
): PromptTracker {
  let marker: IMarker | null = null;
  let lastRunning: boolean | null = null;
  const updateRunning = (next: boolean) => {
    if (state) {
      state.inCommand = next;
      state.sawMarker = true;
    }
    if (lastRunning !== next) {
      lastRunning = next;
      onCommandState?.(next);
    }
  };
  const d = term.parser.registerOscHandler(133, (data) => {
    // OSC 133 A -- start of new prompt (between commands).
    if (data.startsWith("A")) {
      updateRunning(false);
      marker?.dispose();
      marker = term.registerMarker(0);
    } else if (data.startsWith("B")) {
      // OSC 133 B -- prompt ended, command line starts. The user is typing
      // at the prompt (no command executing yet). Keep inCommand false so
      // prompt hooks (Starship, chpwd, direnv) emitting OSC 7 are honored.
      updateRunning(false);
    } else if (data.startsWith("C")) {
      // OSC 133 C -- command execution begins. From here until D/A, all output
      // comes from the executing process and is untrusted for CWD updates.
      updateRunning(true);
    } else if (data.startsWith("D")) {
      // OSC 133 D -- command ends.
      updateRunning(false);
    }
    return true;
  });
  return {
    getMarker: () => (marker && !marker.isDisposed ? marker : null),
    dispose: () => {
      d.dispose();
      marker?.dispose();
      marker = null;
    },
  };
}

/**
 * ConEmu's OSC 9;4 progress sub-protocol -- build tools (cargo, webpack, vite)
 * emit it to drive a taskbar progress bar. `9;4;<state>;<pct>`:
 *   state 0 = clear, 1 = normal (pct), 2 = error, 3 = indeterminate, 4 = paused.
 * Declines any non-`4;` OSC 9 (iTerm2 notification) so another handler can run.
 */
export function registerProgressHandler(
  term: Terminal,
  onProgress: (state: number, progress: number | null) => void,
): () => void {
  const d = term.parser.registerOscHandler(9, (data) => {
    if (!data.startsWith("4;")) return false;
    const parts = data.split(";");
    const state = Number.parseInt(parts[1] ?? "", 10);
    if (!Number.isFinite(state)) return false;
    const raw = parts.length > 2 ? Number.parseInt(parts[2], 10) : Number.NaN;
    onProgress(state, Number.isFinite(raw) ? raw : null);
    return true;
  });
  return () => d.dispose();
}

export type ClipboardWriter = (text: string) => void | Promise<void>;

export function registerOsc52ClipboardHandler(
  term: Terminal,
  writeClipboard: ClipboardWriter = writeSystemClipboard,
): () => void {
  const d = term.parser.registerOscHandler(52, (data) => {
    const text = parseOsc52Clipboard(data);
    if (text === null) return true;
    queueMicrotask(() => {
      try {
        void Promise.resolve(writeClipboard(text)).catch(() => {});
      } catch {}
    });
    return true;
  });
  return () => d.dispose();
}

function parseOsc7(data: string): string | null {
  const m = data.match(/^file:\/\/[^/]*(\/.*)$/);
  if (!m) return null;
  let path = m[1];
  try {
    path = decodeURIComponent(path);
  } catch {}
  // UNC (\\server\share\dir) arrives as //server/share/dir. Keep it whole: the
  // old code stripped the server component and produced //share/dir, a host
  // that does not exist, so the status bar and the file tree both failed.
  if (path.startsWith("//")) {
    return canonicalDirPath(path);
  }
  if (/^\/[A-Za-z]:/.test(path)) {
    path = path.slice(1);
  } else if (/^\/$/.test(path)) {
    // Bare root has no drive prefix; keep it so useFileTree does not clear.
    return canonicalDirPath(path);
  } else if (IS_WINDOWS && !isWslWorkspace()) {
    // git-bash (MSYS) reports cwd as /c/Users/foo; map it to C:/Users/foo.
    //
    // Gated on the WORKSPACE, not the host OS: on a Windows host with a WSL
    // distro selected, a legitimate Linux path like /e/tools was being
    // rewritten to E:/tools, a path that exists only inside WSL.
    const drive = path.match(/^\/([A-Za-z])(\/.*)?$/);
    if (drive) path = `${drive[1].toUpperCase()}:${drive[2] ?? "/"}`;
  }
  return canonicalDirPath(path);
}

/** Whether the active workspace is WSL, so MSYS drive mapping must not run. */
function isWslWorkspace(): boolean {
  return useWorkspaceEnvStore.getState().env.kind === "wsl";
}

function parseOsc52Clipboard(data: string): string | null {
  const parts = data.split(";");
  if (parts.length < 2) return null;
  const selection = parts[0] || "c";
  if (!selection.includes("c")) return null;
  const encoded = parts.slice(1).join(";");
  if (!encoded || encoded === "?") return null;
  if (encoded.length > Math.ceil((MAX_OSC52_CLIPBOARD_BYTES * 4) / 3) + 4) {
    return null;
  }
  const compact = encoded.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;

  try {
    const bytes = Uint8Array.from(atob(compact), (c) => c.charCodeAt(0));
    if (bytes.byteLength > MAX_OSC52_CLIPBOARD_BYTES) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function writeSystemClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
