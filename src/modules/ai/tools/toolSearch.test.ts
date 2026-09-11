// Lazy tool loading. The failure modes worth locking down are not the ranking
// details but the two ways this can silently break the agent:
//
//   1. A tool that is neither always-on nor discoverable is UNREACHABLE - the
//      model can never call it, and nothing in the UI says so.
//   2. Search mode saves nothing, because the always-on set grew to the whole
//      toolset.
//
// Both are asserted below against the real built toolset.

import { describe, expect, it } from "vitest";
import { measureToolPayload } from "../lib/toolPayload";
import {
  buildFindToolsTool,
  buildToolIndex,
  FIND_TOOLS_NAME,
  indexCategories,
  runFindTools,
  searchToolIndex,
  TOOL_SEARCH_ALWAYS_ON,
  type ToolIndexEntry,
} from "./toolSearch";
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
const index = buildToolIndex(built);

/** A tiny index for the ranking tests, so they do not depend on the real set. */
const sampleIndex: ToolIndexEntry[] = [
  { name: "browser_open", summary: "Open a browser window at a URL." },
  { name: "browser_click", summary: "Click an element on the page." },
  { name: "browser_screenshot", summary: "Capture the page as an image." },
  { name: "run_sql", summary: "Run a query against a database CLI." },
  { name: "read_pdf", summary: "Extract text from a PDF file." },
];

describe("buildToolIndex", () => {
  it("keeps every deferred tool reachable", () => {
    // The invariant: nothing may be both invisible and unfindable.
    const unreachable = Object.keys(built).filter(
      (name) =>
        name !== FIND_TOOLS_NAME &&
        !TOOL_SEARCH_ALWAYS_ON.has(name) &&
        !index.some((e) => e.name === name),
    );
    expect(unreachable).toEqual([]);
  });

  it("leaves the always-on tools out, since they are already visible", () => {
    for (const name of TOOL_SEARCH_ALWAYS_ON) {
      expect(index.some((e) => e.name === name), `${name} should not be indexed`)
        .toBe(false);
    }
  });

  it("does not index the discovery tool itself", () => {
    expect(index.some((e) => e.name === FIND_TOOLS_NAME)).toBe(false);
  });

  it("carries a one-line summary, not the whole description", () => {
    for (const entry of index) {
      expect(entry.summary.length).toBeLessThanOrEqual(141);
      // Never longer than the source, and shorter whenever the description
      // runs past the first sentence.
      const full = (built[entry.name] as { description?: string }).description;
      if (full) {
        expect(entry.summary.length).toBeLessThanOrEqual(full.length);
        const sentences = (full.match(/\.\s/g) ?? []).length;
        if (sentences > 0) {
          expect(entry.summary.length).toBeLessThan(full.length);
        }
      }
    }
  });

  it("covers the domains the model would look for by name", () => {
    const names = index.map((e) => e.name);
    for (const expected of [
      "browser_open",
      "browser_screenshot",
      "github_create_pr",
      "lsp_diagnostics",
      "run_sql",
      "read_pdf",
      "web_search",
      "worktree_create",
    ]) {
      expect(names, `${expected} must be discoverable`).toContain(expected);
    }
  });

  it("names categories for the hint and the tool description", () => {
    const cats = indexCategories(index);
    expect(cats).toContain("browser");
    expect(cats).toContain("github");
    expect(cats.length).toBeGreaterThan(10);
    // Sorted and unique, so the description is stable across runs.
    expect([...cats].sort()).toEqual(cats);
    expect(new Set(cats).size).toBe(cats.length);
  });

  it("respects a caller-supplied always-on set", () => {
    const custom = buildToolIndex(built, new Set(["browser_open"]));
    expect(custom.some((e) => e.name === "browser_open")).toBe(false);
    expect(custom.some((e) => e.name === "browser_click")).toBe(true);
  });
});

describe("searchToolIndex", () => {
  it("finds an exact tool name first", () => {
    const hits = searchToolIndex(sampleIndex, "run_sql");
    expect(hits[0].name).toBe("run_sql");
  });

  it("matches a bare keyword across a domain", () => {
    const hits = searchToolIndex(sampleIndex, "browser");
    // Every browser tool is returned; the order inside a domain is a detail
    // (a summary that repeats the keyword scores higher, see below).
    expect([...hits.map((h) => h.name)].sort()).toEqual([
      "browser_click",
      "browser_open",
      "browser_screenshot",
    ]);
    expect(hits).toHaveLength(3);
  });

  it("ranks a name match above a summary-only match", () => {
    // "open" is in browser_open's name; nothing else has it in the name, so it
    // must come first, ahead of tools that merely mention it in prose.
    const hits = searchToolIndex(sampleIndex, "open");
    expect(hits[0].name).toBe("browser_open");
  });

  it("matches the keyword with separators ignored", () => {
    // A model may write "screenshot" while the tool is browser_screenshot.
    const hits = searchToolIndex(sampleIndex, "screenshot");
    expect(hits.map((h) => h.name)).toContain("browser_screenshot");
  });

  it("falls back to the summary text", () => {
    const hits = searchToolIndex(sampleIndex, "database");
    expect(hits.map((h) => h.name)).toEqual(["run_sql"]);
  });

  it("returns nothing for an unknown word rather than guessing", () => {
    expect(searchToolIndex(sampleIndex, "kubernetes")).toEqual([]);
  });

  it("ignores single-character noise and empty queries", () => {
    expect(searchToolIndex(sampleIndex, "")).toEqual([]);
    expect(searchToolIndex(sampleIndex, "  ")).toEqual([]);
    expect(searchToolIndex(sampleIndex, "a")).toEqual([]);
  });

  it("honours the limit and always returns at least one on a hit", () => {
    expect(searchToolIndex(sampleIndex, "browser", 2)).toHaveLength(2);
    expect(searchToolIndex(sampleIndex, "browser", 1)).toHaveLength(1);
    expect(searchToolIndex(sampleIndex, "run_sql", 0)).toHaveLength(1);
  });

  it("is deterministic", () => {
    const a = searchToolIndex(index, "browser");
    const b = searchToolIndex(index, "browser");
    expect(a).toEqual(b);
  });
});

