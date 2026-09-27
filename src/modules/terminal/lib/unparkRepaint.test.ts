import { describe, expect, it } from "vitest";
import { shouldRepaintOnUnpark, type UnparkRepaintState } from "./unparkRepaint";

const base: UnparkRepaintState = {
  wasParked: true,
  currentLeafId: 7,
  rows: 24,
};

describe("shouldRepaintOnUnpark", () => {
  it("repaints a slot that just came back from display:none", () => {
    expect(shouldRepaintOnUnpark(base)).toBe(true);
  });

  // The regression this guards: repainting on every un-park call, including for
  // a slot that was never hidden, would repaint the visible terminal on each
  // tab switch for no reason.
  it("does nothing for a slot that was not parked", () => {
    expect(shouldRepaintOnUnpark({ ...base, wasParked: false })).toBe(false);
  });

  it("does nothing for an unbound slot", () => {
    expect(shouldRepaintOnUnpark({ ...base, currentLeafId: null })).toBe(false);
  });

  it("does nothing for a zero-row grid", () => {
    expect(shouldRepaintOnUnpark({ ...base, rows: 0 })).toBe(false);
  });
});
