// Repair tool-call arguments that a model emitted as near-JSON.
//
// Some providers - StepFun via the OpenAI-compatible endpoint in particular -
// emit tool-call `arguments` as a JSON string that is *almost* valid: a literal
// newline inside a string value, or an unescaped double quote in prose
// (`audit "route.ts"`), or a trailing comma. The AI SDK's strict `JSON.parse`
// then fails with "Invalid input for tool ... JSON parsing failed", and the
// whole batch dies. This module is the `experimental_repairToolCall` hook: it
// makes a best-effort repair so a recoverable input runs instead of failing.

import { parsePartialJson } from "ai";

/** Strip a markdown code fence (` ```json ... ``` `) around the args. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fence ? fence[1] : trimmed;
}

/**
 * Repair common JSON malformations from model output. The hardest is an
 * unescaped double quote inside a string value; we decide per-quote whether it
 * closes the string (followed by `,` `}` `]` `:` or end) or is literal
 * (followed by ordinary text) and escape it accordingly.
 */
export function repairJsonText(text: string): string {
  text = stripCodeFence(text);
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        // A valid JSON escape passes through untouched. Anything else - most
        // often a Windows path emitted raw (`C:\project`, `\Users`, `\d` from a
        // regex) - is not JSON at all, and strict parse rejects it. Double the
        // backslash so the literal path the model meant survives parsing.
        const next = text[i + 1];
        if (
          next === '"' ||
          next === "\\" ||
          next === "/" ||
          next === "b" ||
          next === "f" ||
          next === "n" ||
          next === "r" ||
          next === "t" ||
          next === "u"
        ) {
          out += ch;
          escaped = true;
          continue;
        }
        out += "\\\\";
        continue;
      }
      if (ch === '"') {
        // Look ahead past any whitespace: a closing quote is followed by a
        // structural char (`,`, `}`, `]`, `:`) or the end of the text. If it is
        // followed by ordinary text, it is an unescaped quote in prose and must
        // be escaped.
        let j = i + 1;
        while (j < text.length && /[ \t]/.test(text[j])) j++;
        const next = text[j];
        const isStructural =
          next === undefined ||
          next === "," ||
          next === "}" ||
          next === "]" ||
          next === ":";
        if (isStructural) {
          inString = false;
          out += ch;
        } else {
          out += "\\" + '"';
        }
        continue;
      }
      if (ch === "\n" || ch === "\r") {
        out += "\\n";
        continue;
      }
      out += ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    out += ch;
  }
  // Remove a trailing comma before a closing brace/bracket.
  return out.replace(/,\s*([}\]])/g, "$1");
}

/**
 * Edit distance between two strings (Levenshtein). Used to match a tool name
 * the model typed slightly wrong to the closest one we actually expose.
 */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Find the available tool name closest to `requested`. Accepts the match only
 * when the edit distance is small relative to the name length, so we fix a
 * near-miss typo (e.g. `ext_...-kool_...` → `ext_...-kit_...`) without ever
 * rewriting one real tool name into a different real tool.
 */
function bestToolMatch(
  requested: string,
  available: readonly string[],
): string | null {
  let best = "";
  let bestDistance = Infinity;
  for (const name of available) {
    const d = editDistance(requested, name);
    if (d < bestDistance) {
      bestDistance = d;
      best = name;
    }
  }
  if (best === "") return null;
  const longer = Math.max(requested.length, best.length);
  // Allow a couple of edits, growing with the name length, but never enough to
  // turn one genuinely different, similarly-named tool into another.
  const threshold = Math.max(2, Math.round(longer * 0.12));
  return bestDistance <= threshold ? best : null;
}

/**
 * Canonical tool aliasing: map common hallucinated or cross-ecosystem tool names
 * (Claude Code, Gemini/Antigravity, OpenAI Codex, SWE-agent) onto Termigo's real tools,
 * and adapt parameter keys to match the canonical schemas.
 */
export const KNOWN_TOOL_ALIASES: Record<
  string,
  {
    canonical: string;
    adaptArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
  }
