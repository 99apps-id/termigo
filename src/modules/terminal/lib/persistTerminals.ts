// Pure rules for terminal process persistence.
//
// Termigo cannot keep a PTY alive past its own process, because the master
// handle is owned by the app. So persistence is delegated to tmux when the
// user opts in: each leaf's shell runs inside a named tmux session, and on
// restart the leaf reattaches to the same session instead of spawning a new
// shell. This module holds the parts that are safe to test in isolation:
// session keys, sanitisation, and the attach/create command.
//
// The tmux runtime path is only reached when the user enables the setting AND
// the backend found a usable tmux binary, so the default behaviour is
// unchanged everywhere else.

export const PERSIST_KEY_PREFIX = "termigo-";

/** A persist key must be tmux/session-safe: lowercase, digits, dashes. */
export function isValidPersistKey(key: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,47}$/.test(key);
}

/** Drop unsafe characters and shorten to a valid persist key. */
export function sanitizePersistKey(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "leaf";
}

/** The tmux session name for a leaf's persist key. */
export function tmuxSessionKey(persistKey: string): string {
  return `${PERSIST_KEY_PREFIX}${sanitizePersistKey(persistKey)}`;
}

/** Basename of a path, mirroring the codebase's forward-slash convention. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "leaf";
}

/**
 * Build a stable, tmux-safe key for a leaf.
 *
 * The key is generated once at leaf creation and then persisted, so it stays
 * the same across restarts even though the numeric leaf id is reallocated.
 * A `symbol` (typically the leaf's creation ordinal) keeps same-cwd leaves
 * apart.
 */
export function makePersistKey(cwd: string | undefined, symbol: string): string {
  const base = cwd ? baseName(cwd) : "leaf";
  const slug = sanitizePersistKey(`${base}-${symbol}`);
  return slug;
}

/** Shell-quote one argument for the tmux command line (single quotes). */
function quote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The tmux command that creates a session if absent and reattaches if present.
 *
 * `-A` makes `new-session` attach to an existing session with the same name,
 * which is exactly the restore semantics we want: first open creates the
 * session, a later open reconnects to the still-running one.
 *
 * `shellArgv` is the resolved shell argv (program plus arguments) that tmux
 * should start inside the session. Each element is quoted.
 */
export function tmuxAttachCommand(persistKey: string, shellArgv: string[]): string {
  const session = tmuxSessionKey(persistKey);
  const argv = shellArgv.map(quote).join(" ");
  return `tmux new-session -A -s ${session} -- ${argv}`;
}
