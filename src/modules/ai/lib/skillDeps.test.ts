import { describe, expect, it } from "vitest";
import {
  checkSkillDependencies,
  declaredTools,
  dependencyWarning,
  foreignAgentMentions,
  referencedTools,
} from "./skillDeps";

const TERMIGO_TOOLS = ["read_file", "write_file", "bash_run", "list_directory"];

describe("declaredTools", () => {
  it("reads a comma-separated list", () => {
    expect(declaredTools("---\ntools: read_file, bash_run\n---")).toEqual([
      "read_file",
      "bash_run",
    ]);
  });

  it("reads an array-ish list with quotes", () => {
    expect(declaredTools('tools: ["read_file", "browser_click"]')).toEqual([
      "read_file",
      "browser_click",
    ]);
  });

  it("reports nothing when the field is absent", () => {
    expect(declaredTools("---\nname: x\n---\nbody")).toEqual([]);
  });
});

describe("referencedTools", () => {
  it("picks up backticked tool names", () => {
    expect(referencedTools("Call `browser_click` then `read_file`.")).toEqual([
      "browser_click",
      "read_file",
    ]);
  });

  // A checker that warns about `npm` teaches the reader to stop reading
  // warnings, which costs more than the misses.
  it("ignores single words, which are as likely to be programs", () => {
    expect(referencedTools("Run `npm`, `docker`, `browser`, `grep`.")).toEqual([]);
  });

  it("ignores prose and shell lines outside backticks", () => {
    expect(referencedTools("use read_file for this")).toEqual([]);
  });

  it("does not report the same tool twice", () => {
    expect(referencedTools("`run_in_terminal` then `run_in_terminal`")).toEqual([
      "run_in_terminal",
    ]);
  });
});

describe("checkSkillDependencies", () => {
  it("says nothing when the skill fits", () => {
    const deps = checkSkillDependencies(
      "tools: read_file\n\nUse `read_file` then `bash_run`.",
      TERMIGO_TOOLS,
    );
    expect(deps.missingDeclared).toEqual([]);
    expect(deps.missingReferenced).toEqual([]);
    expect(dependencyWarning(deps)).toBeNull();
  });

  // The case this exists for: OpenClaw's browser skill parses perfectly here
  // and every step calls a tool that does not exist.
  it("catches a skill written for another agent", () => {
    const deps = checkSkillDependencies(
      "Use `browser_click` on the ref, then `read_browser_console`.",
      TERMIGO_TOOLS,
    );
    expect(deps.missingReferenced).toEqual([
      "browser_click",
      "read_browser_console",
    ]);
  });

  it("trusts a declaration over the guess, and does not repeat it", () => {
    const deps = checkSkillDependencies(
      "tools: browser_click\n\nUse `browser_click` twice.",
      TERMIGO_TOOLS,
    );
    expect(deps.missingDeclared).toEqual(["browser_click"]);
    expect(deps.missingReferenced).toEqual([]);
  });

  // Whether an MCP tool exists is a question about the user's mcp.json, not
  // about Termigo; calling a configured server "missing" would be wrong.
  it("separates MCP tools from missing ones", () => {
    const deps = checkSkillDependencies(
      "Call `mcp__github__create_issue` when done.",
      TERMIGO_TOOLS,
    );
    expect(deps.mcpRequired).toEqual(["mcp__github__create_issue"]);
    expect(deps.missingReferenced).toEqual([]);
  });
});

describe("dependencyWarning", () => {
  it("names what is missing and what to do instead", () => {
    const warning = dependencyWarning(
      checkSkillDependencies("Use `browser_click`.", TERMIGO_TOOLS),
    );
    expect(warning).toContain("browser_click");
    // Most imported skills are mostly applicable, so the model should adapt
    // them rather than abandon them.
    expect(warning).toContain("guidance");
    expect(warning).toContain("not in your tool list");
  });

  it("mentions MCP separately, as configuration rather than absence", () => {
    const warning = dependencyWarning(
      checkSkillDependencies("Call `mcp__db__query`.", TERMIGO_TOOLS),
    );
    expect(warning).toContain("mcp.json");
  });
});

// The snake_case heuristic missed the very case it was built for. OpenClaw's
// browser skill calls its tool `browser` — one word, deliberately ignored —
// and passes camelCase parameters, so nothing in it looks like a tool name.
// A skill written elsewhere nearly always says so instead.
describe("foreignAgentMentions", () => {
  it("recognises the agent a skill was written for", () => {
    expect(
      foreignAgentMentions("Use when controlling web pages with the OpenClaw browser tool."),
    ).toEqual(["openclaw"]);
    expect(foreignAgentMentions("Run this in Claude Code first.")).toEqual([
      "claude code",
    ]);
  });

  it("reports one product once, however it is spelled", () => {
    expect(foreignAgentMentions("claude-code and Claude Code")).toEqual([
      "claude code",
    ]);
  });

  it("says nothing about a skill that names no agent", () => {
    expect(foreignAgentMentions("Deploy with docker compose up -d.")).toEqual([]);
  });

  it("catches the real openclaw phrasing end to end", () => {
    const warning = dependencyWarning(
      checkSkillDependencies(
        "Use when controlling web pages with the OpenClaw browser tool.\nRun `openclaw browser doctor`.",
        ["read_file"],
      ),
    );
    expect(warning).toContain("openclaw");
    expect(warning).toContain("different agent");
  });
});
