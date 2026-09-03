import { describe, expect, it, vi } from "vitest";
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

  it("blocks data-only rules without evaluate function loaded from JSON", async () => {
    const customPolicyJson = JSON.stringify({
      version: 1,
      rules: [
        {
          id: "no-curl-danger",
          description: "Block raw curl to internal network",
          commands: ["curl http://169.254."],
          block: true,
        },
      ],
    });
    const { native } = await import("./native");
    const spy = vi.spyOn(native, "readFile").mockResolvedValue({
      kind: "text",
      content: customPolicyJson,
      size: customPolicyJson.length,
    });
    try {
      const blocked = await evaluatePolicy({
        command: "curl http://169.254.169.254/latest/meta-data/",
      });
      expect(blocked.allowed).toBe(false);
      expect((blocked as { allowed: false; reason: string }).reason).toContain(
        "internal network",
      );

      // Default policies are still preserved alongside custom ones
      const pushBlocked = await evaluatePolicy({
        toolName: "git_push",
        command: "git push --force",
      });
      expect(pushBlocked.allowed).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
