// Loading hooks from `.termigo/hooks.json`.
//
// The rules live in `hooks.ts`; this is the part that touches the filesystem.

import { native } from "./native";
import { HOOKS_REL_PATH, parseHooksFile, type HooksConfig } from "./hooks";

function hooksPath(workspaceRoot: string): string {
  return `${workspaceRoot.replace(/[\\/]$/, "")}/${HOOKS_REL_PATH}`;
}

type HooksOutcome =
  | { ok: true; config: HooksConfig }
  | { ok: false; reason: string };

const hooksCache = new Map<string, { result: HooksOutcome; at: number }>();

export function clearHooksCache(): void {
  hooksCache.clear();
}

/**
 * Load and parse `.termigo/hooks.json` for a workspace.
 *
 * Returns an empty config when the file is missing, unreadable, or not text.
 * A malformed file returns `{ ok: false, reason }` so the caller can surface
 * the error rather than silently ignoring it.
 */
export async function loadHooks(
  workspaceRoot: string | null,
): Promise<HooksOutcome> {
  if (!workspaceRoot) return { ok: true, config: {} };
  const now = Date.now();
  const cached = hooksCache.get(workspaceRoot);
  if (cached && now - cached.at < 30_000) {
    return cached.result;
  }
  try {
    const read = await native.readFile(hooksPath(workspaceRoot));
    if (read.kind !== "text") {
      const res: HooksOutcome = { ok: true, config: {} };
      hooksCache.set(workspaceRoot, { result: res, at: now });
      return res;
    }
    const res = parseHooksFile(read.content);
    hooksCache.set(workspaceRoot, { result: res, at: now });
    return res;
  } catch {
    const res: HooksOutcome = { ok: true, config: {} };
    hooksCache.set(workspaceRoot, { result: res, at: now });
    return res;
  }
}