> = {
  // Read file aliases
  view_file: {
    canonical: "read_file",
    adaptArgs: (a) => ({
      path: a.path ?? a.AbsolutePath ?? a.filepath ?? a.file ?? a.filename,
    }),
  },
  view: {
    canonical: "read_file",
    adaptArgs: (a) => ({ path: a.path ?? a.filepath ?? a.file }),
  },
  cat: {
    canonical: "read_file",
    adaptArgs: (a) => ({ path: a.path ?? a.filepath ?? a.file }),
  },
  read: {
    canonical: "read_file",
    adaptArgs: (a) => ({ path: a.path ?? a.filepath ?? a.file }),
  },

  // Write file aliases
  write_to_file: {
    canonical: "write_file",
    adaptArgs: (a) => ({
      path: a.path ?? a.TargetFile ?? a.filepath ?? a.file,
      content: a.content ?? a.CodeContent ?? a.text ?? "",
    }),
  },
  create_file: {
    canonical: "write_file",
    adaptArgs: (a) => ({
      path: a.path ?? a.TargetFile ?? a.filepath ?? a.file,
      content: a.content ?? a.CodeContent ?? a.text ?? "",
    }),
  },

  // Edit file aliases
  replace_file_content: {
    canonical: "edit",
    adaptArgs: (a) => ({
      path: a.path ?? a.TargetFile ?? a.filepath ?? a.file,
      old_string: a.old_string ?? a.TargetContent ?? a.oldStr ?? "",
      new_string: a.new_string ?? a.ReplacementContent ?? a.newStr ?? "",
    }),
  },
  str_replace: {
    canonical: "edit",
    adaptArgs: (a) => ({
      path: a.path ?? a.filepath ?? a.file,
      old_string: a.old_string ?? a.old_str ?? "",
      new_string: a.new_string ?? a.new_str ?? "",
    }),
  },
  patch: {
    canonical: "edit",
    adaptArgs: (a) => ({
      path: a.path ?? a.filepath ?? a.file,
      old_string: a.old_string ?? a.before ?? "",
      new_string: a.new_string ?? a.after ?? "",
    }),
  },

  // Shell command aliases
  run_command: {
    canonical: "bash_run",
    adaptArgs: (a) => ({
      command: a.command ?? a.CommandLine ?? a.cmd ?? "",
      cwd: a.cwd ?? a.Cwd,
    }),
  },
  execute_command: {
    canonical: "bash_run",
    adaptArgs: (a) => ({
      command: a.command ?? a.cmd ?? "",
      cwd: a.cwd,
    }),
  },
  exec: {
    canonical: "bash_run",
    adaptArgs: (a) => ({
      command: a.command ?? a.cmd ?? "",
      cwd: a.cwd,
    }),
  },
  terminal: {
    canonical: "bash_run",
    adaptArgs: (a) => ({
      command: a.command ?? a.cmd ?? "",
      cwd: a.cwd,
    }),
  },
  bash: {
    canonical: "bash_run",
    adaptArgs: (a) => ({
      command: a.command ?? a.cmd ?? "",
      cwd: a.cwd,
    }),
  },

  // Directory listing aliases
  list_dir: {
    canonical: "list_directory",
    adaptArgs: (a) => ({ path: a.path ?? a.DirectoryPath ?? a.dir ?? "." }),
  },
  ls: {
    canonical: "list_directory",
    adaptArgs: (a) => ({ path: a.path ?? a.dir ?? "." }),
  },
  dir: {
    canonical: "list_directory",
    adaptArgs: (a) => ({ path: a.path ?? a.dir ?? "." }),
  },

  // Search / Grep aliases
  grep_search: {
    canonical: "grep",
    adaptArgs: (a) => ({
      pattern: a.pattern ?? a.Query ?? a.query ?? "",
      path: a.path ?? a.SearchPath ?? a.root,
    }),
  },
  find_in_files: {
    canonical: "grep",
    adaptArgs: (a) => ({
      pattern: a.pattern ?? a.query ?? "",
      path: a.path ?? a.root,
    }),
  },
  search_code: {
    canonical: "grep",
    adaptArgs: (a) => ({
      pattern: a.pattern ?? a.query ?? "",
      path: a.path ?? a.root,
    }),
  },

  // Glob / File search aliases
  find_by_name: {
    canonical: "glob",
    adaptArgs: (a) => ({
      pattern: a.pattern ?? a.Pattern ?? "*",
      path: a.path ?? a.SearchDirectory ?? a.root,
    }),
  },
  find_files: {
    canonical: "glob",
    adaptArgs: (a) => ({
      pattern: a.pattern ?? "*",
      path: a.path ?? a.root,
    }),
  },

  // Fetch / HTTP aliases
  read_url_content: {
    canonical: "fetch",
    adaptArgs: (a) => ({ url: a.url ?? a.Url ?? "" }),
  },
  curl: {
    canonical: "fetch",
    adaptArgs: (a) => ({ url: a.url ?? "" }),
  },
  http_get: {
    canonical: "fetch",
    adaptArgs: (a) => ({ url: a.url ?? "" }),
  },

  // Subagent aliases
  invoke_subagent: {
    canonical: "run_subagent",
    adaptArgs: (a) => {
      if (Array.isArray(a.Subagents) && a.Subagents.length > 0) {
        const first = a.Subagents[0] as Record<string, unknown>;
        return {
          type: first.TypeName ?? first.type ?? "general",
          prompt: first.Prompt ?? first.prompt ?? "",
          description: first.Role ?? first.description,
        };
      }
      return {
        type: a.type ?? a.TypeName ?? "general",
        prompt: a.prompt ?? a.Prompt ?? "",
        description: a.description ?? a.Role,
      };
    },
  },
  invoke_subagents: {
    canonical: "run_subagents",
    adaptArgs: (a) => {
      const list = Array.isArray(a.Subagents)
        ? (a.Subagents as Array<Record<string, unknown>>)
        : Array.isArray(a.tasks)
          ? (a.tasks as Array<Record<string, unknown>>)
          : [];
      return {
        tasks: list.map((item) => ({
          type: item.TypeName ?? item.type ?? "general",
          prompt: item.Prompt ?? item.prompt ?? "",
          description: item.Role ?? item.description,
          depends_on: item.depends_on,
        })),
      };
    },
  },
};