describe("runFindTools", () => {
  it("reports the matches and tells the model to call them directly", () => {
    const out = runFindTools(sampleIndex, "browser");
    expect([...out.matched].sort()).toEqual([
      "browser_click",
      "browser_open",
      "browser_screenshot",
    ]);
    expect(out.note).toContain("now available");
    expect(out.tools).toHaveLength(3);
    expect(out.tools[0]).toHaveProperty("summary");
  });

  it("lists the categories when nothing matches", () => {
    // A dead end must tell the model what it CAN ask for, or it gives up and
    // reports the capability as missing.
    const out = runFindTools(sampleIndex, "kubernetes");
    expect(out.matched).toEqual([]);
    expect(out.note).toContain("No tool matches");
    expect(out.note).toContain("browser");
    expect(out.note).toContain("Available categories");
  });

  it("passes a missing query through to the same dead end", () => {
    const out = runFindTools(sampleIndex, "");
    expect(out.matched).toEqual([]);
    expect(out.note).toContain("Available categories");
  });
});

describe("buildFindToolsTool", () => {
  it("hands the matched names to discover so they become active", async () => {
    const discovered: string[][] = [];
    const t = buildFindToolsTool({
      index: sampleIndex,
      discover: (names) => discovered.push([...names]),
    });
    const execute = t.execute;
    if (!execute) throw new Error("find_tools has no execute");
    await execute({ query: "sql" }, {} as never);
    expect(discovered).toEqual([["run_sql"]]);
  });

  it("does not report a discovery when nothing matched", async () => {
    const discovered: string[][] = [];
    const t = buildFindToolsTool({
      index: sampleIndex,
      discover: (names) => discovered.push([...names]),
    });
    const execute = t.execute;
    if (!execute) throw new Error("find_tools has no execute");
    await execute({ query: "kubernetes" }, {} as never);
    expect(discovered).toEqual([]);
  });

  it("advertises the categories in its own description", () => {
    const t = buildFindToolsTool({ index, discover: () => {} });
    const description = (t as { description?: string }).description ?? "";
    expect(description).toContain("browser");
    expect(description).toContain(FIND_TOOLS_NAME === "find_tools" ? "keyword" : "");
  });
});

describe("search mode saves what it claims", () => {
  it("keeps the always-on set small against the real toolset", () => {
    const total = Object.keys(built).length;
    const alwaysOn = Object.keys(built).filter((n) =>
      TOOL_SEARCH_ALWAYS_ON.has(n),
    );
    // If this creeps toward the whole set, lazy loading has stopped paying.
    expect(alwaysOn.length).toBeLessThan(total * 0.6);
    expect(alwaysOn.length).toBeGreaterThan(15);
  });

  it("cuts the tool payload by at least a third", () => {
    const alwaysOnTools = Object.fromEntries(
      Object.entries(built).filter(([n]) => TOOL_SEARCH_ALWAYS_ON.has(n)),
    );
    // Plus the discovery tool the run actually sends.
    const withDiscovery = {
      ...alwaysOnTools,
      [FIND_TOOLS_NAME]: buildFindToolsTool({ index, discover: () => {} }),
    };
    const full = measureToolPayload(built);
    const searchMode = measureToolPayload(withDiscovery);
    expect(searchMode.bytes).toBeLessThan(full.bytes * 0.67);
    // And the discovery tool must stay cheap, or it eats the saving.
    const discoveryOnly = measureToolPayload({
      [FIND_TOOLS_NAME]: withDiscovery[FIND_TOOLS_NAME],
    });
    expect(discoveryOnly.bytes).toBeLessThan(1500);
  });

  it("keeps full capability, unlike the compact tier", () => {
    // Search mode must not be a degraded mode: the interaction and file-op
    // tools the compact tier drops have to stay available.
    for (const name of [
      "read_file",
      "write_file",
      "edit",
      "grep",
      "bash_run",
      "run_subagents",
      "ask_user",
      "delete_file",
      "test_file",
    ]) {
      expect(
        TOOL_SEARCH_ALWAYS_ON.has(name),
        `${name} must stay in search mode`,
      ).toBe(true);
    }
  });
});
