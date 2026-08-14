import { describe, expect, it, vi } from "vitest";

const list = vi.fn();
const getRuntime = vi.fn();
vi.mock("@/modules/extensions/registries", () => ({
  aiToolsRegistry: {
    list: () => list(),
    getRuntime: (...a: unknown[]) => getRuntime(...a),
  },
}));

import {
  buildExtensionTools,
  describeExtTool,
  extToolSchema,
} from "./extensionTools";
import { extToolName, isExtensionTool, parseExtToolName } from "./extensionToolNames";

const schema = { type: "object", properties: { q: { type: "string" } } };

function declared(name: string, approval: "auto" | "needsApproval" = "auto") {
  return {
    extensionId: "my_ext",
    item: { name, description: "does a thing", parameters: schema, approval },
  };
}

function exec(tools: Record<string, unknown>, name: string, args: unknown) {
  const t = tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> };
  return t.execute(args, {});
}

describe("names", () => {
  it("round-trips", () => {
    const n = extToolName("my_ext", "do_thing");
    expect(isExtensionTool(n)).toBe(true);
    expect(parseExtToolName(n)).toEqual({ extensionId: "my_ext", tool: "do_thing" });
  });

  // Extension ids contain underscores, so splitting on the first `__` would
  // attribute the tool to the wrong extension.
  it("splits on the last separator", () => {
    expect(parseExtToolName("ext__my_ext__do_thing")).toEqual({
      extensionId: "my_ext",
      tool: "do_thing",
    });
  });

  it("does not claim a core tool", () => {
    expect(isExtensionTool("read_file")).toBe(false);
  });
});

describe("extToolSchema", () => {
  it("passes a usable object schema through", () => {
    expect(extToolSchema(schema)).toBe(schema);
  });

  // A bad schema from a third-party extension must not read as a Termigo bug.
  it("degrades anything unusable", () => {
    for (const bad of [undefined, null, "nope", { type: "string" }, {}]) {
      expect(extToolSchema(bad)).toEqual({
        type: "object",
        properties: {},
        additionalProperties: true,
      });
    }
  });
});

describe("describeExtTool", () => {
  it("names the extension so the origin is visible to the model", () => {
    expect(describeExtTool("my_ext", "does a thing", false)).toContain('"my_ext"');
  });

  it("says when it will ask", () => {
    expect(describeExtTool("e", "d", true)).toContain("approval");
    expect(describeExtTool("e", "d", false)).not.toContain("approval");
  });
});

describe("buildExtensionTools", () => {
  it("builds one prefixed tool per contribution", () => {
    list.mockReturnValue([declared("do_thing")]);
    expect(Object.keys(buildExtensionTools())).toEqual(["ext__my_ext__do_thing"]);
  });

  it("honours the declared approval preference", () => {
    list.mockReturnValue([declared("a", "auto"), declared("b", "needsApproval")]);
    const tools = buildExtensionTools();
    expect((tools["ext__my_ext__a"] as { needsApproval: boolean }).needsApproval).toBe(
      false,
    );
    expect((tools["ext__my_ext__b"] as { needsApproval: boolean }).needsApproval).toBe(
      true,
    );
  });

  it("skips a contribution missing its name or description", () => {
    list.mockReturnValue([
      { extensionId: "e", item: { name: "", description: "d", parameters: schema } },
      { extensionId: "e", item: { name: "n", description: "", parameters: schema } },
    ]);
    expect(buildExtensionTools()).toEqual({});
  });

  it("calls the handler bound for that tool", async () => {
    list.mockReturnValue([declared("do_thing")]);
    getRuntime.mockReturnValue(async (a: Record<string, unknown>) => ({ got: a.q }));
    const out = await exec(buildExtensionTools(), "ext__my_ext__do_thing", { q: "hi" });
    expect(out).toEqual({ got: "hi" });
    expect(getRuntime).toHaveBeenCalledWith("my_ext", "do_thing");
  });

  // Declared in the manifest but never bound, or disabled mid-run.
  it("explains a tool with no handler instead of crashing", async () => {
    list.mockReturnValue([declared("do_thing")]);
    getRuntime.mockReturnValue(undefined);
    const out = await exec(buildExtensionTools(), "ext__my_ext__do_thing", {});
    expect(String((out as { error: string }).error)).toContain("no handler");
  });

  // A broken extension should cost its own tool call, not the whole run.
  it("returns a handler failure to the model", async () => {
    list.mockReturnValue([declared("do_thing")]);
    getRuntime.mockReturnValue(() => {
      throw new Error("extension blew up");
    });
    const out = await exec(buildExtensionTools(), "ext__my_ext__do_thing", {});
    expect(String((out as { error: string }).error)).toContain("extension blew up");
  });
});
