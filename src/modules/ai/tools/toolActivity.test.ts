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
// `withToolLifecycle` wraps every tool, so marking activity there is what makes
// the clock mean "the run is doing something" instead of "the model is talking".
// This test pins that wiring: without it, deleting the heartbeat leaves every
// other test in the suite passing.
//
// The wrapper is exercised directly rather than through `buildTools`, so no
// store, background timer, or `window` is involved.

import { afterEach, describe, expect, it } from "vitest";
import { msSinceActivity, resetRunActivity } from "../lib/streamWatchdog";
import { withToolLifecycle } from "./tools";

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
