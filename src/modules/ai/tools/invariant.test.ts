import { describe, expect, it, beforeEach } from "vitest";
import {
  buildInvariantTools,
  formatInvariantsBlock,
  clearPinnedInvariants,
  getPinnedInvariants,
} from "./invariant";

describe("invariant tools", () => {
  beforeEach(() => {
    clearPinnedInvariants();
  });

  it("pins, lists, and formats invariants into prompt block", async () => {
    const tools = buildInvariantTools();
    const pinExec = tools.pin_invariant.execute;
    if (!pinExec) throw new Error("pin_invariant execute missing");

    await pinExec(
      { fact: "Always use pnpm, never npm", category: "constraint" },
      {} as any,
    );

    expect(getPinnedInvariants()).toHaveLength(1);
    const block = formatInvariantsBlock();
    expect(block).toContain("<pinned_invariants>");
    expect(block).toContain("Always use pnpm");

    const unpinExec = tools.unpin_invariant.execute;
    if (!unpinExec) throw new Error("unpin_invariant execute missing");

    const firstId = getPinnedInvariants()[0].id;
    await unpinExec({ id: firstId }, {} as any);
    expect(getPinnedInvariants()).toHaveLength(0);
    expect(formatInvariantsBlock()).toBe("");
  });
});
