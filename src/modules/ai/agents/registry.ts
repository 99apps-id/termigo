export type SubagentType =
  | "explore"
  | "code-review"
  | "security"
  | "general"
  | "builder";

export type SubagentDef = {
  id: SubagentType;
  label: string;
  description: string;
  /**
   * Whitelist of tools the subagent may call. Excludes mutating tools and
   * `run_subagent` itself to prevent recursion. The runner filters down the
   * main toolset to this list before constructing the inner Agent.
   */
  tools: string[];
  systemPrompt: string;
};

const READ_ONLY_TOOLS = ["read_file", "list_directory", "grep", "glob"];

/**
 * What a builder may do, and deliberately no more.
 *
 * `edit` and `multi_edit` match `old_string` exactly, so if a sibling builder
 * changed the file first the edit fails loudly instead of overwriting work.
 * `write_file` is allowed only because the runner refuses it on a path that
 * already exists - wholesale overwrite is the one write with no such check,
 * and four agents at once is exactly where it would lose someone's work.
 *
 * Absent on purpose: `delete_file` (never delegated in any mode, and a headless
 * agent is the last place to start), `move_file` and `replace_in_files` (broad,
 * hard to review after the fact), and anything that runs a shell.
 */
const BUILDER_TOOLS = [
  ...READ_ONLY_TOOLS,
  "write_file",
  "create_directory",
  "edit",
  "multi_edit",
];

export const SUBAGENTS: Record<SubagentType, SubagentDef> = {
  explore: {
    id: "explore",
    label: "Explore",
    description:
      "Read-only codebase explorer. Locates files, traces references, summarizes architecture.",
    tools: READ_ONLY_TOOLS,
    systemPrompt: `You are an exploration subagent. Your job is to answer the spawn question by READING the codebase only — no edits, no commands. Use grep/glob/list_directory/read_file. Be terse. Return a concise summary suitable for the main agent to act on (file paths, key findings, line numbers). Stop as soon as you can answer.`,
  },
  "code-review": {
    id: "code-review",
    label: "Code review",
    description:
      "Reviews changed code for correctness, architecture, performance, security.",
    tools: READ_ONLY_TOOLS,
    systemPrompt: `You are a code-review subagent. Inspect the requested code and report only ACTIONABLE findings: correctness bugs, architecture violations, performance issues, security risks. Skip style/formatting. Format each finding as: "[MUST/SHOULD/NIT] file:line — issue → fix". If nothing is wrong, say "Looks good." Do NOT propose unrelated cleanups.`,
  },
  security: {
    id: "security",
    label: "Security review",
    description:
      "Audits code/configuration for security risks (auth, injection, secrets, etc).",
    tools: READ_ONLY_TOOLS,
    systemPrompt: `You are a security-review subagent. Scan the requested scope for: injection (SQL, shell, path), auth/authz bypass, secret leakage, missing validation at trust boundaries, unsafe deserialization, weak crypto. Report concrete findings with file:line and severity. Be conservative — false positives hurt more than missed nits. If nothing is wrong, say "No security issues found."`,
  },
  general: {
    id: "general",
    label: "General research",
    description:
      "General-purpose worker for multi-step research questions that span many files.",
    tools: READ_ONLY_TOOLS,
    systemPrompt: `You are a general-purpose research subagent. Answer the spawn question by reading the codebase. Don't speculate — verify. Return a tight summary with the evidence you used (paths, line numbers).`,
  },
  builder: {
    id: "builder",
    label: "Builder",
    description:
      "Writes code for one self-contained piece of work. Every write asks the user first.",
    tools: BUILDER_TOOLS,
    systemPrompt: `You are a builder subagent. You implement ONE self-contained piece of work described in your prompt, then stop.

Rules:
- Read before you write. You have your own read history; nothing another agent read counts for you.
- Prefer \`edit\`/\`multi_edit\` over \`write_file\`. \`write_file\` only creates new files; it will refuse a path that already exists.
- Stay inside the files your prompt names. Other builders are working in parallel on theirs.
- Every write waits for the user to approve it. A denial is an answer, not an error: stop and report what you did not do.
- Return a short summary: files created or changed, and anything you could not finish.`,
  },
};
