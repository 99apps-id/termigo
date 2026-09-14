import { describe, expect, it } from "vitest";
import { shouldRecoverWebgl, type WebglRecoveryState } from "./webglRecovery";

/** A slot bound to a visible leaf, which is the case worth recovering. */
const visible: WebglRecoveryState = {
  hasAddon: false,
  currentLeafId: 7,
  parked: false,
};

describe("shouldRecoverWebgl", () => {
  it("recovers a visible slot that lost its renderer", () => {
    expect(shouldRecoverWebgl(visible, true)).toBe(true);
  });

  // The whole point of the guard. rendererPool disposes WebGL for unbound slots
  // after a grace period, so re-attaching here allocates a context that is about
  // to be thrown away - and live contexts are limited per page.
  it("does not recover a slot bound to no leaf", () => {
    expect(shouldRecoverWebgl({ ...visible, currentLeafId: null }, true)).toBe(
      false,
    );
  });

  it("does not recover a parked slot, whose host is hidden", () => {
    expect(shouldRecoverWebgl({ ...visible, parked: true }, true)).toBe(false);
  });

  // attachWebgl already early-returns when attached; recovering would be a
  // no-op at best and a second context at worst.
  it("does nothing when the addon is still attached", () => {
    expect(shouldRecoverWebgl({ ...visible, hasAddon: true }, true)).toBe(
      false,
    );
  });

  // The user's own opt-out outranks every other reason to recover.
  it("honours the WebGL preference above everything else", () => {
    expect(shouldRecoverWebgl(visible, false)).toBe(false);
    expect(
      shouldRecoverWebgl(
        { hasAddon: true, currentLeafId: null, parked: true },
        false,
      ),
    ).toBe(false);
  });

  // The combination that produced the eager version: an unbound slot that also
  // has no addon is still not a candidate.
  it("is false for a fresh idle slot", () => {
    expect(
      shouldRecoverWebgl(
        { hasAddon: false, currentLeafId: null, parked: false },
        true,
      ),
    ).toBe(false);
  });
});
