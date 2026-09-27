// The run's activity clock has to be fed by the TOOL layer, not only by the
// model's stream.
//
// The watchdog watches chunks, and a tool produces none while it works: a build,
// a scan, a subagent fan-out is silent for minutes by design. The failure that
// motivated this was an approval resume, where step 0 executes the approved tool
// before the model is called at all - the watchdog was armed from the previous
// round (its `tool-call` disarm belongs to that round), so the watchdog aborted
// the live tool at the silence budget, the tool's own timeout result never
// reached the model, and the same request was re-sent every few minutes.
//
// `withToolLifecycle` wraps every tool `buildTools` creates, and
// `withToolHeartbeat` covers the MCP / extension / custom toolsets that arrive
// from outside it. Together they are what makes the clock mean "the run is doing
// something" instead of "the model is talking". This test pins that wiring:
// without it, deleting either heartbeat leaves every other test in the suite
// passing.
//
// The wrappers are exercised directly rather than through `buildTools`, so no
// store, background timer, or `window` is involved.

import { afterEach, describe, expect, it } from "vitest";
import { msSinceActivity, resetRunActivity } from "../lib/streamWatchdog";
import { withToolHeartbeat, withToolLifecycle } from "./tools";

const TOOL = {
  execute: async (_args: Record<string, unknown>) => "ok",
};

describe("a wrapped tool feeds the run's activity clock", () => {
  afterEach(() => resetRunActivity());

  it("reports activity after the tool ran, though it sent no chunks", async () => {
    resetRunActivity();
    expect(msSinceActivity()).toBe(Number.POSITIVE_INFINITY);

    const wrapped = withToolLifecycle("probe", TOOL, {});
    await wrapped.execute({}, {});

    expect(Number.isFinite(msSinceActivity())).toBe(true);
  });

  it("reports activity even when the tool throws", async () => {
    // A failing tool is still the run doing something; treating it as silence
    // would abort the run that is about to handle the error.
    resetRunActivity();
    const boom = withToolLifecycle(
      "probe",
      {
        execute: async () => {
          throw new Error("tool failed");
        },
      },
      {},
    );
    await expect(boom.execute({}, {})).rejects.toThrow("tool failed");
    expect(Number.isFinite(msSinceActivity())).toBe(true);
  });

  it("still fires the lifecycle hooks around the tool", async () => {
    const calls: string[] = [];
    const wrapped = withToolLifecycle("probe", TOOL, {
      firePreToolHook: async () => {
        calls.push("pre");
      },
      firePostToolHook: async () => {
        calls.push("post");
      },
    });
    await wrapped.execute({ a: 1 }, {});
    expect(calls).toEqual(["pre", "post"]);
  });

  it("keeps the tool's own result unchanged", async () => {
    const wrapped = withToolLifecycle("probe", TOOL, {});
    await expect(wrapped.execute({}, {})).resolves.toBe("ok");
  });
});

// The toolsets that do not come from `buildTools`: their tools were spread into
// the run's toolset raw, so nothing fed the activity clock while they worked and
// a call that outlived the execution guard was aborted as a hung tool.
describe("withToolHeartbeat covers tools built outside buildTools", () => {
  afterEach(() => resetRunActivity());

  it("feeds the clock for a toolset that never met withToolLifecycle", async () => {
    resetRunActivity();
    expect(msSinceActivity()).toBe(Number.POSITIVE_INFINITY);

    const tools = withToolHeartbeat({
      "mcp__server__probe": {
        description: "a remote tool",
        inputSchema: { type: "object", properties: {} },
        execute: async () => "remote ok",
      },
    });
    await tools.mcp__server__probe.execute({}, {});

    expect(Number.isFinite(msSinceActivity())).toBe(true);
  });

  it("keeps the schema, the description and the result intact", async () => {
    const schema = { type: "object", properties: { q: { type: "string" } } };
    const tools = withToolHeartbeat({
      probe: {
        description: "describe me",
        inputSchema: schema,
        execute: async () => ({ value: 7 }),
      },
    });

    expect(tools.probe.description).toBe("describe me");
    expect(tools.probe.inputSchema).toBe(schema);
    await expect(tools.probe.execute({}, {})).resolves.toEqual({ value: 7 });
  });

  it("still marks activity when the tool throws", async () => {
    resetRunActivity();
    const tools = withToolHeartbeat({
      probe: {
        execute: async () => {
          throw new Error("remote failed");
        },
      },
    });

    await expect(tools.probe.execute({}, {})).rejects.toThrow("remote failed");
    expect(Number.isFinite(msSinceActivity())).toBe(true);
  });

  it("leaves a tool with no execute function alone", () => {
    const onlySchema = { description: "no executor yet" };
    const tools = withToolHeartbeat({ probe: onlySchema });
    expect(tools.probe).toBe(onlySchema);
  });
});
