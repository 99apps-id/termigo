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
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "less",
  "wc",
  "stat",
  "file",
  "readlink",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "awk",
  "sed",
  "cut",
  "sort",
  "uniq",
  "tr",
  "echo",
  "printf",
  "date",
  "whoami",
  "id",
  "hostname",
  "uname",
  "uptime",
  "df",
  "du",
  "free",
  "ps",
  "top",
  "env",
  "printenv",
  "which",
  "type",
  "command",
  "dirname",
  "basename",
  "realpath",
  "test",
  "true",
  "false",
  "sleep",
  "curl",
  "wget",
  "dig",
  "nslookup",
  "host",
  "ping",
  "ss",
  "netstat",
  "lsof",
  "md5sum",
  "sha256sum",
  "diff",
  "tree",
  "jq",
  "yq",
  "column",
  "tee",
  // Reconnaissance, audit, and system inspection tools
  "find",
  "nmap",
  "whois",
  "traceroute",
  "tracepath",
  "ip",
  "ifconfig",
  "arp",
  "route",
  "lsblk",
  "blkid",
  "pgrep",
  "apt-cache",
  "dpkg-query",
  // HTTP inspection clients
  "http",
  "https",
  // Security scanning, code audit & vulnerability inspection tools
  "semgrep",
  "bandit",
  "trivy",
  "snyk",
  "osv-scanner",
  "checkov",
  "grype",
  "syft",
  "retire",
  "auditjs",
  "checksec",
  "gitleaks",
  "trufflehog",
  "lynis",
  "shellcheck",
  "hadolint",
  "yamllint",
  "markdownlint",
  "markdownlint-cli2",
  "actionlint",
  "dotenv-linter",
  "oxlint",
  "cargo-audit",
  "cargo-deny",
  "cargo-outdated",
  "govulncheck",
  "cve-bin-tool",
  "whispers",
  "detect-secrets",
]);

