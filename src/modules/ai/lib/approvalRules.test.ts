import { describe, expect, it } from "vitest";
import {
  type ApprovalRule,
  evaluateApprovalRules,
  parseApprovalRules,
  ruleMatches,
} from "./approvalRules";

describe("ruleMatches", () => {
  it("matches a bare command pattern as a substring", () => {
    const rule: ApprovalRule = {
      tools: ["bash_run"],
      command: "git ",
      action: "allow",
    };
    expect(ruleMatches(rule, { tool: "bash_run", command: "git status" })).toBe(
      true,
    );
    expect(ruleMatches(rule, { tool: "bash_run", command: "npm test" })).toBe(
      false,
    );
  });

  it("treats a wildcard command pattern as an anchored glob", () => {
    const rule: ApprovalRule = { command: "git push*", action: "deny" };
    expect(
      ruleMatches(rule, { tool: "bash_run", command: "git push -f" }),
    ).toBe(true);
    expect(
      ruleMatches(rule, { tool: "bash_run", command: "echo git push" }),
    ).toBe(false);
  });

  it("matches a path glob, ** spanning directories", () => {
    const rule: ApprovalRule = {
      tools: ["edit", "write_file"],
      path: "src/**",
      action: "allow",
    };
    expect(ruleMatches(rule, { tool: "edit", path: "src/app/App.tsx" })).toBe(
      true,
    );
    expect(ruleMatches(rule, { tool: "edit", path: "tests/foo.ts" })).toBe(
      false,
    );
  });

  it("matches an env-file path with a single-segment wildcard", () => {
    const rule: ApprovalRule = { path: "**/*.env", action: "deny" };
    expect(ruleMatches(rule, { tool: "write_file", path: "app/.env" })).toBe(
      true,
    );
    expect(
      ruleMatches(rule, { tool: "write_file", path: "app/config.ts" }),
    ).toBe(false);
  });

  it("respects the tool filter", () => {
    const rule: ApprovalRule = { tools: ["bash_run"], action: "deny" };
    expect(ruleMatches(rule, { tool: "bash_run" })).toBe(true);
    expect(ruleMatches(rule, { tool: "edit" })).toBe(false);
  });

  it("a rule with no filters matches anything", () => {
    const rule: ApprovalRule = { action: "ask" };
    expect(ruleMatches(rule, { tool: "whatever" })).toBe(true);
  });

  it("normalises backslashes in paths", () => {
    const rule: ApprovalRule = { path: "src/**", action: "allow" };
    expect(ruleMatches(rule, { tool: "edit", path: "src\\a\\b.ts" })).toBe(
      true,
    );
  });
});

describe("evaluateApprovalRules", () => {
  const rules: ApprovalRule[] = [
    {
      tools: ["bash_run"],
      command: "rm -rf",
      action: "deny",
      reason: "danger",
    },
    { tools: ["bash_run"], command: "git ", action: "allow" },
    { tools: ["edit", "write_file"], path: "**/*.env", action: "ask" },
  ];

  it("returns the first matching rule's action", () => {
    expect(
      evaluateApprovalRules(rules, { tool: "bash_run", command: "git status" }),
    ).toEqual({ action: "allow" });
  });

  it("carries the reason for a deny", () => {
    expect(
      evaluateApprovalRules(rules, {
        tool: "bash_run",
        command: "rm -rf build",
      }),
    ).toEqual({ action: "deny", reason: "danger" });
  });

  it("forces ask for a matched path", () => {
    expect(
      evaluateApprovalRules(rules, { tool: "edit", path: "app/.env" }),
    ).toEqual({ action: "ask" });
  });

  it("returns null when nothing matches", () => {
    expect(
      evaluateApprovalRules(rules, { tool: "edit", path: "src/App.tsx" }),
    ).toBeNull();
  });
});

describe("parseApprovalRules", () => {
  it("keeps valid rules and drops malformed ones", () => {
    const parsed = parseApprovalRules({
      version: 1,
      rules: [
        { tools: ["bash_run"], command: "git *", action: "allow" },
        { action: "nope" }, // invalid action
        { path: "src/**", action: "deny", reason: "x" },
        "garbage",
        null,
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      tools: ["bash_run"],
      command: "git *",
      action: "allow",
    });
    expect(parsed[1]).toEqual({ path: "src/**", action: "deny", reason: "x" });
  });

  it("returns [] for a file with no rules array", () => {
    expect(parseApprovalRules({})).toEqual([]);
    expect(parseApprovalRules(null)).toEqual([]);
  });
});
