import { native } from "./native";

// Per-call persistent shell sessions, shared by the agent's shell-backed tools
// (bash_run, run_checks, git_*). A cwd set in one tool survives the next call
// in the same chat session, so `cd`-and-work sequences stay cheap.
const sessionShells = new Map<string, Promise<number>>();

export function sessionShellKey(
  prefix: string,
  sessionId: string,
  root: string | null,
): string {
  return `${prefix}:${sessionId}:${root ?? "none"}`;
}

export async function getSessionShell(
  key: string,
  cwd: string | null,
): Promise<number> {
  let p = sessionShells.get(key);
  if (!p) {
    p = native.shellSessionOpen(cwd);
    sessionShells.set(key, p);
  }
  return p;
}