/** Subcommands that only report, for tools where the verb decides. */
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set([
    "status",
    "log",
    "diff",
    "show",
    "branch",
    "remote",
    "config",
    "blame",
    "describe",
    "rev-parse",
    "ls-files",
    "ls-remote",
    "shortlog",
    "tag",
    "worktree list",
    "--version",
    "-v",
    "version",
  ]),
  docker: new Set([
    "ps",
    "images",
    "logs",
    "inspect",
    "version",
    "info",
    "port",
    "top",
    "stats",
    "--version",
    "-v",
    // Compound subcommands for docker compose inspection
    "compose ps",
    "compose logs",
    "compose config",
    "compose top",
    "compose port",
    "compose version",
  ]),
  "docker-compose": new Set([
    "ps",
    "logs",
    "config",
    "top",
    "port",
    "version",
    "--version",
    "-v",
  ]),
  systemctl: new Set([
    "status",
    "is-active",
    "is-enabled",
    "list-units",
    "list-unit-files",
    "show",
    "cat",
  ]),
  journalctl: new Set(["--no-pager"]),
  npm: new Set([
    "ls",
    "list",
    "view",
    "outdated",
    "config",
    "audit",
    "explain",
    "why",
    "doctor",
    "--version",
    "-v",
  ]),
  pnpm: new Set([
    "ls",
    "list",
    "why",
    "outdated",
    "audit",
    "licenses",
    // `pnpm exec <tool>` resolves to the project's own local binary, so the
    // risk is the tool's, and these are the check-only ones (same set the
    // bare-tool entries above trust; test runners stay "change" there too).
    // A mutating flag anywhere on the line (`--write`, `--fix`) still
    // disqualifies it above.
    "exec biome",
    "exec tsc",
    "exec eslint",
    "exec prettier",
    "exec ruff",
    "exec mypy",
    "--version",
    "-v",
  ]),
  yarn: new Set([
    "list",
    "info",
    "why",
    "outdated",
    "versions",
    "audit",
    "config",
    "--version",
    "-v",
  ]),
  bun: new Set(["pm ls", "pm outdated", "pm bin", "pm why", "--version", "-v"]),
  deno: new Set(["info", "check", "lint", "doc", "--version", "-v"]),
  nvm: new Set(["ls", "list", "current", "--version", "-v", "which"]),
  corepack: new Set(["--version", "-v"]),
  node: new Set(["--version", "-v", "--help", "-h"]),
  python: new Set(["--version", "-V", "--help", "-h"]),
  python3: new Set(["--version", "-V", "--help", "-h"]),
  ruby: new Set(["--version", "-v", "--help", "-h"]),
  php: new Set(["--version", "-v", "--help", "-h"]),
  perl: new Set(["--version", "-v", "--help", "-h"]),
  tsc: new Set(["--noEmit", "--version", "-v", "--help", "-h"]),
  prettier: new Set(["--check", "-c", "--version", "-v", "--help", "-h"]),
  biome: new Set(["lint", "check", "ci", "--version", "-v", "--help", "-h"]),
  lint: new Set(["--version", "-v", "--help", "-h"]),
  // Introspection only. Actually RUNNING tests executes arbitrary project code
  // (and can write snapshots), so `vitest run` stays "change" — the same call
  // the file already makes for pytest, cargo test and go test.
  vitest: new Set(["list", "--version", "-v", "--help", "-h"]),
  jest: new Set([
    "--listTests",
    "--showConfig",
    "--version",
    "-v",
    "--help",
    "-h",
  ]),
  flutter: new Set([
    "doctor",
    "devices",
    "emulators",
    "analyze",
    "channel",
    "--version",
    "-v",
    "--help",
    "-h",
  ]),
  dart: new Set([
    "analyze",
    "info",
    "--version",
    "-v",
    "--help",
    "-h",
    "pub deps",
    "pub outdated",
  ]),
  adb: new Set([
    "devices",
    "version",
    "--version",
    "get-state",
    "get-serialno",
    "shell getprop",
  ]),
  emulator: new Set(["-list-avds", "-version", "--version"]),
  "react-native": new Set(["doctor", "--version", "-v"]),
  xcrun: new Set(["simctl list", "--version", "-v"]),
  xcodebuild: new Set(["-showsdks", "-version", "--version", "-list"]),
  cargo: new Set([
    "check",
    "tree",
    "metadata",
    "verify-project",
    "--version",
    "-v",
    "-V",
    "--help",
    "-h",
  ]),
  rustc: new Set(["--version", "-v", "-V", "--help", "-h", "--print"]),
  rustup: new Set([
    "show",
    "check",
    "--version",
    "-v",
    "toolchain list",
    "target list",
    "component list",
  ]),
  go: new Set(["version", "env", "list", "vet", "doc"]),
  uv: new Set(["version", "--version", "-v", "pip list", "pip tree", "tree"]),
  poetry: new Set(["show", "check", "version", "--version", "-v", "env info"]),
  dotnet: new Set([
    "--version",
    "--info",
    "-v",
    "--help",
    "-h",
    "list package",
  ]),
  gradle: new Set([
    "tasks",
    "dependencies",
    "properties",
    "-v",
    "--version",
    "-version",
  ]),
  gradlew: new Set([
    "tasks",
    "dependencies",
    "properties",
    "-v",
    "--version",
    "-version",
  ]),
  mvn: new Set(["dependency:tree", "-v", "--version", "-version", "--help"]),
  gh: new Set([
    "status",
    "version",
    "--version",
    "-v",
    "pr list",
    "pr view",
    "pr status",
    "issue list",
    "issue view",
    "issue status",
    "repo view",
    "run list",
    "run view",
    "release list",
    "release view",
  ]),
  kubectl: new Set(["get", "describe", "logs", "top", "version"]),
  apt: new Set(["list", "show", "search", "policy"]),
  "apt-get": new Set([]),
  brew: new Set([
    "list",
    "ls",
    "info",
    "search",
    "leaves",
    "deps",
    "outdated",
    "doctor",
    "config",
  ]),
  dpkg: new Set(["-l", "-s", "-L", "-S", "--list", "--status", "--contents"]),
  pacman: new Set(["-Q", "-Qi", "-Qs", "-Si", "-Ss"]),
  dnf: new Set(["list", "info", "search", "check-update"]),
  yum: new Set(["list", "info", "search", "check-update"]),
  pip: new Set(["list", "show", "check", "inspect"]),
  pip3: new Set(["list", "show", "check", "inspect"]),
};

/**
 * Flags that turn an otherwise read-only command into a destructive one.
 *
 * `find` is the reason this exists: it reads until `-delete` or `-exec`, at
 * which point it runs anything at all.
 */
