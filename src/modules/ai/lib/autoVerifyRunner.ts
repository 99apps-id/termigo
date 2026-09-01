// Automatic post-edit verification runner (full-agentic loop).
//
// Kept in its own module so `withAutoVerify` (the tool wrapper in autoVerify.ts)
// can be unit-tested with a stubbed runner: the wrapper calls this through an
// import, and a test that mocks this module sees the wrapper's control flow
// without spawning real shells.

import { usePreferencesStore } from "@/modules/settings/preferences";
import type { ToolContext } from "../tools/context";
import { detectCheckCommand, formatCommand } from "../tools/verify";
import { native } from "./native";
import { checkShellCommand } from "./security";
import { getSessionShell, sessionShellKey } from "./sessionShell";

export type VerifyOutcome = {
  formatted: boolean;
  formatter?: string;
  lint: {
    ran: boolean;
    passed?: boolean;
    command?: string;
    output?: string;
  } | null;
};

/**
 * Run a best-effort verify for an edited file: format the touched file, then
 * lint when the project declares a lint script. Returns null when skipped (pref
 * off, no session, remote host) or nothing ran. Never throws.
 */
export async function autoVerifyEditedFile(
  ctx: ToolContext,
  path: string,
): Promise<VerifyOutcome | null> {
  if (!usePreferencesStore.getState().autoVerifyAfterEdit) return null;
  const remote = ctx.getRemoteSession();
  if (remote) return null;
  const sid = ctx.getSessionId();
  if (!sid) return null;
  const root = ctx.getWorkspaceRoot();
  const cwd = root ?? ctx.getCwd() ?? ".";

  try {
    const shellId = await getSessionShell(
      sessionShellKey("verify", sid, root),
      cwd,
    );

    // 1) Format the touched file — fast, local, safe.
    const { command: fmtCommand, note } = formatCommand([path]);
    const fmtSafety = checkShellCommand(fmtCommand);
    let formatted = false;
    let formatter: string | undefined;
    if (fmtSafety.ok) {
      try {
        const f = await native.shellSessionRun(shellId, fmtCommand, cwd, 30);
        formatted = f.exit_code === 0;
        formatter = note;
      } catch {
        formatted = false;
      }
    }

    // 2) Lint, when the project declares a lint script. Best-effort.
    let lint: VerifyOutcome["lint"] = null;
    try {
      const resolved = await detectCheckCommand("lint", {
        pkgJson: await readManifest(root, "package.json"),
        cargo: await readManifest(root, "Cargo.toml"),
        goMod: await readManifest(root, "go.mod"),
        pyproject: await readManifest(root, "pyproject.toml"),
      });
      if (resolved.command) {
        const lintSafety = checkShellCommand(resolved.command);
        if (lintSafety.ok) {
          const r = await native.shellSessionRun(
            shellId,
            resolved.command,
            cwd,
            60,
          );
          lint = {
            ran: true,
            passed: r.exit_code === 0,
            command: resolved.command,
            output: `${r.stdout}\n${r.stderr}`.trim().slice(0, 2000),
          };
        }
      }
    } catch {
      lint = null;
    }

    if (!formatted && !lint) return null;
    return { formatted, formatter, lint };
  } catch {
    return null;
  }
}

async function readManifest(
  root: string | null,
  name: string,
): Promise<string | null> {
  if (!root) return null;
  try {
    const r = (await native.readFile(`${root}/${name}`)) as {
      content?: string;
    };
    return typeof r.content === "string" ? r.content : null;
  } catch {
    return null;
  }
}
