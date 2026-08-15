// Checking whether a skill can actually be followed here.
//
// Skills travel between agent tools because the file format is shared, but the
// format is the easy half. A skill is instructions referring to capabilities,
// and it is only portable if those capabilities exist. OpenClaw's
// browser-automation skill parses perfectly in Termigo and is useless in it:
// every step calls a `browser` tool that does not exist, so the agent would
// follow a procedure into a wall.
//
// Two signals, in order of trust:
//
//   declared  - a `tools:` line in the frontmatter. Exact, when present.
//   referenced - snake_case identifiers in backticks. A guess, but a good one.
//
// The heuristic deliberately ignores single words. `browser`, `npm` and
// `docker` in backticks are as likely to be a program as a tool, and a checker
// that cries wolf gets ignored - which costs more than the misses. Multi-word
// snake_case (`browser_click`, `run_in_terminal`) is almost always a tool name.

/** MCP tools are named `mcp__<server>__<tool>` and depend on config, not code. */
const MCP_PREFIX = "mcp__";

/** Parse a frontmatter `tools:` list, comma- or space-separated. */
export function declaredTools(content: string): string[] {
  const m = /^tools:\s*(.*)$/im.exec(content);
  if (!m) return [];
  return m[1]
    .replace(/^\[|\]$/g, "")
    .split(/[,\s]+/)
    .map((t) => t.trim().replace(/^["'`]|["'`]$/g, ""))
    .filter((t) => /^[a-z][a-z0-9_]*$/.test(t));
}

/**
 * Tool-looking identifiers mentioned in the text.
 *
 * Requires an underscore: a single backticked word is ambiguous between a tool
 * and a shell program, and guessing wrong in that direction produces warnings
 * about `npm` that teach the reader to stop reading warnings.
 */
export function referencedTools(content: string): string[] {
  const out = new Set<string>();
  // `_+` rather than `_`: MCP tools are named `mcp__server__tool`, and a
  // single-underscore pattern silently fails to match the whole token.
  for (const m of content.matchAll(/`([a-z][a-z0-9]*(?:_+[a-z0-9]+)+)`/g)) {
    out.add(m[1]);
  }
  return [...out].sort();
}

/**
 * Agents whose skills are common enough to be worth recognising by name.
 *
 * The snake_case heuristic misses whole naming styles: OpenClaw's browser
 * skill calls its tool `browser` - one word, deliberately ignored - and passes
 * camelCase parameters, so nothing in it looks like a tool name. But a skill
 * written for another agent nearly always says which one, in its description
 * or its commands. That turns out to be the stronger signal.
 */
const FOREIGN_AGENTS = [
  "openclaw",
  "claude code",
  "claude-code",
  "cursor",
  "windsurf",
  "aider",
  "tedi",
  "terax",
];

/** Agent names the skill mentions, which suggest it was written elsewhere. */
export function foreignAgentMentions(content: string): string[] {
  const haystack = content.toLowerCase();
  const found = FOREIGN_AGENTS.filter((a) => haystack.includes(a));
  // "claude-code" and "claude code" are the same product; report it once.
  return [...new Set(found.map((a) => a.replace("-", " ")))].sort();
}

export type SkillDependencies = {
  /** Named in `tools:` and not available here. */
  missingDeclared: string[];
  /** Mentioned in the body and not available here. A guess. */
  missingReferenced: string[];
  /** MCP tools the skill needs; present only if that server is configured. */
  mcpRequired: string[];
  /** Other agents the skill names, suggesting it was written for one of them. */
  foreignAgents: string[];
};

/**
 * What a skill needs that this install may not have.
 *
 * MCP tools are reported separately rather than as missing: whether they exist
 * is a question about the user's `mcp.json`, not about Termigo, and calling a
 * configured server "missing" would be wrong for the user who set it up.
 */
export function checkSkillDependencies(
  content: string,
  availableTools: readonly string[],
): SkillDependencies {
  const available = new Set(availableTools);
  const mcpRequired = new Set<string>();

  const sort = (s: Set<string>) => [...s].sort();
  const missing = (names: string[]): string[] => {
    const out = new Set<string>();
    for (const name of names) {
      if (name.startsWith(MCP_PREFIX)) {
        mcpRequired.add(name);
        continue;
      }
      if (!available.has(name)) out.add(name);
    }
    return sort(out);
  };

  const missingDeclared = missing(declaredTools(content));
  const declaredSet = new Set(declaredTools(content));
  // Anything already reported as declared is not repeated as a guess.
  const missingReferenced = missing(
    referencedTools(content).filter((t) => !declaredSet.has(t)),
  );

  return {
    missingDeclared,
    missingReferenced,
    mcpRequired: sort(mcpRequired),
    foreignAgents: foreignAgentMentions(content),
  };
}

/**
 * A warning for the model, or null when the skill fits.
 *
 * Phrased so the model treats the skill as a guide rather than abandoning it:
 * most imported skills are mostly applicable, and the steps that do not
 * translate usually have an obvious local equivalent.
 */
export function dependencyWarning(deps: SkillDependencies): string | null {
  const parts: string[] = [];
  if (deps.missingDeclared.length > 0) {
    parts.push(
      `This skill declares tools that do not exist here: ${deps.missingDeclared.join(", ")}.`,
    );
  }
  if (deps.missingReferenced.length > 0) {
    parts.push(
      `It also mentions ${deps.missingReferenced.join(", ")}, which look like tools from another agent.`,
    );
  }
  if (deps.foreignAgents.length > 0) {
    parts.push(
      `This skill names ${deps.foreignAgents.join(", ")}, so it was probably written for a different agent and may describe tools and flags Termigo does not have.`,
    );
  }
  if (deps.mcpRequired.length > 0) {
    parts.push(
      `It uses MCP tools (${deps.mcpRequired.join(", ")}), which work only if those servers are configured in mcp.json.`,
    );
  }
  if (parts.length === 0) return null;
  parts.push(
    "Treat the steps as guidance and use Termigo's own tools for them; do not call a tool that is not in your tool list.",
  );
  return parts.join(" ");
}