const DESTRUCTIVE_FLAGS = [
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "--delete",
];

/** Flags that mutate files or formatting in linters/checkers. */
const MUTATING_FLAGS = new Set([
  "--write",
  "--apply",
  "--apply-unsafe",
  "--fix",
]);

/** Strip quoting so the first word can be read, without interpreting it. */
function firstWord(segment: string): string {
  const trimmed = segment.trim().replace(/^[({\s]+/, "");
  // Skip leading VAR=value assignments, which prefix a command rather than
  // being one.
  const withoutEnv = trimmed.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  const word = withoutEnv.split(/\s+/)[0] ?? "";
  const cleaned =
    word
      .replace(/^["']|["']$/g, "")
      .split(/[/\\]/)
      .pop() ?? "";
  return cleaned.replace(/\.(exe|cmd|bat)$/i, "");
}

function commandArgs(segment: string): string[] {
  const trimmed = segment.trim().replace(/^[({\s]+/, "");
  const withoutEnv = trimmed.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  const parts = withoutEnv.split(/\s+/);
  return parts.slice(1).map((p) => p.replace(/^["']|["']$/g, ""));
}

function secondWord(segment: string): string {
  const args = commandArgs(segment);
  return args[0] ?? "";
}

/**
 * Whether a command only inspects.
 *
 * Every segment must qualify: one `&&` away from `rm -rf` is not an inspection
 * command, however harmless the first half looks.
 */
export function isReadOnlyCommand(
  command: string,
  opts: { allowSudo?: boolean } = {},
): boolean {
  const text = command.trim();
  if (!text) return false;

  // A redirection writes a file regardless of which command produced the
  // output, so it disqualifies the whole line.
  if (/(^|[^0-9<>])>{1,2}[^>]/.test(text)) return false;
  // Command substitution can run anything, and reading inside it is not worth
  // the analysis it would take to be sure.
  if (/\$\(|`/.test(text)) return false;

  const segments = text.split(/&&|\|\||;|\|/);
  for (const rawSegment of segments) {
    let segment = rawSegment.trim();
    if (!segment) continue;
    let cmd = firstWord(segment);
    if (!cmd) return false;

    // Handle sudo / doas prefix when explicitly allowed (e.g. autonomous or remote inspection)
    if (cmd === "sudo" || cmd === "doas") {
      if (!opts.allowSudo) return false;
      const parts = segment.split(/\s+/);
      let idx = 1;
      while (idx < parts.length && parts[idx]?.startsWith("-")) {
        // Skip flags with arguments like -u user or -g group
        if (
          (parts[idx] === "-u" || parts[idx] === "-g" || parts[idx] === "-C") &&
          idx + 1 < parts.length
        ) {
          idx += 2;
        } else {
          idx += 1;
        }
      }
      if (idx >= parts.length) return false;
      segment = parts.slice(idx).join(" ");
      cmd = firstWord(segment);
    }

    // su is always refused as it opens interactive shell or executes arbitrary commands
    if (cmd === "su") return false;

    if (
      DESTRUCTIVE_FLAGS.some((f) =>
        new RegExp(`(^|\\s)${f}(\\s|$)`).test(segment),
      )
    ) {
      return false;
    }

    const subcommands = READ_ONLY_SUBCOMMANDS[cmd];
    if (subcommands) {
      const args = commandArgs(segment);
      if (args.some((a) => MUTATING_FLAGS.has(a))) {
        return false;
      }
      if (cmd === "tsc") {
        if (
          args.includes("--noEmit") ||
          (args[0] && subcommands.has(args[0]))
        ) {
          continue;
        }
        return false;
      }
      const arg0 = args[0] ?? "";
      const compound = args.length >= 2 ? `${args[0]} ${args[1]}` : "";
      if (subcommands.has(arg0) || (compound && subcommands.has(compound))) {
        continue;
      }
      return false;
    }
    if (!READ_ONLY.has(cmd)) return false;
  }
  return true;
}

/** The label used in the approval decision and in explaining it. */
export type CommandRisk = "inspect" | "change";

export function commandRisk(
  command: string,
  opts: { allowSudo?: boolean } = {},
): CommandRisk {
  return isReadOnlyCommand(command, opts) ? "inspect" : "change";
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
