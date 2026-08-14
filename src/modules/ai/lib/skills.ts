// Skills: procedures the agent writes for itself and reuses later.
//
// Memory records facts - "tests run with pnpm test". A skill records a
// procedure - how to deploy this project, how to debug its flaky suite, what
// the release checklist is. The difference compounds: a fact stops a session
// starting from zero, while a skill makes the agent able to do something it
// previously had to work out.
//
// Layout follows the convention other agent tools have settled on, one
// directory per skill holding a SKILL.md with frontmatter:
//
//   .termigo/skills/deploy-to-vps/SKILL.md
//
// Only the name and description are put in the system prompt. Bodies are
// loaded on demand, because a handful of skills at a few kilobytes each would
// crowd out the conversation they exist to help - the same reason memory is
// bounded.

import { native } from "./native";

export const SKILLS_REL_DIR = ".termigo/skills";

/** A description longer than this is a body in disguise. */
export const MAX_DESCRIPTION_CHARS = 300;

/** Enough for a real procedure, small enough that loading one is cheap. */
export const MAX_SKILL_BYTES = 16 * 1024;

export type Skill = {
  name: string;
  /** When to reach for it. This is what the model matches against. */
  description: string;
  /** Everything after the frontmatter. Empty until loaded. */
  body: string;
};

/**
 * Whether a name is safe to use as a directory.
 *
 * The name reaches the filesystem as a path segment, so this is the boundary
 * that stops `../../.ssh` or an absolute path from becoming a skill location.
 * Restrictive on purpose: a slug covers every real skill name, and anything it
 * rejects is easier to rename than to make safe.
 */
export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}

/** Turn a human title into a valid skill name, or null if nothing survives. */
export function slugifySkillName(input: string): string | null {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return isValidSkillName(slug) ? slug : null;
}

export function skillDir(workspaceRoot: string, name: string): string {
  return `${workspaceRoot.replace(/[\\/]$/, "")}/${SKILLS_REL_DIR}/${name}`;
}

export function skillPath(workspaceRoot: string, name: string): string {
  return `${skillDir(workspaceRoot, name)}/SKILL.md`;
}

/**
 * Split a SKILL.md into its frontmatter and body.
 *
 * A file without frontmatter is not an error: it is a skill someone wrote by
 * hand, and refusing it would make the format harder to use than it needs to
 * be. The name falls back to the directory it came from.
 */
export function parseSkill(name: string, content: string): Skill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) {
    return { name, description: "", body: content.trim() };
  }
  const front = match[1];
  const body = match[2].trim();
  const field = (key: string): string => {
    const m = new RegExp(`^${key}:\\s*(.*)$`, "mi").exec(front);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  return {
    // The directory name wins over any `name:` in the frontmatter: the
    // directory is what `use_skill` is called with, so honouring a mismatched
    // declaration would make the skill unreachable.
    name,
    description: field("description").slice(0, MAX_DESCRIPTION_CHARS),
    body,
  };
}

/** Render a skill file from its parts. */
export function formatSkill(skill: Skill): string {
  const description = skill.description.replace(/\s+/g, " ").trim();
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${description}`,
    "---",
    "",
    skill.body.trim(),
    "",
  ].join("\n");
}

/**
 * Every skill in the workspace, without bodies.
 *
 * Never throws: a workspace with no skills directory is the normal case, and a
 * single unreadable skill must not cost the agent all the others.
 */
export async function listSkills(
  workspaceRoot: string | null,
): Promise<Skill[]> {
  if (!workspaceRoot) return [];
  const root = `${workspaceRoot.replace(/[\\/]$/, "")}/${SKILLS_REL_DIR}`;
  let entries: Awaited<ReturnType<typeof native.readDir>>;
  try {
    entries = await native.readDir(root);
  } catch {
    return [];
  }

  const out: Skill[] = [];
  for (const entry of entries) {
    if (entry.kind !== "dir" || !isValidSkillName(entry.name)) continue;
    try {
      const read = await native.readFile(skillPath(workspaceRoot, entry.name));
      if (read.kind !== "text") continue;
      const skill = parseSkill(entry.name, read.content);
      // A skill with no description cannot be matched against a task, so it
      // would sit in the prompt costing tokens and never being chosen.
      if (!skill.description) continue;
      out.push({ ...skill, body: "" });
    } catch {
      // Missing or unreadable SKILL.md: skip this one, keep the rest.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Load one skill's full text. */
export async function readSkill(
  workspaceRoot: string | null,
  name: string,
): Promise<Skill | null> {
  if (!workspaceRoot || !isValidSkillName(name)) return null;
  try {
    const read = await native.readFile(skillPath(workspaceRoot, name));
    if (read.kind !== "text") return null;
    return parseSkill(name, read.content);
  } catch {
    return null;
  }
}

export type SaveOutcome =
  | { saved: true; path: string; replaced: boolean }
  | { saved: false; reason: string };

/** Write a skill, creating its directory. */
export async function saveSkill(
  workspaceRoot: string | null,
  skill: Skill,
): Promise<SaveOutcome> {
  if (!workspaceRoot) {
    return { saved: false, reason: "no workspace is open, so there is nowhere to store this" };
  }
  if (!isValidSkillName(skill.name)) {
    return {
      saved: false,
      reason: `"${skill.name}" is not a valid skill name: use lowercase letters, digits and hyphens`,
    };
  }
  if (!skill.description.trim()) {
    return {
      saved: false,
      reason: "a skill needs a description saying when to use it, or it can never be chosen",
    };
  }
  const content = formatSkill(skill);
  if (content.length > MAX_SKILL_BYTES) {
    return {
      saved: false,
      reason: `skill is ${content.length} bytes, over the ${MAX_SKILL_BYTES} limit; keep it to the procedure and link out for detail`,
    };
  }

  const replaced = (await readSkill(workspaceRoot, skill.name)) !== null;
  try {
    // write_atomic does not create parents, and .termigo/skills will not exist
    // in a workspace that has never saved one.
    await native.createDir(skillDir(workspaceRoot, skill.name));
  } catch {
    // Already there, or the write below fails with a clearer message.
  }
  await native.writeFile(skillPath(workspaceRoot, skill.name), content);
  return { saved: true, path: skillPath(workspaceRoot, skill.name), replaced };
}

/**
 * The prompt block: names and descriptions only.
 *
 * Bodies stay on disk until `use_skill` asks for one. Ten skills inlined would
 * be tens of kilobytes on every request, spent mostly on procedures the current
 * task has nothing to do with.
 */
export function skillsBlock(skills: readonly Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return (
    `\n\n## SKILLS - .termigo/skills/\n` +
    `Procedures you wrote in earlier sessions. When one matches the task, call\n` +
    `\`use_skill\` with its name to read it BEFORE working out your own approach.\n` +
    `${lines.join("\n")}`
  );
}
