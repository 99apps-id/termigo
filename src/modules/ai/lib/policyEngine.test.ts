import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "./policyEngine";

describe("evaluatePolicy", () => {
  it("allows when no rules match", async () => {
    const result = await evaluatePolicy({
      toolName: "unknown_tool",
      command: "echo hello",
    });
    expect(result.allowed).toBe(true);
  });

  it("blocks when a tool rule matches", async () => {
    const result = await evaluatePolicy({
      toolName: "git_commit",
      command: "git commit -m '[main] fix bug'",
    });
    expect(result.allowed).toBe(false);
    expect((result as { allowed: false; reason: string }).reason).toContain(
      "main",
    );
  });

  it("blocks when a command rule matches", async () => {
    const result = await evaluatePolicy({
      toolName: "git_push",
      command: "git push --force origin feature",
    });
    expect(result.allowed).toBe(false);
    expect((result as { allowed: false; reason: string }).reason).toContain(
      "Force push",
    );
  });

  it("allows when command does not match pattern", async () => {
    const result = await evaluatePolicy({
      toolName: "git_push",
      command: "git push origin feature",
    });
    expect(result.allowed).toBe(true);
  });
});
