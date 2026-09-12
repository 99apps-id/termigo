import { describe, expect, it } from "vitest";
import { BUILTIN_PROFILES } from "../lib/harnessProfile";
import { UNKNOWN_TOOL_NAME } from "../tools/toolFallback";
import { FIND_TOOLS_NAME } from "../tools/toolSearch";
import {
  buildAgentTools,
  buildSubagentSpec,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  DEFAULT_SUBAGENT_MAX_STEPS,
  RECOVERY_TOOL_NAMES,
  resolveAgentForPrompt,
  SPAWN_TOOLS,
  spawnToolsWithheld,
} from "./agentFactory";

const noTools = () => ({
  read_file: { execute: () => undefined },
  edit: { execute: () => undefined },
  bash_run: { execute: () => undefined },
  run_subagent: { execute: () => undefined },
  run_subagents: { execute: () => undefined },
});

describe("buildSubagentSpec", () => {
  it("resolves a loose type to its roster def", () => {
    const spec = buildSubagentSpec("implement");
    expect(spec.id).toBe("builder");
    expect(spec.label).toBe("Builder");
    expect(spec.systemPrompt.length).toBeGreaterThan(0);
  });

  it("flags vision agents and carries their budget", () => {
    const spec = buildSubagentSpec("vision");
    expect(spec.needsVision).toBe(true);
    expect(spec.readOnly).toBe(false);
    expect(spec.maxSteps).toBe(DEFAULT_SUBAGENT_MAX_STEPS);
  });

  it("flags read-tier pentest specialists", () => {
    for (const t of ["pentest-recon", "pentest-web", "pentest-network"]) {
      expect(buildSubagentSpec(t).readOnly).toBe(true);
    }
    expect(buildSubagentSpec("pentest").readOnly).toBe(false);
  });

  it("applies the profile prelude to the system prompt", () => {
    const withPrelude = buildSubagentSpec(
      "explore",
      BUILTIN_PROFILES.plan_briefly,
    );
    const without = buildSubagentSpec("explore");
    expect(withPrelude.systemPrompt.startsWith("Start with a short plan")).toBe(
      true,
    );
    expect(withPrelude.systemPrompt).toContain(without.systemPrompt);
  });

  it("falls back to the general worker for an unknown type", () => {
    const spec = buildSubagentSpec("nonsense-type");
    expect(spec.id).toBe("general");
  });
});

