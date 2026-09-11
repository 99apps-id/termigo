// The tool payload is ~79 KB of JSON Schema on every request, so how it is
// gated and how it is measured are both worth locking down.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CORE_TOOL_NAMES } from "../agents/agentFactory";
import { measureToolPayload, toolPayloadBytes } from "../lib/toolPayload";
import {
  applyDisabledToolGroups,
  groupedToolNames,
  groupUsage,
  isToolGroupId,
  TOOL_GROUPS,
} from "./toolGroups";
import { buildTools, type ToolContext } from "./tools";

function stubContext(): ToolContext {
  return {
    getCwd: () => "C:/project/termigo",
    getRemoteSession: () => null,
    getWorkspaceRoot: () => "C:/project/termigo",
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    openPreview: () => false,
    openCanvas: () => false,
    browserOpen: async () => ({ ok: true }) as never,
    browserNavigate: async () => ({ ok: true }) as never,
    browserBack: async () => ({ ok: true }) as never,
    browserForward: async () => ({ ok: true }) as never,
    browserReload: async () => ({ ok: true }) as never,
    browserExtract: async () => ({ text: "" }),
    browserEval: async () => ({ ok: true }) as never,
    browserScreenshot: async () => ({ screenshot: "" }),
    browserConsole: async () => ({ console: "" }),
    browserUrl: async () => ({ url: "" }),
    browserClose: async () => ({ ok: true }) as never,
    browserList: async () => [],
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache: new Map(),
    getSessionId: () => "s-test",
  } as unknown as ToolContext;
}

const built = buildTools(stubContext());

/** A group by id, failing loudly so a rename cannot make a test silently empty. */
function group(id: string) {
  const found = TOOL_GROUPS.find((g) => g.id === id);
  if (!found) throw new Error(`no tool group "${id}"`);
  return found;
}

