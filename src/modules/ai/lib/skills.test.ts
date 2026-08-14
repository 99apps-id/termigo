import { describe, expect, it } from "vitest";
import {
  formatSkill,
  isValidSkillName,
  MAX_DESCRIPTION_CHARS,
  parseSkill,
  skillPath,
  skillsBlock,
  slugifySkillName,
} from "./skills";

describe("isValidSkillName", () => {
  it("accepts ordinary slugs", () => {
    for (const n of ["deploy", "deploy-to-vps", "fix-flaky-tests", "a", "v2-release"]) {
      expect(isValidSkillName(n)).toBe(true);
    }
  });

  // The name becomes a path segment, so this is the boundary that stops a
  // skill from being written outside the skills directory.
  it("rejects anything that could escape the skills directory", () => {
    for (const n of [
      "..",
      "../escape",
      "../../.ssh",
      "/etc/passwd",
      "C:\\Windows",
      "a/b",
      "a\\b",
      ".hidden",
      "with space",
      "UPPER",
      "trailing/",
    ]) {
      expect(isValidSkillName(n)).toBe(false);
    }
  });

  it("rejects an empty name and one that is absurdly long", () => {
    expect(isValidSkillName("")).toBe(false);
    expect(isValidSkillName("a".repeat(100))).toBe(false);
  });
});

describe("slugifySkillName", () => {
  // The model reaches for prose names; failing over punctuation would refuse
  // for a reason that has nothing to do with the skill.
  it("turns a human title into a usable name", () => {
    expect(slugifySkillName("Deploy to VPS")).toBe("deploy-to-vps");
    expect(slugifySkillName("Fix the flaky tests!")).toBe("fix-the-flaky-tests");
    expect(slugifySkillName("v2 release")).toBe("v2-release");
  });

  it("does not produce a name that escapes the directory", () => {
    for (const input of ["../../etc", "/absolute/path", "..", "  "]) {
      const slug = slugifySkillName(input);
      expect(slug === null || isValidSkillName(slug)).toBe(true);
    }
  });

  it("gives up rather than inventing a name from nothing", () => {
    expect(slugifySkillName("!!!")).toBeNull();
    expect(slugifySkillName("")).toBeNull();
  });
});

describe("skillPath", () => {
  it("puts each skill in its own directory", () => {
    expect(skillPath("/ws", "deploy")).toBe("/ws/.termigo/skills/deploy/SKILL.md");
  });

  it("does not double the separator on a trailing slash", () => {
    expect(skillPath("/ws/", "deploy")).toBe("/ws/.termigo/skills/deploy/SKILL.md");
  });
});

describe("parseSkill", () => {
  it("round-trips through the file format", () => {
    const skill = {
      name: "deploy",
      description: "Use when deploying to production.",
      body: "## Steps\n\n1. Build\n2. Ship",
    };
    expect(parseSkill("deploy", formatSkill(skill))).toEqual(skill);
  });

  // A hand-written file without frontmatter is a skill someone wrote, not an
  // error; refusing it would make the format harder to use than it needs to be.
  it("accepts a file with no frontmatter", () => {
    const parsed = parseSkill("notes", "just the steps");
    expect(parsed).toEqual({ name: "notes", description: "", body: "just the steps" });
  });

  // The directory is what use_skill is called with, so honouring a mismatched
  // declaration would make the skill unreachable.
  it("lets the directory name win over the frontmatter", () => {
    const parsed = parseSkill("real-name", "---\nname: other\ndescription: d\n---\nbody");
    expect(parsed.name).toBe("real-name");
  });

  it("clips a description that is really a body", () => {
    const long = "x".repeat(MAX_DESCRIPTION_CHARS + 200);
    expect(
      parseSkill("s", `---\ndescription: ${long}\n---\nbody`).description,
    ).toHaveLength(MAX_DESCRIPTION_CHARS);
  });

  it("strips quotes people add around the description", () => {
    expect(parseSkill("s", '---\ndescription: "quoted"\n---\nb').description).toBe(
      "quoted",
    );
  });

  it("handles CRLF, which is what Windows editors write", () => {
    const parsed = parseSkill("s", "---\r\ndescription: d\r\n---\r\nbody here");
    expect(parsed.description).toBe("d");
    expect(parsed.body).toBe("body here");
  });
});

describe("skillsBlock", () => {
  it("contributes nothing when no skills exist", () => {
    expect(skillsBlock([])).toBe("");
  });

  // Bodies stay on disk: a handful of skills inlined would be tens of
  // kilobytes on every request, mostly irrelevant to the task at hand.
  it("lists names and descriptions only, never bodies", () => {
    const block = skillsBlock([
      { name: "deploy", description: "Use when deploying.", body: "SECRET BODY" },
    ]);
    expect(block).toContain("deploy");
    expect(block).toContain("Use when deploying.");
    expect(block).not.toContain("SECRET BODY");
  });

  it("tells the model to read a matching skill before improvising", () => {
    const block = skillsBlock([{ name: "d", description: "x", body: "" }]);
    expect(block).toContain("use_skill");
    expect(block.toLowerCase()).toContain("before");
  });
});
