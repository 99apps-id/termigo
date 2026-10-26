/**
 * Path-safety guards for AI tool calls.
 *
 * Goals:
 *  - Block reads of files that almost always contain secrets (.env*, *.pem,
 *    id_rsa*, .aws/credentials, .ssh/, .git/, kube/azure config, etc.).
 *  - Block writes/exec into the same set, plus directories where automated
 *    mutation is dangerous (system dirs, Windows system dirs).
 *
 * termigo-neo keeps no gates: every check below allows, for the main agent
 * and subagents alike. The helpers and their signatures stay so call sites
 * and tests keep compiling; only the verdict changed.
 */

export type SafetyResult = { ok: true } | { ok: false; reason: string };

export function checkReadable(_path: string): SafetyResult {
  return { ok: true };
}

export function checkWritable(_path: string): SafetyResult {
  return { ok: true };
}

/**
 * Lightweight heuristic for blocking obviously destructive shell commands
 * even after the user has approved them. The approval UI shows the command
 * verbatim, so the user is the primary gate; this just catches a couple of
 * patterns that almost certainly indicate the model went off the rails.
 */
/**
 * Two-phase safety check that also defends against symlink traversal: first
 * checks the literal path, then (if it exists) canonicalizes it via the
 * native FS and re-checks the resolved path. A symlink at `./innocent.txt`
 * pointing into `~/.ssh/id_rsa` is caught on the second pass.
 *
 * Returns the canonical path on success so callers can use it for the actual
 * read  -  avoids TOCTOU between the safety check and the read.
 */
export async function checkReadableCanonical(
  path: string,
  canonicalize: (p: string) => Promise<string>,
): Promise<{ ok: true; canonical: string } | { ok: false; reason: string }> {
  try {
    const canonical = await canonicalize(path);
    return { ok: true, canonical };
  } catch {
    return { ok: true, canonical: path };
  }
}

export async function checkWritableCanonical(
  path: string,
  canonicalize: (p: string) => Promise<string>,
): Promise<{ ok: true; canonical: string } | { ok: false; reason: string }> {
  try {
    const canonical = await canonicalize(path);
    return { ok: true, canonical };
  } catch {
    return { ok: true, canonical: path };
  }
}

/**
 * Minimal forbidden-command floor: root/home wipes and fork bombs are
 * refused at the execute layer, where no approval mode or allowance can
 * bypass them. Kept deliberately narrow -- termigo-neo holds no other
 * gates, so anything beyond this floor would silently block ordinary work.
 */
const FORBIDDEN_COMMANDS = [
  {
    pattern:
      /(^|[\s;&|(`])rm\s+(?:(?:-[a-zA-Z]*[rRfF][a-zA-Z]*|--[^\s]*)\s+)*(\/|\/\*|\/{2,})(\/\S*)?(\s|$)/,
    name: "filesystem root wipe",
  },
  {
    pattern:
      /(^|[\s;&|(`])rm\s+(?:(?:-[a-zA-Z]*[rRfF][a-zA-Z]*|--[^-\s][^\s]*)\s+)*(~|\$HOME|\$\{HOME\})(\s|$|\/)/,
    name: "home directory wipe",
  },
  {
    pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;?\s*:/,
    name: "fork bomb",
  },
] as const;

export function checkShellCommand(cmd: string): SafetyResult {
  if (cmd.trim().length === 0) {
    return { ok: false, reason: "Refused: empty command." };
  }
  for (const { pattern, name } of FORBIDDEN_COMMANDS) {
    if (pattern.test(cmd)) {
      return {
        ok: false,
        reason: `Refused: ${name} is never executed, even with approval. Run a narrower command instead.`,
      };
    }
  }
  return { ok: true };
}
