// Finding a skill anywhere on the machine, without paying for it up front.
//
// This machine has 622 SKILL.md files: 620 in Codex's plugin cache, two in
// OpenClaw's. Putting even their names and descriptions in the system prompt
// would cost tens of kilobytes on every request - several times the entire
// memory budget - for a shelf the current task almost never needs.
//
// So the library is searched on demand instead. The agent asks for what it
// wants, gets a handful of candidates back, and reads one. Same shape as the
// workspace's own skills, one level further out: index nothing, fetch on
// request.
//
// Matching runs on directory names before any file is opened. Skill
// directories are named descriptively by convention - `airtable-cli`,
// `browser-automation`, `plugin-creator` - so a name filter answers most
// queries, and only the survivors are read to get their descriptions. Reading
// 620 files to answer one question would take seconds and most of them would
// score zero.

export type SkillSource = "workspace" | "user" | "codex" | "openclaw" | "claude";

export type SkillCandidate = {
  /** Directory name, which is also the skill's name. */
  name: string;
  /** Absolute path to the SKILL.md. */
  path: string;
  source: SkillSource;
};

export type SkillMatch = SkillCandidate & {
  description: string;
  score: number;
};

/** How many candidates are opened to read descriptions. */
export const MAX_SKILL_READS = 24;

/** How many matches come back. */
export const MAX_SKILL_MATCHES = 8;

/** Skill libraries other agents keep, relative to the home directory. */
export const FOREIGN_ROOTS: { rel: string; source: SkillSource }[] = [
  { rel: ".termigo/skills", source: "user" },
  { rel: ".claude/skills", source: "claude" },
  { rel: ".openclaw/plugin-skills", source: "openclaw" },
  { rel: ".codex", source: "codex" },
  { rel: ".agents/skills", source: "claude" },
];

/** Split a query into lowercase words worth matching on. */
export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/**
 * The skill's own name from the path to its SKILL.md.
 *
 * Always the containing directory: every layout in the wild puts SKILL.md
 * inside a directory named for the skill.
 */
export function skillNameFromPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

/**
 * Score a candidate against the query terms.
 *
 * Zero means "do not open this file". An exact name match outranks a partial
 * one so that asking for `airtable-cli` does not return `airtable-filters`
 * first, and matching more of the query outranks matching one word of it.
 */
export function scoreName(name: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const haystack = name.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack === term) score += 10;
    else if (haystack.includes(term)) score += 3;
  }
  return score;
}

/** Same scoring against a description, worth less than the name. */
export function scoreDescription(
  description: string,
  terms: readonly string[],
): number {
  const haystack = description.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

/**
 * Narrow candidates to the ones worth opening.
 *
 * When nothing matches by name the list is not empty but capped: a query whose
 * words appear only in descriptions should still find something, and reading a
 * bounded sample is the only way to know. Reading everything is not.
 */
export function shortlist(
  candidates: readonly SkillCandidate[],
  terms: readonly string[],
  limit = MAX_SKILL_READS,
): SkillCandidate[] {
  const scored = candidates
    .map((c) => ({ c, s: scoreName(c.name, terms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  if (scored.length > 0) return scored.slice(0, limit).map((x) => x.c);

  // Prefer the closest libraries when falling back to a blind sample: a
  // workspace skill is far more likely to be the one meant than the 400th
  // entry of a plugin cache.
  const order: SkillSource[] = ["workspace", "user", "claude", "openclaw", "codex"];
  return [...candidates]
    .sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source))
    .slice(0, limit);
}

/** Rank the shortlist once descriptions are known. */
export function rankMatches(
  matches: readonly SkillMatch[],
  limit = MAX_SKILL_MATCHES,
): SkillMatch[] {
  return [...matches]
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}
