import { describe, expect, it } from "vitest";
import {
  type ApprovalRule,
  evaluateApprovalRules,
  parseApprovalRules,
  ruleFromApproval,
  ruleMatches,
  sameRuleTarget,
  serializeApprovalRules,
  subagentRuleGate,
  upsertRule,
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

describe("ruleFromApproval", () => {
  it("generalises a shell command to a program glob", () => {
    expect(
      ruleFromApproval("bash_run", { command: "git status -s" }, "allow"),
    ).toEqual({ tools: ["bash_run"], command: "git *", action: "allow" });
  });

  it("matches a path-qualified program whole, without a trailing glob", () => {
    expect(
      ruleFromApproval("bash_run", { command: "./deploy.sh prod" }, "deny"),
    ).toEqual({ tools: ["bash_run"], command: "./deploy.sh", action: "deny" });
  });

  it("keys a file tool on its exact path", () => {
    expect(
      ruleFromApproval("write_file", { path: "src/App.tsx" }, "allow"),
    ).toEqual({ tools: ["write_file"], path: "src/App.tsx", action: "allow" });
  });

  it("keys on the tool alone when there is no path or command", () => {
    expect(ruleFromApproval("some_tool", {}, "allow")).toEqual({
      tools: ["some_tool"],
      action: "allow",
    });
  });

  it("refuses to persist an empty shell command", () => {
    expect(
      ruleFromApproval("bash_run", { command: "   " }, "allow"),
    ).toBeNull();
  });

  // The generalised rule must actually cover sibling calls, or "always allow"
  // would still prompt on the next `git` subcommand.
  it("produces a rule that matches sibling commands", () => {
    const rule = ruleFromApproval(
      "bash_run",
      { command: "git status" },
      "allow",
    );
    expect(
      rule && ruleMatches(rule, { tool: "bash_run", command: "git push" }),
    ).toBe(true);
  });
});

describe("upsertRule", () => {
  const base: ApprovalRule[] = [
    { tools: ["bash_run"], command: "git *", action: "allow" },
    { tools: ["edit"], path: "src/**", action: "allow" },
  ];

  it("replaces a rule targeting the same calls, keeping the file de-duplicated", () => {
    const flipped: ApprovalRule = {
      tools: ["bash_run"],
      command: "git *",
      action: "deny",
    };
    const out = upsertRule(base, flipped);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(flipped);
    expect(out.filter((r) => r.command === "git *")).toHaveLength(1);
  });

  it("prepends a new rule so it wins over broader rules already present", () => {
    const fresh: ApprovalRule = {
      tools: ["write_file"],
      path: "README.md",
      action: "deny",
    };
    expect(upsertRule(base, fresh)[0]).toEqual(fresh);
  });

  it("treats tool order as irrelevant when matching targets", () => {
    expect(
      sameRuleTarget(
        { tools: ["a", "b"], action: "allow" },
        { tools: ["b", "a"], action: "deny" },
      ),
    ).toBe(true);
  });
});

describe("serializeApprovalRules", () => {
  it("round-trips through parse unchanged", () => {
    const rules: ApprovalRule[] = [
      { tools: ["bash_run"], command: "git *", action: "allow" },
      { tools: ["edit"], path: "**/*.env", action: "deny", reason: "secrets" },
    ];
    const text = serializeApprovalRules(rules);
    expect(text.endsWith("\n")).toBe(true);
    expect(parseApprovalRules(JSON.parse(text))).toEqual(rules);
  });

  it("writes the versioned file shape", () => {
    expect(JSON.parse(serializeApprovalRules([]))).toEqual({
      version: 1,
      rules: [],
    });
  });
});

describe("subagentRuleGate", () => {
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

  it("auto-refuses a denied call", () => {
    expect(
      subagentRuleGate(rules, {
        tool: "bash_run",
        command: "rm -rf build",
      }),
    ).toBe("deny");
  });

  it("auto-runs an allowed call without the queue", () => {
    expect(
      subagentRuleGate(rules, { tool: "bash_run", command: "git status" }),
    ).toBe("allow");
  });

  it("falls through to the queue when a rule forces ask", () => {
    expect(subagentRuleGate(rules, { tool: "edit", path: "app/.env" })).toBe(
      "ask",
    );
  });

  it("falls through to the queue when no rule matches", () => {
    expect(subagentRuleGate(rules, { tool: "edit", path: "src/App.tsx" })).toBe(
      "ask",
    );
  });

  it("falls through to the queue with no rules at all", () => {
    expect(
      subagentRuleGate([], { tool: "bash_run", command: "git status" }),
    ).toBe("ask");
  });
});
