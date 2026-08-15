// Walking the machine's skill libraries. The ranking lives in skillSearch.ts;
// this is the part that touches the filesystem.

import { homeDir } from "@tauri-apps/api/path";
import { native } from "./native";
import { parseSkill } from "./skills";
import {
  FOREIGN_ROOTS,
  MAX_SKILL_MATCHES,
  queryTerms,
  rankMatches,
  scoreDescription,
  scoreName,
  shortlist,
  skillNameFromPath,
  type SkillCandidate,
  type SkillMatch,
} from "./skillSearch";

/** Paths only. Glob does not open the files, so this stays cheap. */
async function candidatesIn(
  root: string,
  source: SkillCandidate["source"],
): Promise<SkillCandidate[]> {
  try {
    const found = await native.glob({
      pattern: "**/SKILL.md",
      root,
      maxResults: 2000,
    });
    return found.hits.map((h) => ({
      name: skillNameFromPath(h.path),
      path: h.path,
      source,
    }));
  } catch {
    return []; // library not installed on this machine
  }
}

/**
 * Every skill file this machine offers, as paths.
 *
 * Libraries are scanned in parallel and a missing one costs nothing: most
 * users have none of the foreign roots, and the ones who have them should not
 * wait on the ones they do not.
 */
export async function collectCandidates(
  workspaceRoot: string | null,
): Promise<SkillCandidate[]> {
  const jobs: Promise<SkillCandidate[]>[] = [];
  if (workspaceRoot) {
    jobs.push(candidatesIn(`${workspaceRoot.replace(/[\\/]$/, "")}/.termigo/skills`, "workspace"));
  }
  try {
    const home = (await homeDir()).replace(/[\\/]$/, "");
    for (const { rel, source } of FOREIGN_ROOTS) {
      jobs.push(candidatesIn(`${home}/${rel}`, source));
    }
  } catch {
    // No home directory: workspace skills are still searchable.
  }

  const all = (await Promise.all(jobs)).flat();
  // The same skill can appear twice when a library nests inside another.
  const seen = new Set<string>();
  return all.filter((c) => {
    const key = c.path.replace(/\\/g, "/").toLowerCase();
    if (!c.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Read one SKILL.md by absolute path, for a skill find_skill turned up. */
export async function readSkillAt(path: string) {
  try {
    const read = await native.readFile(path);
    if (read.kind !== "text") return null;
    return parseSkill(skillNameFromPath(path), read.content);
  } catch {
    return null;
  }
}

/**
 * Find skills matching a query.
 *
 * Names are filtered before anything is opened, then only the survivors are
 * read for their descriptions. On this machine that is the difference between
 * opening a couple of files and opening six hundred.
 */
export async function searchSkills(
  workspaceRoot: string | null,
  query: string,
): Promise<SkillMatch[]> {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const candidates = await collectCandidates(workspaceRoot);
  if (candidates.length === 0) return [];

  const matches: SkillMatch[] = [];
  for (const candidate of shortlist(candidates, terms)) {
    const skill = await readSkillAt(candidate.path);
    if (!skill?.description) continue;
    matches.push({
      ...candidate,
      description: skill.description,
      score:
        scoreName(candidate.name, terms) +
        scoreDescription(skill.description, terms),
    });
  }
  return rankMatches(matches, MAX_SKILL_MATCHES);
}
