import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { splitForEdit } from "./messageEdit";

function userMessage(id: string, text = "hello"): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistantMessage(id: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text: "done" }] };
}

describe("splitForEdit", () => {
  it("returns the messages before an edited user message", () => {
    const messages = [
      userMessage("u1"),
      assistantMessage("a1"),
      userMessage("u2"),
      assistantMessage("a2"),
    ];
    const out = splitForEdit(messages, "u2");
    expect(out?.prefix.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(out?.target.id).toBe("u2");
  });

  it("returns an empty prefix for the first message", () => {
    const out = splitForEdit([userMessage("u1"), assistantMessage("a1")], "u1");
    expect(out?.prefix).toEqual([]);
    expect(out?.target.id).toBe("u1");
  });

  it("returns null for a missing id", () => {
    expect(splitForEdit([userMessage("u1")], "nope")).toBeNull();
  });

  it("returns null when the target is not a user message", () => {
    const messages = [userMessage("u1"), assistantMessage("a1")];
    expect(splitForEdit(messages, "a1")).toBeNull();
  });
});
