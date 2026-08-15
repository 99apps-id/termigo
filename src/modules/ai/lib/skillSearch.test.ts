import { describe, expect, it } from "vitest";
import {
  MAX_SKILL_READS,
  queryTerms,
  rankMatches,
  scoreDescription,
  scoreName,
  shortlist,
  skillNameFromPath,
  type SkillCandidate,
  type SkillMatch,
} from "./skillSearch";

function candidate(name: string, source: SkillCandidate["source"]): SkillCandidate {
  return { name, path: `/root/${name}/SKILL.md`, source };
}

describe("skillNameFromPath", () => {
  it("takes the directory holding the SKILL.md", () => {
    expect(skillNameFromPath("/home/u/.codex/plugins/airtable/skills/airtable-cli/SKILL.md")).toBe(
      "airtable-cli",
    );
  });

  it("reads Windows separators too", () => {
    expect(skillNameFromPath("C:\\Users\\n\\.openclaw\\plugin-skills\\canvas\\SKILL.md")).toBe(
      "canvas",
    );
  });
});

describe("queryTerms", () => {
  it("splits on punctuation and drops noise", () => {
    expect(queryTerms("deploy-to docker!")).toEqual(["deploy", "to", "docker"]);
  });

  it("drops single characters, which match everything", () => {
    expect(queryTerms("a b deploy")).toEqual(["deploy"]);
  });
});

describe("scoreName", () => {
  // Asking for airtable-cli should not hand back airtable-filters first.
  it("ranks an exact name above a partial one", () => {
    const terms = queryTerms("airtable-cli");
    expect(scoreName("airtable-cli", terms)).toBeGreaterThan(
      scoreName("airtable-filters", terms),
    );
  });

  it("rewards matching more of the query", () => {
    expect(scoreName("deploy-docker", queryTerms("deploy docker"))).toBeGreaterThan(
      scoreName("deploy-nginx", queryTerms("deploy docker")),
    );
  });

  it("scores nothing for an unrelated name", () => {
    expect(scoreName("canvas", queryTerms("airtable"))).toBe(0);
  });
});

describe("shortlist", () => {
  const many: SkillCandidate[] = [
    candidate("airtable-cli", "codex"),
    candidate("airtable-filters", "codex"),
    candidate("canvas", "openclaw"),
    candidate("deploy-vps", "workspace"),
  ];

  // Reading 620 files to answer one question would take seconds, and most of
  // them score zero.
  it("opens only the names that matched", () => {
    const picked = shortlist(many, queryTerms("airtable"));
    expect(picked.map((c) => c.name)).toEqual(["airtable-cli", "airtable-filters"]);
  });

  it("never opens more than the read cap", () => {
    const huge = Array.from({ length: 500 }, (_, i) => candidate(`deploy-${i}`, "codex"));
    expect(shortlist(huge, queryTerms("deploy"))).toHaveLength(MAX_SKILL_READS);
  });

  // A query whose words appear only in descriptions should still find
  // something, and reading a bounded sample is the only way to know.
  it("falls back to a bounded sample when no name matches", () => {
    const picked = shortlist(many, queryTerms("kubernetes"));
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.length).toBeLessThanOrEqual(MAX_SKILL_READS);
  });

  // A workspace skill is far likelier to be the one meant than the 400th
  // entry of a plugin cache.
  it("prefers the closest libraries in that fallback", () => {
    const picked = shortlist(many, queryTerms("kubernetes"));
    expect(picked[0].source).toBe("workspace");
  });
});

describe("scoreDescription", () => {
  it("counts query words found in the description", () => {
    // Both terms hit: "deploy" is a prefix of "deploying", "docker" is exact.
    expect(scoreDescription("Use when deploying with docker", queryTerms("deploy docker"))).toBe(2);
    expect(scoreDescription("Use when deploying", queryTerms("deploy docker"))).toBe(1);
    expect(scoreDescription("nothing relevant", queryTerms("deploy"))).toBe(0);
  });
});

describe("rankMatches", () => {
  const match = (name: string, score: number): SkillMatch => ({
    name,
    path: `/x/${name}/SKILL.md`,
    source: "codex",
    description: "d",
    score,
  });

  it("returns the best first", () => {
    expect(rankMatches([match("b", 1), match("a", 9)]).map((m) => m.name)).toEqual([
      "a",
      "b",
    ]);
  });

  it("drops anything that scored nothing", () => {
    expect(rankMatches([match("a", 0)])).toEqual([]);
  });

  it("caps how many come back", () => {
    const lots = Array.from({ length: 50 }, (_, i) => match(`s${i}`, 5));
    expect(rankMatches(lots, 8)).toHaveLength(8);
  });

  it("breaks ties by name so results do not shuffle between calls", () => {
    expect(rankMatches([match("z", 5), match("a", 5)]).map((m) => m.name)).toEqual([
      "a",
      "z",
    ]);
  });
});
