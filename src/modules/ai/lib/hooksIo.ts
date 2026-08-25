// Loading hooks from `.termigo/hooks.json`.
//
// The rules live in `hooks.ts`; this is the part that touches the filesystem.

import { native } from "./native";
import { HOOKS_REL_PATH, parseHooksFile, type HooksConfig } from "./hooks";

function hooksPath(workspaceRoot: string): string {
  return `${workspaceRoot.replace(/[\\/]$/, "")}/${HOOKS_REL_PATH}`;
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
): Promise<{ ok: true; config: HooksConfig } | { ok: false; reason: string }> {
  if (!workspaceRoot) return { ok: true, config: {} };
  try {
    const read = await native.readFile(hooksPath(workspaceRoot));
    if (read.kind !== "text") return { ok: true, config: {} };
    return parseHooksFile(read.content);
  } catch {
    return { ok: true, config: {} };
  }
}
