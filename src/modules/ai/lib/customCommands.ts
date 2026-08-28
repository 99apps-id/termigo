// User-defined slash commands: reusable prompt templates the user drops in a
// file and invokes from the composer with `/name`.
//
// Where skills are procedures the AGENT reaches for by matching a description,
// and snippets are text the USER expands with `#handle`, a custom command is a
// whole prompt the user fires with `/name [args]` — the same surface as the
// built-in `/init`, `/plan`, ... but authored per project.
//
// Layout mirrors the skills convention, one Markdown file per command:
//
//   .termigo/commands/review-pr.md
//
// Optional frontmatter carries a one-line `description:` for the picker; the
// body is the prompt. `$ARGUMENTS` in the body is replaced with whatever the
// user typed after the command name (Claude Code's convention); when the body
// has no placeholder, the arguments are appended.

import { native } from "./native";

export const COMMANDS_REL_DIR = ".termigo/commands";

/** A body larger than this is not a prompt template; it is a document. */
export const MAX_COMMAND_BYTES = 16 * 1024;

/** Placeholder replaced with the user's arguments. */
export const ARGS_TOKEN = "$ARGUMENTS";

export type CustomCommand = {
  /** Invocation name, from the file's base name. `/review-pr` → "review-pr". */
  name: string;
  /** One-line summary for the picker (from frontmatter, may be empty). */
  description: string;
  /** The prompt template. */
  body: string;
};

/**
 * Same slug rule as skills: the name reaches the filesystem as a path segment,
 * so this is the boundary that stops `../../etc/passwd` from being a command.
 */
export function isValidCommandName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}

export function commandPath(workspaceRoot: string, name: string): string {
  return `${workspaceRoot.replace(/[\\/]$/, "")}/${COMMANDS_REL_DIR}/${name}.md`;
}

/** Split a command file into its frontmatter `description:` and prompt body. */
export function parseCommand(name: string, content: string): CustomCommand {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) {
    return { name, description: "", body: content.trim() };
  }
  const front = match[1];
  const body = match[2].trim();
  const m = /^description:\s*(.*)$/im.exec(front);
  const description = m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  return { name, description, body };
}

/** Substitute the user's arguments into a command body. */
export function expandCommand(cmd: CustomCommand, args: string): string {
  const trimmed = args.trim();
  if (cmd.body.includes(ARGS_TOKEN)) {
    return cmd.body.split(ARGS_TOKEN).join(trimmed);
  }
  return trimmed ? `${cmd.body}\n\n${trimmed}` : cmd.body;
}

/**
 * Scan `.termigo/commands` for command files. Never throws: no directory is the
 * normal case, and one unreadable file must not lose the others.
 */
export async function listCustomCommands(
  workspaceRoot: string | null,
): Promise<CustomCommand[]> {
  if (!workspaceRoot) return [];
  const root = `${workspaceRoot.replace(/[\\/]$/, "")}/${COMMANDS_REL_DIR}`;
  let entries: Awaited<ReturnType<typeof native.readDir>>;
  try {
    entries = await native.readDir(root);
  } catch {
    return [];
  }

  const out: CustomCommand[] = [];
  for (const entry of entries) {
    if (entry.kind === "dir") continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    const name = entry.name.slice(0, -3);
    if (!isValidCommandName(name)) continue;
    try {
      const read = await native.readFile(commandPath(workspaceRoot, name));
      if (read.kind !== "text") continue;
      if (read.size > MAX_COMMAND_BYTES) continue;
      const cmd = parseCommand(name, read.content);
      if (!cmd.body) continue;
      out.push(cmd);
    } catch {
      // Missing or unreadable: skip this one, keep the rest.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