/**
 * The `experimental_repairToolCall` hook. Returns a repaired tool call whose
 * name is a real tool and whose `input` is clean JSON, or `null` to let the
 * original error surface.
 */
export async function repairToolCall({
  toolCall,
  tools,
}: {
  toolCall: {
    toolCallId: string;
    toolName: string;
    input?: string;
    args?: string;
  };
  tools?: Record<string, unknown>;
}): Promise<{
  toolCallId: string;
  toolName: string;
  input: string;
} | null> {
  // A tool the model named that we do not expose (a `NoSuchToolError`). The
  // model often mis-types a long, hyphenated extension tool name - fix it to
  // the nearest real tool instead of killing the whole run.
  const toolKeys = tools ? Object.keys(tools) : [];
  if (toolKeys.length > 0 && !toolKeys.includes(toolCall.toolName)) {
    // 1. Check known cross-ecosystem tool aliases
    const lowerName = toolCall.toolName.toLowerCase();
    const alias = KNOWN_TOOL_ALIASES[lowerName];
    if (alias && toolKeys.includes(alias.canonical)) {
      const raw = stripCodeFence(String(toolCall.input ?? toolCall.args ?? ""));
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        try {
          parsed = JSON.parse(repairJsonText(raw));
        } catch {
          parsed = {};
        }
      }
      const adapted = alias.adaptArgs ? alias.adaptArgs(parsed) : parsed;
      return {
        toolCallId: toolCall.toolCallId,
        toolName: alias.canonical,
        input: JSON.stringify(adapted),
      };
    }

    // 2. Check near-miss edit distance typos
    const match = bestToolMatch(toolCall.toolName, toolKeys);
    if (match) {
      return {
        toolCallId: toolCall.toolCallId,
        toolName: match,
        input: String(toolCall.input ?? toolCall.args ?? "{}"),
      };
    }

    // 3. Fallback to unknown_tool_fallback if registered, to avoid fatal NoSuchToolError
    if (toolKeys.includes("unknown_tool_fallback")) {
      const raw = stripCodeFence(String(toolCall.input ?? toolCall.args ?? ""));
      return {
        toolCallId: toolCall.toolCallId,
        toolName: "unknown_tool_fallback",
        input: JSON.stringify({
          requested_tool: toolCall.toolName,
          provided_input: raw,
        }),
      };
    }

    return null;
  }

  const raw = stripCodeFence(String(toolCall.input ?? toolCall.args ?? ""));
  if (raw.length === 0) return null;

  // Already valid - let the SDK re-parse as usual.
  try {
    JSON.parse(raw);
    return null;
  } catch {
    // fall through to repair
  }

  const repaired = repairJsonText(raw);
  // Try strict, then the SDK's lenient partial parser as a final fallback. We
  // always return `input` as a JSON *string* because the SDK re-parses it.
  try {
    JSON.parse(repaired);
    return { ...toolCall, input: repaired };
  } catch {
    try {
      const { value } = await parsePartialJson(repaired);
      if (value !== undefined) {
        return { ...toolCall, input: JSON.stringify(value) };
      }
    } catch {
      // ignore
    }
  }
  return null;
}
