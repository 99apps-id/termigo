import { describe, expect, it } from "vitest";
import {
  applyProfileToStepBudget,
  applyProfileToSystem,
  applyProfileToTools,
  DEFAULT_PROFILE_ID,
  getProfile,
  type HarnessProfile,
} from "./harnessProfile";

const profile = (over: Partial<HarnessProfile> = {}): HarnessProfile => ({
  id: "test",
  label: "Test",
  description: "",
  ...over,
});

describe("getProfile", () => {
  it("falls back to the balanced default for unknown inputs", () => {
    expect(getProfile(null).id).toBe(DEFAULT_PROFILE_ID);
    expect(getProfile("").id).toBe(DEFAULT_PROFILE_ID);
    expect(getProfile("nope").id).toBe(DEFAULT_PROFILE_ID);
  });

  it("resolves a known profile", () => {
    expect(getProfile("no_todo").id).toBe("no_todo");
  });
});

describe("applyProfileToSystem", () => {
  it("prepends the prelude to a string system", () => {
    const out = applyProfileToSystem(
      "base",
      profile({ promptPrelude: "PLAN" }),
    );
    expect(out).toBe("PLAN\n\nbase");
  });

  it("prepends a system message when given an array", () => {
    const out = applyProfileToSystem(
      [{ role: "system", content: "base" }] as never,
      profile({ promptPrelude: "PLAN" }),
    ) as Array<{ role: string; content: string }>;
    expect(out[0]).toEqual({ role: "system", content: "PLAN" });
    expect(out[1]).toEqual({ role: "system", content: "base" });
  });

  it("returns the system unchanged when there is no prelude", () => {
    const base = "base";
    expect(applyProfileToSystem(base, profile())).toBe(base);
  });
});

describe("applyProfileToTools", () => {
  it("hides tools named in hideTools", () => {
    const out = applyProfileToTools(
      { a: 1, todo_write: 2, b: 3 },
      profile({ hideTools: ["todo_write"] }),
    );
    expect(out).toEqual({ a: 1, b: 3 });
  });

  it("moves prioritized tools earlier", () => {
    const out = applyProfileToTools(
      { read_file: 1, bash_run: 2, glob: 3 },
      profile({ prioritizeTools: ["bash_run"] }),
    );
    expect(Object.keys(out)).toEqual(["bash_run", "glob", "read_file"]);
  });
});

describe("applyProfileToStepBudget", () => {
  it("applies a delta", () => {
    expect(applyProfileToStepBudget(24, profile({ stepBudgetDelta: -6 }))).toBe(
      18,
    );
  });

  it("caps at budgetCap", () => {
    expect(
      applyProfileToStepBudget(
        40,
        profile({ stepBudgetDelta: -6, stepBudgetCap: 16 }),
      ),
    ).toBe(16);
  });

  it("never goes below 1", () => {
    expect(applyProfileToStepBudget(3, profile({ stepBudgetDelta: -6 }))).toBe(
      1,
    );
  });
});
