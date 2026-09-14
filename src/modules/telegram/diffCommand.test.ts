import { describe, expect, it, vi } from "vitest";
import { buildGitDiffSummary, HELP } from "./telegramCommands";

describe("telegramCommands git diff integration", () => {
  it("includes /diff in HELP list", () => {
    expect(HELP).toContain("/diff - view git status & changed files");
  });

  it("builds git diff summary gracefully even when git status is empty or fails", async () => {
    // Should never throw, returns descriptive string
    const summary = await buildGitDiffSummary();
    expect(typeof summary).toBe("string");
    expect(summary.length).toBeGreaterThan(0);
  });
});
