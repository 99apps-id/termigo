import { type CheckKind, detectCheckCommand } from "../tools/verify";
import { native } from "./native";
import { getSessionShell, sessionShellKey } from "./sessionShell";

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
  // Keep the requested kind alongside each resolved command. The note text is
  // free-form prose ("package.json script (pnpm)"), so it must never be used
  // to recover the kind: "pnpm run test" carries no "test" substring and would
  // be mislabelled as a lint run.
  const checks = (
    [
      ["lint", detectCheckCommand("lint", manifests)],
      ["test", detectCheckCommand("test", manifests)],
    ] as const
  )
    .map(([kind, resolved]) => ({ kind, resolved }))
    .filter((c) => !!c.resolved.command)
    .slice(0, AUTO_VERIFY_MAX_ATTEMPTS);
  if (!checks.length) return null;

  const shellId = await getSessionShell(
    sessionShellKey("verify", sessionId, root),
    cwd,
  );
  const results: VerifyRunResult[] = [];
  for (const check of checks) {
    const { kind, resolved } = check;
    if (!resolved.command) continue;
    const r = await native.shellSessionRun(
      shellId,
      resolved.command,
      cwd,
      AUTO_VERIFY_TIMEOUT_SECS,
    );
    results.push({
      command: resolved.command,
      kind,
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
