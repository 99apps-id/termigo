import { native } from "./native";
import { useChatStore } from "../store/chatStore";
import { isValidSkillName, SKILLS_REL_DIR, type Skill } from "./skills";

// ─── Types ────────────────────────────────────────────────────────────────

export type RegistrySkill = {
  name: string;
  description: string;
  version?: string;
  author?: string;
  tags?: string[];
  installed?: boolean;
};

export type RegistryEntry = {
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  body: string;
};

// ─── Storage ──────────────────────────────────────────────────────────────

const REGISTRY_DIR = ".termigo/registry";

async function registryRoot(): Promise<string | null> {
  const cwd = useChatStore.getState().live.getWorkspaceRoot() ?? ".";
  return `${cwd.replace(/\/$/, "")}/${REGISTRY_DIR}`;
}

// ─── Registry operations ──────────────────────────────────────────────────

/**
 * Install a skill from a registry entry into the workspace skills directory.
 */
export async function installSkill(entry: RegistryEntry): Promise<{ ok: boolean; error?: string }> {
  if (!isValidSkillName(entry.name)) {
    return { ok: false, error: `Invalid skill name: ${entry.name}` };
  }

  const root = await registryRoot();
  if (!root) return { ok: false, error: "no workspace root" };

  const skillDir = `${root}/${SKILLS_REL_DIR}/${entry.name}`;
  const skillFile = `${skillDir}/SKILL.md`;

  try {
    await native.createDir(skillDir);
    const content = [
      "---",
      `name: ${entry.name}`,
      `description: ${entry.description}`,
      `version: ${entry.version}`,
      `author: ${entry.author}`,
      ...(entry.tags?.length ? [`tags: ${entry.tags.join(", ")}`] : []),
      "---",
      "",
      entry.body.trim(),
      "",
    ].join("\n");

    await native.writeFile(skillFile, content);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Remove an installed skill from the workspace.
 */
export async function uninstallSkill(name: string): Promise<{ ok: boolean; error?: string }> {
  if (!isValidSkillName(name)) {
    return { ok: false, error: `Invalid skill name: ${name}` };
  }

  const root = await registryRoot();
  if (!root) return { ok: false, error: "no workspace root" };

  const skillDir = `${root}/${SKILLS_REL_DIR}/${name}`;

  try {
    await native.deletePath(skillDir);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * List all installed skills in the workspace.
 */
export async function listInstalledSkills(): Promise<Skill[]> {
  const root = await registryRoot();
  if (!root) return [];

  try {
    const entries = await native.readDir(`${root}/${SKILLS_REL_DIR}`);
    const skills: Skill[] = [];

    for (const entry of entries) {
      if (entry.kind !== "dir" || !isValidSkillName(entry.name)) continue;
      try {
        const read = await native.readFile(`${root}/${SKILLS_REL_DIR}/${entry.name}/SKILL.md`);
        if (read.kind !== "text") continue;
        const skill = parseSkill(entry.name, read.content);
        if (skill.description) skills.push(skill);
      } catch {
        // Skip unreadable skills
      }
    }

    return skills.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Search installed skills by query string.
 */
export async function searchInstalledSkills(query: string): Promise<Skill[]> {
  const all = await listInstalledSkills();
  const q = query.toLowerCase().trim();
  if (!q) return all;

  return all.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q),
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function parseSkill(name: string, content: string): Skill {
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
    name,
    description: field("description").slice(0, 300),
    body,
  };
}

import { tool } from "ai";
import { z } from "zod";

// ─── Agent tools ──────────────────────────────────────────────────────────

export function buildSkillRegistryTools() {
  return {
    install_skill: tool({
      description:
        "Install a skill from a registry entry into the workspace. The skill becomes available for use in future agent runs.",
      inputSchema: z.object({
        name: z.string().describe("Skill name"),
        description: z.string().describe("Skill description"),
        version: z.string().optional().default("1.0.0").describe("Skill version"),
        author: z.string().optional().default("unknown").describe("Skill author"),
        tags: z.array(z.string()).optional().default([]).describe("Skill tags"),
        body: z.string().describe("Skill body (SKILL.md content)"),
      }),
      execute: async ({ name, description, version, author, tags, body }) => {
        const entry: RegistryEntry = {
          name,
          description,
          version: version ?? "1.0.0",
          author: author ?? "unknown",
          tags: tags ?? [],
          body,
        };
        const result = await installSkill(entry);
        if (!result.ok) return { error: result.error };
        return { installed: true, name: entry.name };
      },
    }),

    uninstall_skill: tool({
      description:
        "Remove an installed skill from the workspace. This cannot be undone.",
      inputSchema: z.object({
        name: z.string().describe("Skill name to remove"),
      }),
      execute: async ({ name }) => {
        const result = await uninstallSkill(name);
        if (!result.ok) return { error: result.error };
        return { uninstalled: true, name };
      },
    }),

    search_skills: tool({
      description:
        "Search installed skills by name or description. Returns matching skills.",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
      }),
      execute: async ({ query }) => {
        const skills = await searchInstalledSkills(query);
        return {
          skills: skills.map((s) => ({
            name: s.name,
            description: s.description,
          })),
        };
      },
    }),
  } as const;
}

