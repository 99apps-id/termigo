// Telling an inspection command apart from one that changes something.
//
// Remote commands asked for approval every single time, in every mode. The
// reasoning was that a command on someone else's machine has no boundary the
// way a workspace path does. Using it proved the reasoning incomplete: setting
// up a server is dozens of commands, most of them `ls`, `cat`, `docker ps`,
// `systemctl status`, and approving each one turns review into reflex. A prompt
// that always appears is a prompt nobody reads, which is worse than a narrower
// gate that still means something.
//
// So the gate moves to what actually carries risk. This classifier is
// deliberately fail-closed: a command is inspection only if every part of it is
// recognised as such, and anything unfamiliar counts as changing something.
// Being wrong in the permissive direction is what this is guarding against.

/** Commands that only report. Anything absent from this list is not trusted. */
const READ_ONLY = new Set([
  "ls", "pwd", "cat", "head", "tail", "less", "wc", "stat", "file", "readlink",
  "grep", "egrep", "fgrep", "rg", "awk", "sed", "cut", "sort", "uniq", "tr",
  "echo", "printf", "date", "whoami", "id", "hostname", "uname", "uptime",
  "df", "du", "free", "ps", "top", "env", "printenv", "which", "type", "command",
  "dirname", "basename", "realpath", "test", "true", "false", "sleep",
  "curl", "wget", "dig", "nslookup", "host", "ping", "ss", "netstat", "lsof",
  "md5sum", "sha256sum", "diff", "tree", "jq", "yq", "column", "tee",
]);

/** Subcommands that only report, for tools where the verb decides. */
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set([
    "status", "log", "diff", "show", "branch", "remote", "config", "blame",
    "describe", "rev-parse", "ls-files", "ls-remote", "shortlog", "tag",
  ]),
  docker: new Set(["ps", "images", "logs", "inspect", "version", "info", "port", "top", "stats"]),
  systemctl: new Set(["status", "is-active", "is-enabled", "list-units", "list-unit-files", "show", "cat"]),
  journalctl: new Set(["--no-pager"]),
  npm: new Set(["ls", "list", "view", "outdated", "config"]),
  pnpm: new Set(["ls", "list", "why", "outdated"]),
  kubectl: new Set(["get", "describe", "logs", "top", "version"]),
  apt: new Set(["list", "show", "search", "policy"]),
  "apt-get": new Set([]),
};

/**
 * Flags that turn an otherwise read-only command into a destructive one.
 *
 * `find` is the reason this exists: it reads until `-delete` or `-exec`, at
 * which point it runs anything at all.
 */
const DESTRUCTIVE_FLAGS = ["-delete", "-exec", "-execdir", "-ok", "-okdir", "--delete"];

/** Strip quoting so the first word can be read, without interpreting it. */
function firstWord(segment: string): string {
  const trimmed = segment.trim().replace(/^[({\s]+/, "");
  // Skip leading VAR=value assignments, which prefix a command rather than
  // being one.
  const withoutEnv = trimmed.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  const word = withoutEnv.split(/\s+/)[0] ?? "";
  return word.replace(/^["']|["']$/g, "").split("/").pop() ?? "";
}

function secondWord(segment: string): string {
  const parts = segment.trim().split(/\s+/);
  return (parts[1] ?? "").replace(/^["']|["']$/g, "");
}

/**
 * Whether a command only inspects.
 *
 * Every segment must qualify: one `&&` away from `rm -rf` is not an inspection
 * command, however harmless the first half looks.
 */
export function isReadOnlyCommand(command: string): boolean {
  const text = command.trim();
  if (!text) return false;

  // A redirection writes a file regardless of which command produced the
  // output, so it disqualifies the whole line.
  if (/(^|[^0-9<>])>{1,2}[^>]/.test(text)) return false;
  // Command substitution can run anything, and reading inside it is not worth
  // the analysis it would take to be sure.
  if (/\$\(|`/.test(text)) return false;

  const segments = text.split(/&&|\|\||;|\|/);
  for (const segment of segments) {
    if (!segment.trim()) continue;
    const cmd = firstWord(segment);
    if (!cmd) return false;
    // sudo says the command needs privileges it would not otherwise have.
    if (cmd === "sudo" || cmd === "doas" || cmd === "su") return false;

    if (DESTRUCTIVE_FLAGS.some((f) => new RegExp(`(^|\\s)${f}(\\s|$)`).test(segment))) {
      return false;
    }

    const subcommands = READ_ONLY_SUBCOMMANDS[cmd];
    if (subcommands) {
      if (!subcommands.has(secondWord(segment))) return false;
      continue;
    }
    if (!READ_ONLY.has(cmd)) return false;
  }
  return true;
}

/** The label used in the approval decision and in explaining it. */
export type CommandRisk = "inspect" | "change";

export function commandRisk(command: string): CommandRisk {
  return isReadOnlyCommand(command) ? "inspect" : "change";
}

/**
 * Commands that remove files.
 *
 * Every other change an agent makes is recoverable - the file can be read
 * again, or git still holds it. A delete of something untracked leaves nothing
 * behind, and that asymmetry is worth a click even from someone who has
 * delegated everything else. Windows spellings are here because the shell on
 * this platform is usually PowerShell, where `Remove-Item` and its aliases do
 * the same job as `rm`.
 */
const DELETING = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "del",
  "erase",
  "rd",
  "remove-item",
  "ri",
]);

/** Subcommands that delete, for tools where the verb decides. */
const DELETING_SUBCOMMANDS: Record<string, Set<string>> = {
  // `git clean` removes untracked files - precisely the ones git cannot give
  // back afterwards.
  git: new Set(["clean"]),
};

/** Matches a deleting verb anywhere in a line, for the substitution case. */
const DELETING_ANYWHERE = new RegExp(
  `(^|[\\s;&|(\`$])(${[...DELETING].join("|")})(\\s|$)`,
  "i",
);

/**
 * Whether any part of the command removes files.
 *
 * Fail-closed like the rest of this module. Each segment is judged on its
 * first word, so `pnpm build && rm -rf dist` is caught rather than read as a
 * build. A command substitution can hide the verb from a first-word read, so
 * lines containing one are scanned whole - over-asking there is the safe
 * direction, and the result is a prompt rather than a refusal.
 */
export function deletesFiles(command: string): boolean {
  const text = command.trim();
  if (!text) return false;

  for (const segment of text.split(/&&|\|\||;|\|/)) {
    if (!segment.trim()) continue;
    const cmd = firstWord(segment).toLowerCase();
    if (DELETING.has(cmd)) return true;
    if (DELETING_SUBCOMMANDS[cmd]?.has(secondWord(segment).toLowerCase())) {
      return true;
    }
    // `find -delete` and `-exec` reach past the first word: one deletes
    // directly, the other runs whatever it is handed.
    if (
      DESTRUCTIVE_FLAGS.some((f) =>
        new RegExp(`(^|\\s)${f}(\\s|$)`).test(segment),
      )
    ) {
      return true;
    }
  }

  if (/\$\(|`/.test(text) && DELETING_ANYWHERE.test(text)) return true;
  return false;
}