describe("tool group definitions", () => {
  it("are disjoint, so disabling one cannot remove another's tools", () => {
    const seen = new Map<string, string>();
    for (const group of TOOL_GROUPS) {
      for (const name of group.tools) {
        const previous = seen.get(name);
        expect(
          previous,
          `"${name}" is in both "${previous}" and "${group.id}"`,
        ).toBeUndefined();
        seen.set(name, group.id);
      }
    }
  });

  it("never list a core-loop tool", () => {
    // A toggle that can remove write_file or bash_run is a foot gun.
    for (const group of TOOL_GROUPS) {
      for (const name of group.tools) {
        expect(
          CORE_TOOL_NAMES.has(name),
          `"${name}" is core but is gated by "${group.id}"`,
        ).toBe(false);
      }
    }
  });

  it("only list tools that actually exist", () => {
    // Catches a rename or a typo: a group whose tools no longer exist would
    // silently stop saving anything.
    const missing: string[] = [];
    for (const group of TOOL_GROUPS) {
      for (const name of group.tools) {
        if (!(name in built)) missing.push(`${group.id}:${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("has unique ids and validates them", () => {
    const ids = TOOL_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(isToolGroupId(ids[0])).toBe(true);
    expect(isToolGroupId("nope")).toBe(false);
  });

  it("covers every non-core tool", () => {
    // A tool nobody can turn off is a tool everyone pays for forever. The
    // allowlist is explicit: adding a tool means deciding which it is.
    const intentionallyAlwaysOn = new Set([
      // Core file / shell / search / edit loop.
      "read_file",
      "read_image",
      "write_file",
      "edit",
      "multi_edit",
      "create_directory",
      "list_directory",
      "glob",
      "grep",
      "code_search",
      "code_index",
      "bash_run",
      "bash_background",
      "bash_wait",
      "bash_logs",
      "bash_list",
      "bash_kill",
      "get_terminal_output",
      "run_checks",
      "test_file",
      "format_code",
      "todo_write",
      "ask_user",
      "run_subagent",
      "run_subagents",
      "unknown_tool_fallback",
      // File operations that belong to the same loop as write_file.
      "copy_file",
      "move_file",
      "delete_file",
      "replace_in_files",
      "revert_changes",
      "review_changes",
      "review_run",
      "context_report",
      "plan_mode",
      // Git is the project's safety net (checkpoints, diffs, rollback).
      "git_status",
      "git_diff",
      "git_log",
      "git_show",
      "git_blame",
      "git_branch",
      "git_checkpoint",
      "git_commit",
      "git_stash",
      "git_stash_pop",
      "git_pull",
      "git_push",
      "git_pr",
      // Ambient context that costs little and is used constantly.
      "env_get",
      "env_list",
      "clipboard_get",
      "clipboard_set",
      "suggest_command",
      "process",
      "process_port",
      "forward_remote_port",
      "mcp_auth",
    ]);
    const covered = groupedToolNames();
    const uncovered = Object.keys(built).filter(
      (n) => !covered.has(n) && !intentionallyAlwaysOn.has(n),
    );
    expect(uncovered).toEqual([]);
  });
});

describe("applyDisabledToolGroups", () => {
  it("returns the toolset untouched when nothing is disabled", () => {
    expect(applyDisabledToolGroups(built, [])).toBe(built);
  });

  it("removes exactly the disabled group's tools", () => {
    const target = group("browser");
    const out = applyDisabledToolGroups(built, ["browser"]);
    for (const name of target.tools) expect(out[name]).toBeUndefined();
    // Everything else survives.
    expect(Object.keys(out).length).toBe(
      Object.keys(built).length - target.tools.length,
    );
    expect(out.read_file).toBeDefined();
    expect(out.git_commit).toBeDefined();
  });

  it("is a no-op for an unknown id", () => {
    const out = applyDisabledToolGroups(built, ["does-not-exist"]);
    expect(Object.keys(out).length).toBe(Object.keys(built).length);
  });

  it("never removes a core tool even if a group asked for one", () => {
    // Guard the guard: build a synthetic group that overlaps the core set.
    const out = applyDisabledToolGroups(
      { read_file: 1, bash_run: 1, browser_open: 1 },
      ["browser"],
    );
    expect(out.read_file).toBeDefined();
    expect(out.bash_run).toBeDefined();
    expect(out.browser_open).toBeUndefined();
  });

  it("keeps a usable core with every group disabled", () => {
    const out = applyDisabledToolGroups(
      built,
      TOOL_GROUPS.map((g) => g.id),
    );
    // The coding loop must survive turning everything optional off.
    for (const name of [
      "read_file",
      "write_file",
      "edit",
      "grep",
      "bash_run",
    ]) {
      expect(out[name], `${name} must survive`).toBeDefined();
    }
    expect(Object.keys(out).length).toBeGreaterThan(40);
  });

  it("saves a substantial share of the payload when everything is off", () => {
    const all = measureToolPayload(built);
    const minimal = measureToolPayload(
      applyDisabledToolGroups(
        built,
        TOOL_GROUPS.map((g) => g.id),
      ),
    );
    // The optional domains are worth at least a third of the tool block; if a
    // refactor moved tools into core this would fail and say so.
    expect(minimal.bytes).toBeLessThan(all.bytes * 0.7);
  });
});

describe("groupUsage", () => {
  it("counts present tools and their measured bytes", () => {
    const payload = measureToolPayload(built);
    const usage = groupUsage(payload.byTool);
    const browser = usage.find((u) => u.group.id === "browser");
    if (!browser) throw new Error("browser group missing from usage");
    expect(browser.present).toBe(browser.group.tools.length);
    expect(browser.bytes).toBeGreaterThan(0);

    // Sorted by cost, so the biggest win is offered first.
    for (let i = 1; i < usage.length; i++) {
      expect(usage[i - 1].bytes).toBeGreaterThanOrEqual(usage[i].bytes);
    }
  });

  it("reports zero for a group whose tools are absent", () => {
    const usage = groupUsage([]);
    expect(usage.every((u) => u.bytes === 0 && u.present === 0)).toBe(true);
  });
});

describe("tool payload measurement", () => {
  it("counts the schema, not just the description", () => {
    // The bug this replaced measured descriptions for Zod tools and reported
    // 37 KB where the real block was 79 KB.
    const payload = measureToolPayload(built);
    const descOnly = Object.entries(built).reduce(
      (n, [name, t]) =>
        n +
        JSON.stringify({
          name,
          description: (t as { description?: string }).description,
          schema: null,
        }).length,
      0,
    );
    expect(payload.bytes).toBeGreaterThan(descOnly * 1.5);
    expect(payload.count).toBe(Object.keys(built).length);
  });

  it("measures a jsonSchema() tool from its own schema", () => {
    const tool = {
      description: "mcp tool",
      inputSchema: { jsonSchema: { type: "object", properties: { a: {} } } },
    };
    const r = toolPayloadBytes("mcp__x__y", tool);
    expect(r.exact).toBe(true);
    expect(r.bytes).toBeGreaterThan(40);
  });

  it("measures a Zod tool through its converted JSON Schema", () => {
    const tool = {
      description: "zod tool",
      inputSchema: z.object({ path: z.string(), limit: z.number().optional() }),
    };
    const r = toolPayloadBytes("some_zod_tool", tool);
    expect(r.exact).toBe(true);
    // A converted object schema is far larger than the bare description.
    expect(r.bytes).toBeGreaterThan("zod tool".length + 60);
  });

  it("flags a tool whose schema cannot be measured instead of guessing", () => {
    const r = toolPayloadBytes("broken", { description: "x" });
    expect(r.exact).toBe(false);
    expect(r.bytes).toBeGreaterThan(0);
  });

  it("stays under a budget, so growth is caught here and not in production", () => {
    const payload = measureToolPayload(built);
    const kb = payload.bytes / 1024;
    // Measured at ~79 KB when this guard was written. The ceiling is the point
    // of the test: a feature that adds schemas has to either fit or raise it
    // deliberately, in a diff a reviewer sees.
    expect(kb).toBeLessThan(95);
    // And it must be exact: an unmeasured schema would silently under-report.
    expect(payload.unmeasured).toBe(0);
  });
});
