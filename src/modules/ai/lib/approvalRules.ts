// Project-scoped approval rules: per-tool trust the user sets once per project.
//
// The global approval MODE (ask / auto-approve edits / auto-approve all) is a
// blunt instrument. These rules refine it per project without loosening it
// everywhere: a rule can `allow` a specific safe call so it never prompts,
// `deny` a dangerous one so it is auto-refused, or force `ask` on something the
// mode would otherwise wave through.
//
// Rules live in `.termigo/approvals.json`:
//
//   { "version": 1, "rules": [
//     { "tools": ["bash_run"], "command": "git *",        "action": "allow" },
//     { "tools": ["bash_run"], "command": "rm -rf",       "action": "deny"  },
//     { "tools": ["edit","write_file","multi_edit"], "path": "src/**", "action": "allow" },
//     { "tools": ["edit","write_file","multi_edit"], "path": "**/*.env", "action": "deny" }
//   ] }
//
// First matching rule wins. A rule with no tools/path/command matches anything —
// deliberately, since it is the user's own config.

export type ApprovalAction = "allow" | "ask" | "deny";

export type ApprovalRule = {
  /** Tool names this rule applies to. Omitted or empty = any tool. */
  tools?: string[];
  /** Glob matched against the tool's `path` argument (edit/write/…). */
  path?: string;
  /** Pattern matched against the tool's `command` argument (bash). A pattern
   *  with no wildcard is treated as a substring; `*`/`?` make it a glob. */
  command?: string;
  action: ApprovalAction;
  /** Shown to the user when the rule denies a call. */
  reason?: string;
};

export type ApprovalRulesFile = { version?: number; rules: ApprovalRule[] };

export const APPROVAL_RULES_REL_PATH = ".termigo/approvals.json";

export type ApprovalRuleContext = {
  tool: string;
  command?: string | null;
  path?: string | null;
};

const VALID_ACTIONS: ReadonlySet<string> = new Set(["allow", "ask", "deny"]);

/** Compile a glob to an anchored, case-insensitive RegExp. `**` spans slashes,
 *  `*` stops at a slash, `?` is one non-slash char. Everything else literal. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "i");
}

function hasWildcard(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/** Command match: a bare pattern is a case-insensitive substring; a wildcard
 *  pattern is an anchored glob. Slashes in a command are normal characters. */
function commandMatches(pattern: string, command: string): boolean {
  if (!hasWildcard(pattern)) {
    return command.toLowerCase().includes(pattern.toLowerCase());
  }
  // For commands, `*` may span anything (there are no path segments to respect).
  const re = new RegExp(
    `^${pattern
      .split(/([*?])/)
      .map((seg) =>
        seg === "*"
          ? ".*"
          : seg === "?"
            ? "."
            : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
      )
      .join("")}$`,
    "i",
  );
  return re.test(command);
}

function pathMatches(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path.replace(/\\/g, "/"));
}

export function ruleMatches(
  rule: ApprovalRule,
  ctx: ApprovalRuleContext,
): boolean {
  if (rule.tools && rule.tools.length > 0 && !rule.tools.includes(ctx.tool)) {
    return false;
  }
  if (rule.command !== undefined) {
    if (!ctx.command) return false;
    if (!commandMatches(rule.command, ctx.command)) return false;
  }
  if (rule.path !== undefined) {
    if (!ctx.path) return false;
    if (!pathMatches(rule.path, ctx.path)) return false;
  }
  return true;
}

/** First matching rule wins. Returns null when nothing matches (fall back to
 *  the global mode). */
export function evaluateApprovalRules(
  rules: readonly ApprovalRule[],
  ctx: ApprovalRuleContext,
): { action: ApprovalAction; reason?: string } | null {
  for (const rule of rules) {
    if (ruleMatches(rule, ctx)) {
      return rule.reason
        ? { action: rule.action, reason: rule.reason }
        : { action: rule.action };
    }
  }
  return null;
}

/** Validate and normalise the parsed JSON into a rules array. Never throws:
 *  a malformed file yields no rules rather than breaking approvals. */
export function parseApprovalRules(raw: unknown): ApprovalRule[] {
  const rules = (raw as ApprovalRulesFile | null)?.rules;
  if (!Array.isArray(rules)) return [];
  const out: ApprovalRule[] = [];
  for (const r of rules) {
    if (!r || typeof r !== "object") continue;
    const rule = r as Record<string, unknown>;
    if (typeof rule.action !== "string" || !VALID_ACTIONS.has(rule.action)) {
      continue;
    }
    const spec: ApprovalRule = { action: rule.action as ApprovalAction };
    if (Array.isArray(rule.tools)) {
      spec.tools = rule.tools.filter((t): t is string => typeof t === "string");
    }
    if (typeof rule.path === "string") spec.path = rule.path;
    if (typeof rule.command === "string") spec.command = rule.command;
    if (typeof rule.reason === "string") spec.reason = rule.reason;
    out.push(spec);
  }
  return out;
}
