// Verification-on-stop gate (policy only).
//
// Ported from the Hermes TUI's `verification_stop.py`: the agent loop never
// runs checks itself — it keeps a passive ledger of which CODE files a run
// edited and whether fresh passing verification evidence exists since the
// last edit. When the model tries to end a run cleanly right after editing
// code with no such evidence, the runtime sends ONE bounded synthetic
// follow-up (max `MAX_VERIFY_NUDGES` per task) asking it to verify, repair,
// and summarise — or to name the concrete blocker instead of claiming the
// work is verified.
//
// Evidence sources (all observed from tool results, never executed here):
// - `run_checks` exiting 0 (the purpose-built test/lint tool);
// - `bash_run` exiting 0 whose command looks like a check (test/lint/build…);
// - `bash_wait` reporting a background process that exited 0 (builds);
// - the per-edit auto-verify fold (`verification.lint.passed`) when the
//   "Auto-verify after edits" preference already proved the touched file.
//
// Prose/data edits (README.md, LICENSE, notes.txt, …) never demand
// verification: a turn touching only those stays silent.

/** Prose/data extensions with no verifiable runtime behavior. */
const NON_CODE_VERIFY_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".rst",
  ".txt",
  ".text",
  ".adoc",
  ".asciidoc",
  ".org",
  ".log",
  ".csv",
  ".tsv",
]);

/** Extension-less prose filenames (compared lowercased). */
const NON_CODE_VERIFY_FILENAMES = new Set([
  "license",
  "licence",
  "notice",
  "authors",
  "contributors",
  "changelog",
  "codeowners",
]);

/** How many changed paths the nudge lists before collapsing the rest. */
export const MAX_CHANGED_PATHS_IN_NUDGE = 8;

/** How many verification follow-ups one task may receive. Hermes' bound. */
export const MAX_VERIFY_NUDGES = 2;

/** Marker the runtime uses to recognise a nudge as a continuation (not a
 *  fresh task): it keeps the todo list and the auto-continue budget. */
export const VERIFY_NUDGE_PREFIX = "[System: verify-on-stop]";

/** Tools whose successful result means "code changed at `path`". */
const EDIT_TOOLS = new Set(["edit", "multi_edit", "write_file"]);

/** Heuristic for `bash_run`: only commands that look like a check count as
 *  verification evidence — `ls` exiting 0 proves nothing. */
const CHECK_COMMAND_RE =
  /\b(test|tests|lint|check|checks|build|typecheck|tsc|pytest|vitest|jest|mocha|cargo|clippy|vet|ruff|biome|eslint|prettier|rubocop|rspec|make|gradle|mvn)\b/i;

/** True when a changed path is documentation/prose with nothing to verify. */
export function isNonCodePath(raw: string): boolean {
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  const lower = base.toLowerCase();
  const dot = lower.lastIndexOf(".");
  // Dotfiles (".gitignore") and extension-less files have no suffix.
  const ext = dot > 0 ? lower.slice(dot) : "";
  if (ext) return NON_CODE_VERIFY_EXTENSIONS.has(ext);
  return NON_CODE_VERIFY_FILENAMES.has(lower);
}

/** Per-run verification state. Immutable updates keep it testable. */
export type VerifyLedger = {
  /** Code files edited this run, in first-touch order, deduplicated. */
  changedCodePaths: string[];
  /** Whether passing verification evidence landed after the last code edit. */
  verifiedAfterLastEdit: boolean;
};

export function newVerifyLedger(): VerifyLedger {
  return { changedCodePaths: [], verifiedAfterLastEdit: false };
}

/**
 * Fold one successful tool result into the ledger. Failed results (`{error}`),
 * reverted edits, and non-mutating tools leave it unchanged. Pure: returns a
 * new ledger only when something changed.
 */
export function recordToolResult(
  ledger: VerifyLedger,
  toolName: string,
  output: unknown,
): VerifyLedger {
  if (!output || typeof output !== "object") return ledger;
  const o = output as Record<string, unknown>;
  if ("error" in o) return ledger;
  if (o.reverted_by_user) return ledger;

  if (EDIT_TOOLS.has(toolName)) {
    const path = typeof o.path === "string" ? o.path : "";
    if (!path || isNonCodePath(path)) return ledger;
    const changedCodePaths = ledger.changedCodePaths.includes(path)
      ? ledger.changedCodePaths
      : [...ledger.changedCodePaths, path];
    // The auto-verify wrapper may have folded a fresh lint pass into this
    // very result — that counts as evidence for the edit it rides on.
    const v = o.verification as
      | { lint?: { ran?: boolean; passed?: boolean } }
      | undefined;
    const foldedPass = v?.lint?.ran === true && v?.lint?.passed === true;
    return { changedCodePaths, verifiedAfterLastEdit: foldedPass };
  }

  if (toolName === "run_checks") {
    if (o.exit_code === 0 && !o.timed_out) {
      return ledger.verifiedAfterLastEdit
        ? ledger
        : { ...ledger, verifiedAfterLastEdit: true };
    }
    return ledger;
  }

  if (toolName === "bash_run") {
    const cmd = typeof o.command === "string" ? o.command : "";
    if (o.exit_code === 0 && !o.timed_out && CHECK_COMMAND_RE.test(cmd)) {
      return ledger.verifiedAfterLastEdit
        ? ledger
        : { ...ledger, verifiedAfterLastEdit: true };
    }
    return ledger;
  }

  if (toolName === "bash_wait") {
    if (o.exited === true && o.exit_code === 0) {
      return ledger.verifiedAfterLastEdit
        ? ledger
        : { ...ledger, verifiedAfterLastEdit: true };
    }
    return ledger;
  }

  return ledger;
}

/**
 * The synthetic follow-up when edited code lacks fresh verification, or null
 * when the gate should stay silent (no code edits, already verified, or the
 * task used its nudge budget).
 */
export function buildVerifyNudge(
  changedCodePaths: readonly string[],
  attempts: number,
  maxAttempts: number = MAX_VERIFY_NUDGES,
): string | null {
  const paths = changedCodePaths.filter((p) => p && !isNonCodePath(p));
  if (paths.length === 0 || attempts >= maxAttempts) return null;
  const lines = paths
    .slice(0, MAX_CHANGED_PATHS_IN_NUDGE)
    .map((p) => `- \`${p}\``);
  if (paths.length > MAX_CHANGED_PATHS_IN_NUDGE) {
    lines.push(`- ... and ${paths.length - MAX_CHANGED_PATHS_IN_NUDGE} more`);
  }
  return (
    `${VERIFY_NUDGE_PREFIX} You edited code in this task, but there is no ` +
    `fresh passing verification evidence since the last edit.\n\n` +
    `Changed paths:\n${lines.join("\n")}\n\n` +
    `Run the relevant verification now (the \`run_checks\` tool, or the ` +
    `project's test/lint/build command), read any failure, repair the code, ` +
    `and summarize what passed. If verification is not possible, explain the ` +
    `concrete blocker instead of claiming the work is fully verified.`
  );
}

/** Whether a send is a verification nudge (same-task continuation semantics:
 *  keeps the todo list and the auto-continue budget). */
export function isVerifyNudgeParts(
  parts: readonly { type: string; text?: unknown }[],
): boolean {
  if (parts.length !== 1) return false;
  const first = parts[0];
  return (
    first?.type === "text" &&
    typeof first.text === "string" &&
    first.text.startsWith(VERIFY_NUDGE_PREFIX)
  );
}
