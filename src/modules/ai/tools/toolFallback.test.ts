// Answering a tool call for a name that does not exist.
//
// This is a normal event - a model trained elsewhere reaches for `view_file` or
// `run_command` - and the reply decides whether the run recovers in one step or
// stalls. The bug this replaced was a hardcoded list of 13 tool names, so a
// model asking for a real tool outside those 13 (git_status, run_checks, every
// browser tool) was told it did not exist and gave up on the capability.

import { describe, expect, it } from "vitest";
import { bestToolMatch, editDistance, suggestToolNames } from "../lib/toolNames";
import { buildTools, type ToolContext } from "./tools";
import {
  buildUnknownToolFallback,
  buildUnknownToolMessage,
  UNKNOWN_TOOL_NAME,
} from "./toolFallback";

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

async function callFallback(
  tool: ReturnType<typeof buildTools>[typeof UNKNOWN_TOOL_NAME],
  requested: string,
): Promise<{ error: string; toolDoesNotExist?: boolean }> {
  const execute = tool.execute;
  if (!execute) throw new Error("fallback has no execute");
  return (await execute({ requested_tool: requested }, {} as never)) as {
    error: string;
    toolDoesNotExist?: boolean;
  };
}

describe("editDistance", () => {
  it("is zero for identical strings", () => {
    expect(editDistance("read_file", "read_file")).toBe(0);
  });

  it("counts a single substitution", () => {
    expect(editDistance("cat", "cut")).toBe(1);
  });

  it("counts an insertion", () => {
    expect(editDistance("read", "reads")).toBe(1);
  });

  it("handles the empty string", () => {
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
  });
});

describe("bestToolMatch", () => {
  const available = ["read_file", "write_file", "edit", "bash_run"];

  it("fixes a small typo", () => {
    expect(bestToolMatch("read_fil", available)).toBe("read_file");
  });

  it("refuses to rewrite one real tool into another", () => {
    // The dangerous case: read_file -> write_file would silently write.
    expect(bestToolMatch("read_file", ["write_file"])).toBeNull();
  });

  it("returns null when nothing is close", () => {
    expect(bestToolMatch("kubernetes_deploy", available)).toBeNull();
  });
});

describe("suggestToolNames", () => {
  const available = [
    "read_file",
    "write_file",
    "bash_run",
    "browser_open",
    "browser_click",
    "browser_screenshot",
    "git_status",
    "git_diff",
  ];

  it("suggests by shared word", () => {
    const s = suggestToolNames("browser", available);
    expect(s).toContain("browser_open");
    expect(s).toContain("browser_click");
  });

  it("suggests by near-miss spelling", () => {
    expect(suggestToolNames("read_fil", available)).toContain("read_file");
  });

  it("does not suggest the name that was asked for", () => {
    expect(suggestToolNames("read_file", available)).not.toContain("read_file");
  });

  it("returns nothing for a name with no relation", () => {
    expect(suggestToolNames("kubernetes", available)).toEqual([]);
  });

  it("honours the limit", () => {
    expect(suggestToolNames("browser", available, 1)).toHaveLength(1);
    expect(suggestToolNames("browser", available, 0)).toHaveLength(0);
  });

  it("is deterministic", () => {
    expect(suggestToolNames("git", available)).toEqual(
      suggestToolNames("git", available),
    );
  });

  it("ignores an empty request", () => {
    expect(suggestToolNames("", available)).toEqual([]);
    expect(suggestToolNames("   ", available)).toEqual([]);
  });
});

describe("buildUnknownToolMessage", () => {
  const available = ["read_file", "write_file", "git_status", "bash_run"];

  it("names the requested tool and lists what exists", () => {
    const msg = buildUnknownToolMessage({
      requested: "view_file",
      available,
    });
    expect(msg).toContain('"view_file" does not exist');
    for (const name of available) expect(msg).toContain(name);
  });

  it("tells the model not to retry the same name", () => {
    const msg = buildUnknownToolMessage({
      requested: "view_file",
      available,
    });
    expect(msg).toContain("Do not retry");
  });

  it("points at the equivalent tool when the alias table knows one", () => {
    const msg = buildUnknownToolMessage({
      requested: "view_file",
      available,
      aliasFor: "read_file",
    });
    expect(msg).toContain('the equivalent tool here is "read_file"');
  });

  it("offers a did-you-mean line for a near miss", () => {
    const msg = buildUnknownToolMessage({
      requested: "read_fil",
      available,
    });
    expect(msg).toContain("Did you mean");
    expect(msg).toContain("read_file");
  });

  it("mentions discovery only when the run has it", () => {
    const without = buildUnknownToolMessage({
      requested: "browser_open",
      available,
    });
    expect(without).not.toContain("find_tools");

    const with_ = buildUnknownToolMessage({
      requested: "browser_open",
      available,
      findToolsName: "find_tools",
    });
    expect(with_).toContain("find_tools");
    expect(with_).toContain("on demand");
  });

  it("puts the actionable part first", () => {
    const msg = buildUnknownToolMessage({
      requested: "read_fil",
      available,
    });
    expect(msg.split("\n")[0]).toContain("does not exist");
    expect(msg.split("\n")[1]).toContain("Did you mean");
  });
});

