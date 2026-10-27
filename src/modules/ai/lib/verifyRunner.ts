import { getSessionShell } from "./sessionShell";
import { detectCheckCommand, type CheckKind } from "../tools/verify";
import { native } from "./native";

/** Bounded retry for the post-run auto-verifier. */
export const AUTO_VERIFY_MAX_ATTEMPTS = 2;
const AUTO_VERIFY_TIMEOUT_SECS = 300;

export type VerifyRunResult = {
  command: string;
  kind: CheckKind;
  exit_code: number;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

export async function runAutoVerify(
  sessionId: string,
  root: string,
): Promise<VerifyRunResult | null> {
  const cwd = root || ".";
  const read = async (path: string) => {
    try {
      const r = await native.readFile(path);
      return r.kind === "text" ? r.content : null;
    } catch {
      return null;
    }
  };
  const [pkgJson, cargo, goMod, pyproject] = await Promise.all([
    read(`${cwd}/package.json`),
    read(`${cwd}/Cargo.toml`).catch(() => null),
    read(`${cwd}/go.mod`).catch(() => null),
    read(`${cwd}/pyproject.toml`).catch(() => null),
  ]);
  const manifests = { pkgJson, cargo, goMod, pyproject };
  const checks = [detectCheckCommand("lint", manifests), detectCheckCommand("test", manifests)]
    .filter((c) => !!c.command)
    .slice(0, AUTO_VERIFY_MAX_ATTEMPTS);
  if (!checks.length) return null;

  const shellId = await getSessionShell(sessionId, cwd);
  const results: VerifyRunResult[] = [];
  for (const check of checks) {
    if (!check.command) continue;
    const r = await native.shellSessionRun(shellId, check.command, cwd, AUTO_VERIFY_TIMEOUT_SECS);
    results.push({
      command: check.command,
      kind: check.note.includes("test") ? "test" : "lint",
      exit_code: r.exit_code ?? 0,
      timed_out: r.timed_out,
      stdout: r.stdout,
      stderr: r.stderr,
      truncated: r.truncated,
    });
  }

  const passing = results.find((r) => r.exit_code === 0 && !r.timed_out);
  return passing ?? results[0] ?? null;
}
