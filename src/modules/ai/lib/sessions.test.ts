import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import { extractMessageText } from "./sessions";

const msg = (role: "user" | "assistant", ...texts: string[]): UIMessage =>
  ({
    id: `${role}-${texts.join("|")}`,
    role,
    parts: texts.map((text) => ({ type: "text", text })),
  }) as UIMessage;

describe("extractMessageText", () => {
  it("concatenates all text parts across roles, lowercased", () => {
    const text = extractMessageText([
      msg("user", "Deploy the API"),
      msg("assistant", "Running the DEPLOY now"),
    ]);
    expect(text).toContain("deploy the api");
    expect(text).toContain("running the deploy now");
  });

  it("strips injected context wrappers so search matches real content", () => {
    const text = extractMessageText([
      msg(
        "user",
        "<terminal-context>secret-noise</terminal-context>\nfix the bug",
      ),
    ]);
    expect(text).toContain("fix the bug");
    expect(text).not.toContain("secret-noise");
  });

  it("ignores non-text parts and empty conversations", () => {
    const withTool = {
      id: "a",
      role: "assistant",
      parts: [{ type: "tool-invocation", toolName: "bash_run" }],
    } as unknown as UIMessage;
    expect(extractMessageText([withTool])).toBe("");
    expect(extractMessageText([])).toBe("");
  });
});
