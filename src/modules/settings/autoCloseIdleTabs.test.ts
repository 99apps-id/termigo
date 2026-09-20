import {
  AUTO_CLOSE_IDLE_TABS_MAX_MINUTES,
  AUTO_CLOSE_IDLE_TABS_PRESETS,
  clampAutoCloseIdleTabs,
  DEFAULT_PREFERENCES,
} from "./store";
import { describe, expect, it } from "vitest";

describe("clampAutoCloseIdleTabs", () => {
  it("keeps a positive whole number of minutes", () => {
    expect(clampAutoCloseIdleTabs(30)).toBe(30);
    expect(clampAutoCloseIdleTabs(14.6)).toBe(15);
  });

  it("maps zero, negatives and non-finite values to off", () => {
    expect(clampAutoCloseIdleTabs(0)).toBe(0);
    expect(clampAutoCloseIdleTabs(-5)).toBe(0);
    expect(clampAutoCloseIdleTabs(Number.NaN)).toBe(0);
    expect(clampAutoCloseIdleTabs(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("caps runaway values", () => {
    expect(clampAutoCloseIdleTabs(AUTO_CLOSE_IDLE_TABS_MAX_MINUTES + 1)).toBe(
      AUTO_CLOSE_IDLE_TABS_MAX_MINUTES,
    );
  });

  it("offers a preset for every state including never", () => {
    expect(AUTO_CLOSE_IDLE_TABS_PRESETS).toContain(0);
    expect(AUTO_CLOSE_IDLE_TABS_PRESETS.every((m) => m >= 0)).toBe(true);
  });
});

describe("idle cleanup defaults", () => {
  // Both features are destructive or behaviour-changing, so shipping them on
  // would surprise an existing user; these assertions are the opt-in contract.
  it("ships with the reaper off and LSP idle shutdown off", () => {
    expect(DEFAULT_PREFERENCES.autoCloseIdleTabsMinutes).toBe(0);
    expect(DEFAULT_PREFERENCES.lspIdleShutdown).toBe(false);
  });
});
