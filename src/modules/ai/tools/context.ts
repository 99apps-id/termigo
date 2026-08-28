/** Remote SSH session of the active terminal, when it is an SSH leaf. */
export type RemoteFsSession = {
  /** russh session id, accepted by the `ssh_sftp_*` commands. */
  sessionId: number;
  /** Last known remote cwd (from OSC 7). Null until the shell reports one. */
  cwd: string | null;
};

export type ToolContext = {
  /** Active terminal tab cwd, used to resolve relative paths. Null = home. */
  getCwd: () => string | null;
  /**
   * Active terminal's remote SSH session. Non-null only when the active
   * terminal tab is an SSH leaf (remote shell); file tools route reads to
   * the remote host over SFTP in that case.
   */
  getRemoteSession: () => RemoteFsSession | null;
  /** Workspace root (explorer root). Used by tools that operate over the project. */
  getWorkspaceRoot: () => string | null;
  /** Last N lines of the active terminal buffer (or null if not a terminal tab). */
  getTerminalContext: () => string | null;
  isActiveTerminalPrivate: () => boolean;
  /**
   * Type a string into the active terminal at the prompt — without executing.
   * Returns false if there is no active terminal tab to inject into.
   */
  injectIntoActivePty: (text: string) => boolean;
  /** Open a new preview tab (in-app iframe) at the given URL. */
  openPreview: (url: string) => boolean;
  /** Open an agent canvas (self-contained HTML: a graph, a plan) in a preview tab. */
  openCanvas: (html: string, title?: string) => boolean;
  /** Open a native browser webview for the agent, returning its current URL. */
  browserOpen: (
    instance: string,
    url: string,
  ) => Promise<{ url: string | null } | { error: string }>;
  /** Navigate an open browser webview to a URL. */
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
  /** Extract the page text from a browser webview. */
  browserExtract: (
    instance: string,
  ) => Promise<{ text: string } | { error: string }>;
  /** Run arbitrary JS inside the browser webview (used by click/type). */
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
  browserUrl: (instance: string) => Promise<{ url: string } | { error: string }>;
  browserClose: (
    instance: string,
  ) => Promise<{ ok: true } | { error: string }>;
  /** Instances currently open, for the agent's `<env>` browsers list. */
  browserList: () => Promise<string[]>;
  /** Spawn a Claude Code agent in a new terminal tab, bound to this session. */
  spawnAgent: (prompt: string) => { tabId: number; leafId: number } | null;
  /** Read the terminal scrollback tail of a managed agent's leaf. */
  readAgentOutput: (leafId: number) => string | null;
  readCache: Map<string, { size: number; hash: number }>;
  /** Active chat session id — used by tools that persist per-session state (todos). */
  getSessionId: () => string | null;
  /**
   * Fire a PreToolUse hook for the named tool. Returns void; failures are
   * swallowed by the runner so a broken hook never blocks the agent.
   */
  firePreToolHook?: (toolName: string, args: Record<string, unknown>) => Promise<void>;
  /**
   * Fire a PostToolUse hook for the named tool. Returns void; failures are
   * swallowed by the runner so a broken hook never blocks the agent.
   */
  firePostToolHook?: (
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
  ) => Promise<void>;
};

export function resolvePath(rawPath: string, cwd: string | null): string {
  if (rawPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rawPath))
    return rawPath;
  if (!cwd)
    throw new Error(
      `cannot resolve relative path "${rawPath}": no active terminal cwd. Pass an absolute path.`,
    );
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  return cwd.endsWith(sep) ? `${cwd}${rawPath}` : `${cwd}${sep}${rawPath}`;
}

/**
 * Resolve a tool-supplied path against a remote SSH session. Absolute POSIX
 * paths (`/...`) and relative paths resolve on the remote host; Windows drive
 * paths (`C:\...`, `C:/...`) always stay local. Returns null for local paths
 * so callers can fall back to the local filesystem.
 */
export function resolveRemotePath(
  rawPath: string,
  remoteCwd: string | null,
): string | null {
  if (/^[a-zA-Z]:[\\/]/.test(rawPath)) return null;
  if (rawPath.startsWith("/")) return rawPath;
  if (!remoteCwd)
    throw new Error(
      `cannot resolve relative remote path "${rawPath}": no remote cwd yet. Pass an absolute remote path.`,
    );
  return remoteCwd.endsWith("/")
    ? `${remoteCwd}${rawPath}`
    : `${remoteCwd}/${rawPath}`;
}

// Re-export dispatcher utilities from tools.ts so callers can import them from
// a single place. The implementation lives there because it references the
// module-level `currentToolRegistry` set by `buildTools`.
export { dispatchTool, resetToolRegistry } from "./tools";
