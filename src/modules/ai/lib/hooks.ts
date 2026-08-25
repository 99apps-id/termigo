// Pure rules for `.termigo/hooks.json`.
//
// A hook is a shell command template that runs when the agent reaches a
// lifecycle event. The command receives one argument: the path to a JSON
// payload file describing the event. The hook reads the file, acts on it,
// and exits. Nothing is piped into stdin and no environment variables are
// set, so a hook cannot be tricked into executing injected content.

export const HOOKS_REL_PATH = ".termigo/hooks.json";

/** Events the agent can fire. */
export type HookEvent = "PreToolUse" | "PostToolUse" | "Stop";

/** One configured hook command for a specific event. */
export type HookRule = {
  /** Shell command to run. Receives the payload JSON path as $1. */
  command: string;
  /**
   * Optional tool name filter. When present the hook only fires for calls to
   * this tool. Use `"*"` for all tools (PreToolUse/PostToolUse only).
   */
  tool?: string;
};

/** One event's hook list. */
export type HookEventRules = {
  PreToolUse?: HookRule[];
  PostToolUse?: HookRule[];
  Stop?: HookRule[];
};

/** Top-level hooks config. */
export type HooksConfig = HookEventRules;

/** Parse/validation result. */
export type HookParseResult =
  | { ok: true; config: HooksConfig }
  | { ok: false; reason: string };

/**
 * Validate a single hook rule.
 *
 * A command must be non-empty and single-line: CR/LF would let a second
 * statement smuggle past the approval UI, which shows the command as one
 * logical line.
 */
export function validateHookRule(rule: HookRule): HookParseResult {
  if (!rule.command.trim()) {
    return { ok: false, reason: "hook command must not be empty" };
  }
  if (/[\x00-\x1f]/.test(rule.command)) {
    return {
      ok: false,
      reason:
        "hook command must be single-line (no CR/LF or control characters)",
    };
  }
  if (rule.tool !== undefined && !rule.tool.trim()) {
    return { ok: false, reason: "hook tool filter must not be empty when set" };
  }
  return { ok: true, config: {} };
}

/**
 * Validate a parsed hooks config.
 *
 * Returns the config when every rule is well-formed, or the first failure
 * encountered.
 */
export function validateHooksConfig(config: HooksConfig): HookParseResult {
  for (const [event, rules] of Object.entries(config) as [
    HookEvent,
    HookRule[] | undefined,
  ][]) {
    if (!rules) continue;
    if (!["PreToolUse", "PostToolUse", "Stop"].includes(event)) {
      return {
        ok: false,
        reason: `unknown hook event "${event}". Allowed: PreToolUse, PostToolUse, Stop`,
      };
    }
    for (const rule of rules) {
      const r = validateHookRule(rule);
      if (!r.ok) return r;
    }
  }
  return { ok: true, config };
}

/**
 * Parse a hooks JSON file.
 *
 * Accepts the raw file content and returns a validated config or a reason
 * the file is malformed. A missing or empty file is not an error — it is the
 * normal case for workspaces that do not use hooks.
 */
export function parseHooksFile(content: string): HookParseResult {
  const trimmed = content.trim();
  if (!trimmed) return { ok: true, config: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: "hooks.json is not valid JSON" };
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return { ok: false, reason: "hooks.json must be a JSON object" };
  }

  const config = parsed as HooksConfig;
  return validateHooksConfig(config);
}

/**
 * Return the hook rules that should run for a given event and tool name.
 *
 * `toolName` is the name of the tool being called. Pass `null` for events
 * that have no tool context (Stop).
 */
export function matchingHooks(
  config: HooksConfig,
  event: HookEvent,
  toolName: string | null,
): HookRule[] {
  const rules = config[event];
  if (!rules || rules.length === 0) return [];

  return rules.filter((rule) => {
    if (rule.tool === undefined) return true;
    if (rule.tool === "*") return true;
    return rule.tool === toolName;
  });
}