describe("the fallback answers from the real toolset", () => {
  it("is registered under the shared name", () => {
    expect(built[UNKNOWN_TOOL_NAME]).toBeDefined();
  });

  it("lists real tools that the old hardcoded list never mentioned", () => {
    // The regression: this used to answer with 13 fixed names, so a model
    // asking for git_status was told it does not exist.
    return callFallback(built[UNKNOWN_TOOL_NAME], "view_file").then((out) => {
      expect(out.toolDoesNotExist).toBe(true);
      expect(out.error).toContain("git_status");
      expect(out.error).toContain("run_checks");
      expect(out.error).toContain("browser_open");
    });
  });

  it("never claims a tool that does not exist", () => {
    // Every name in the reply must be a real tool.
    return callFallback(built[UNKNOWN_TOOL_NAME], "nope").then((out) => {
      const listed = out.error
        .slice(out.error.indexOf("Tools available in this request: "))
        .replace("Tools available in this request: ", "")
        .replace(/\.$/, "")
        .split(", ");
      for (const name of listed) {
        expect(
          Object.keys(built).includes(name.trim()),
          `${name} is not a real tool`,
        ).toBe(true);
      }
    });
  });

  it("names the equivalent for a known alias", async () => {
    const out = await callFallback(built[UNKNOWN_TOOL_NAME], "view_file");
    expect(out.error).toContain("read_file");
  });

  it("reports the equivalent only when that tool is present", async () => {
    // An alias table is global, but this request may not include the target.
    const t = buildUnknownToolFallback({
      available: () => ["read_file"],
      aliasFor: () => "write_file",
    });
    const execute = t.execute;
    if (!execute) throw new Error("no execute");
    const out = (await execute({ requested_tool: "create_file" }, {} as never)) as {
      error: string;
    };
    expect(out.error).not.toContain("equivalent tool");
    expect(out.error).toContain('"create_file" does not exist');
  });

  it("survives an alias lookup that throws", async () => {
    const t = buildUnknownToolFallback({
      available: () => ["read_file"],
      aliasFor: () => {
        throw new Error("boom");
      },
    });
    const execute = t.execute;
    if (!execute) throw new Error("no execute");
    const out = (await execute({ requested_tool: "view_file" }, {} as never)) as {
      error: string;
    };
    expect(out.error).toContain("does not exist");
  });

  it("echoes the received arguments when they were provided", async () => {
    const execute = built[UNKNOWN_TOOL_NAME].execute;
    if (!execute) throw new Error("no execute");
    const out = (await execute(
      { requested_tool: "view_file", provided_input: '{"path":"a.ts"}' },
      {} as never,
    )) as { receivedInput?: string };
    expect(out.receivedInput).toBe('{"path":"a.ts"}');
  });

  it("caps a huge echoed argument rather than bloating the transcript", async () => {
    const execute = built[UNKNOWN_TOOL_NAME].execute;
    if (!execute) throw new Error("no execute");
    const out = (await execute(
      { requested_tool: "x", provided_input: "z".repeat(5000) },
      {} as never,
    )) as { receivedInput?: string };
    expect(out.receivedInput?.length).toBe(500);
  });
});

describe("search mode wiring", () => {
  it("advertises discovery in the unknown-tool reply", async () => {
    const withDiscovery = buildTools(stubContext(), 0, {
      findToolsName: "find_tools",
    });
    const out = await callFallback(withDiscovery[UNKNOWN_TOOL_NAME], "nope");
    expect(out.error).toContain("find_tools");
  });

  it("does not advertise it when the run loads everything", async () => {
    const out = await callFallback(built[UNKNOWN_TOOL_NAME], "nope");
    expect(out.error).not.toContain("find_tools");
  });
});
