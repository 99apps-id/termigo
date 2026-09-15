import { describe, expect, it } from "vitest";
import { buildSteeredContinuationPrompt } from "./steerContinuation";

describe("steerContinuation", () => {
  it("weaves steer interrupt with original task context and progress correctly", () => {
    const prompt = buildSteeredContinuationPrompt({
      originalTask: "Refactor auth middleware to support JWT and OAuth2",
      completedSteps: ["Added JWT parser in auth.ts", "Updated tests in auth.test.ts"],
      currentFilesModified: ["src/auth.ts", "src/auth.test.ts"],
      steerInput: "Don't use OAuth2 library, write a minimal helper instead",
    });

    expect(prompt).toContain("<user_steer_interrupt>");
    expect(prompt).toContain("Don't use OAuth2 library");
    expect(prompt).toContain("Original Goal: Refactor auth middleware");
    expect(prompt).toContain("Added JWT parser in auth.ts");
    expect(prompt).toContain("Files modified so far: src/auth.ts, src/auth.test.ts");
    expect(prompt).toContain("adapt your approach accordingly");
  });

  it("handles steer with only original goal and input without crashing", () => {
    const prompt = buildSteeredContinuationPrompt({
      originalTask: "Fix layout bug",
      steerInput: "Also check dark mode",
    });

    expect(prompt).toContain("<user_steer_interrupt>\nAlso check dark mode\n</user_steer_interrupt>");
    expect(prompt).toContain("Original Goal: Fix layout bug");
    expect(prompt).not.toContain("Progress completed");
    expect(prompt).toContain("Instructions:");
  });
});
