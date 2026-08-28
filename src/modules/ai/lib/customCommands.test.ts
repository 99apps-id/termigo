import { describe, expect, it } from "vitest";
import {
  expandCommand,
  isValidCommandName,
  parseCommand,
} from "./customCommands";

describe("parseCommand", () => {
  it("reads a description from frontmatter and keeps the body", () => {
    const cmd = parseCommand(
      "review-pr",
      `---\ndescription: Review the current PR\n---\nReview the diff for $ARGUMENTS and report issues.`,
    );
    expect(cmd).toEqual({
      name: "review-pr",
      description: "Review the current PR",
      body: "Review the diff for $ARGUMENTS and report issues.",
    });
  });

  it("accepts a body-only file with no frontmatter", () => {
    const cmd = parseCommand("standup", "Summarise what changed since yesterday.");
    expect(cmd.description).toBe("");
    expect(cmd.body).toBe("Summarise what changed since yesterday.");
  });
});

describe("expandCommand", () => {
  const cmd = (body: string) => ({ name: "c", description: "", body });

  it("substitutes $ARGUMENTS wherever it appears", () => {
    expect(expandCommand(cmd("deploy $ARGUMENTS to $ARGUMENTS"), "prod")).toBe(
      "deploy prod to prod",
    );
  });

  it("appends the arguments when the body has no placeholder", () => {
    expect(expandCommand(cmd("Explain this code:"), "foo.ts")).toBe(
      "Explain this code:\n\nfoo.ts",
    );
  });

  it("leaves the body untouched when there are no arguments", () => {
    expect(expandCommand(cmd("Run the release checklist."), "  ")).toBe(
      "Run the release checklist.",
    );
  });
});

describe("isValidCommandName", () => {
  it("accepts slugs and rejects path traversal", () => {
    expect(isValidCommandName("review-pr")).toBe(true);
    expect(isValidCommandName("deploy2")).toBe(true);
    expect(isValidCommandName("../etc")).toBe(false);
    expect(isValidCommandName("Bad Name")).toBe(false);
    expect(isValidCommandName("")).toBe(false);
  });
});