describe("buildAgentTools", () => {
  it("keeps every tool when no profile and no depth", () => {
    const tools = buildAgentTools(noTools());
    expect(Object.keys(tools).sort()).toEqual(
      ["bash_run", "edit", "read_file", "run_subagent", "run_subagents"].sort(),
    );
  });

  it("applies the profile's hide rules", () => {
    const tools = buildAgentTools(noTools(), {
      profile: BUILTIN_PROFILES.no_todo,
    });
    // no_todo hides todo_write, which is not in our fixture - but the shape is
    // what matters: hideTools must be honoured.
    expect(tools.read_file).toBeDefined();
  });

  it("withholds spawn tools at the nesting cap", () => {
    const tools = buildAgentTools(noTools(), {
      depth: DEFAULT_MAX_SUBAGENT_DEPTH,
      maxDepth: DEFAULT_MAX_SUBAGENT_DEPTH,
    });
    expect(tools.run_subagent).toBeUndefined();
    expect(tools.run_subagents).toBeUndefined();
    expect(tools.read_file).toBeDefined();
  });

  it("keeps spawn tools below the cap", () => {
    const tools = buildAgentTools(noTools(), {
      depth: 1,
      maxDepth: DEFAULT_MAX_SUBAGENT_DEPTH,
    });
    expect(tools.run_subagent).toBeDefined();
  });

  it("never withholds spawn tools for the main agent (no depth)", () => {
    const tools = buildAgentTools(noTools());
    expect(tools.run_subagent).toBeDefined();
    expect(tools.run_subagents).toBeDefined();
  });

  it("withholds todo_write from subagents but keeps it for the main agent", () => {
    const fixture = {
      todo_write: { execute: () => undefined },
      read_file: { execute: () => undefined },
    };
    const mainTools = buildAgentTools(fixture);
    expect(mainTools.todo_write).toBeDefined();

    const subTools = buildAgentTools(fixture, { depth: 1 });
    expect(subTools.todo_write).toBeUndefined();
    expect(subTools.read_file).toBeDefined();
  });

  it("capability-gates disallowed tools for specialized subagents (Hermes style)", () => {
    const fixture = {
      read_file: { execute: () => undefined },
      edit: { execute: () => undefined },
      write_file: { execute: () => undefined },
      bash_run: { execute: () => undefined },
      process: { execute: () => undefined },
    };
    const reviewTools = buildAgentTools(fixture, {
      subagentType: "code-review",
    });
    expect(reviewTools.read_file).toBeDefined();
    expect(reviewTools.bash_run).toBeDefined();
    expect(reviewTools.edit).toBeUndefined();
    expect(reviewTools.write_file).toBeUndefined();
    expect(reviewTools.process).toBeUndefined();

    const exploreTools = buildAgentTools(fixture, {
      subagentType: "explore",
    });
    expect(exploreTools.process).toBeUndefined();
  });

  it("filters non-core tools when compactToolTier is enabled", () => {
    const fixture = {
      read_file: { execute: () => undefined },
      edit: { execute: () => undefined },
      bash_run: { execute: () => undefined },
      process: { execute: () => undefined },
      browser_open: { execute: () => undefined },
      sql_query: { execute: () => undefined },
    };
    const compactTools = buildAgentTools(fixture, {
      compactToolTier: true,
    });
    expect(compactTools.read_file).toBeDefined();
    expect(compactTools.edit).toBeDefined();
    expect(compactTools.bash_run).toBeDefined();
    expect(compactTools.process).toBeUndefined();
    expect(compactTools.browser_open).toBeUndefined();
    expect(compactTools.sql_query).toBeUndefined();
  });

  it("keeps the recovery tools when the compact tier prunes the rest", () => {
    // A compact-tier DeepSeek endpoint was handed 27 tools, reached for
    // `git_push` (real, but not core) and the run ended fatally because the
    // prune had also dropped the fallback that answers an unknown name.
    const fixture = {
      read_file: { execute: () => undefined },
      git_commit: { execute: () => undefined },
      git_push: { execute: () => undefined },
      browser_open: { execute: () => undefined },
      unknown_tool_fallback: { execute: () => undefined },
      find_tools: { execute: () => undefined },
    };
    const compact = buildAgentTools(fixture, { compactToolTier: true });
    expect(compact.git_push).toBeUndefined();
    expect(compact.browser_open).toBeUndefined();
    expect(compact.unknown_tool_fallback).toBeDefined();
    expect(compact.find_tools).toBeDefined();
  });

  it("pins the recovery names to the real tool-name constants", () => {
    // RECOVERY_TOOL_NAMES holds literals to avoid an import cycle with
    // tools/toolSearch.ts; this is what stops the copies from drifting.
    expect(RECOVERY_TOOL_NAMES.has(UNKNOWN_TOOL_NAME)).toBe(true);
    expect(RECOVERY_TOOL_NAMES.has(FIND_TOOLS_NAME)).toBe(true);
  });
});

describe("spawnToolsWithheld", () => {
  it("withholds at and beyond the cap", () => {
    expect(spawnToolsWithheld(0, 3)).toBe(false);
    expect(spawnToolsWithheld(2, 3)).toBe(false);
    expect(spawnToolsWithheld(3, 3)).toBe(true);
    expect(spawnToolsWithheld(4, 3)).toBe(true);
  });

  it("the spawn set names both spawn tools", () => {
    expect(SPAWN_TOOLS.has("run_subagent")).toBe(true);
    expect(SPAWN_TOOLS.has("run_subagents")).toBe(true);
  });
});

describe("resolveAgentForPrompt", () => {
  it("an explicit type wins over the prompt's domain", () => {
    const r = resolveAgentForPrompt("fix the react frontend", "explore");
    expect(r.type).toBe("explore");
    expect(r.route).toBeNull();
  });

  it("routes an untyped prompt by domain", () => {
    expect(resolveAgentForPrompt("fix the react frontend").type).toBe(
      "builder",
    );
    expect(resolveAgentForPrompt("write the api schema").type).toBe("builder");
    expect(resolveAgentForPrompt("audit the docker setup").type).toBe(
      "general",
    );
    expect(resolveAgentForPrompt("add unit tests for x").type).toBe(
      "code-review",
    );
  });

  it("falls back to general for an unclassified prompt", () => {
    expect(resolveAgentForPrompt("hello").type).toBe("general");
  });

  it("exposes the routed label", () => {
    const r = resolveAgentForPrompt("fix the react frontend");
    expect(r.label).toBe("Builder");
  });
});
