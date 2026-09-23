import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { RESUME_PROMPT } from "./steer";
import {
  turnCheckpointInfo,
  turnLabelFor,
  type TurnCheckpoint,
} from "./turnCheckpoints";
import { VERIFY_NUDGE_PREFIX } from "./verifyOnStop";

function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistantMessage(id: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text: "done" }] };
}

const SHA = "a".repeat(40);

describe("turnLabelFor", () => {
  it("takes the first non-empty line", () => {
    expect(turnLabelFor("\n  fix login\nsecond")).toBe("fix login");
  });

  it("caps long labels", () => {
    expect(turnLabelFor("x".repeat(100))).toHaveLength(60);
  });

  it("returns null for blank text", () => {
    expect(turnLabelFor("   \n  ")).toBeNull();
  });
});

describe("turnCheckpointInfo", () => {
  it("indexes the newest user turn", () => {
    const messages = [
      userMessage("u1", "first"),
      assistantMessage("a1"),
      userMessage("u2", "second task"),
    ];
    const out: TurnCheckpoint | null = turnCheckpointInfo(messages, SHA, 7);
    expect(out).toEqual({ messageId: "u2", sha: SHA, label: "second task", at: 7 });
  });

  it("returns null without a sha", () => {
    expect(turnCheckpointInfo([userMessage("u1", "x")], "", 1)).toBeNull();
  });

  it("returns null without a user turn", () => {
    expect(turnCheckpointInfo([assistantMessage("a1")], SHA, 1)).toBeNull();
  });

  it("skips the resume continuation prompt", () => {
    const messages = [userMessage("u1", "work"), userMessage("u2", RESUME_PROMPT)];
    expect(turnCheckpointInfo(messages, SHA, 1)).toBeNull();
  });

  it("skips verification nudges", () => {
    const messages = [userMessage("u1", `${VERIFY_NUDGE_PREFIX} check`)];
    expect(turnCheckpointInfo(messages, SHA, 1)).toBeNull();
  });

  it("labels attachment-only turns instead of skipping them", () => {
    const messages: UIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [
          {
            type: "file",
            mediaType: "image/png",
            url: "data:image/png;base64,xx",
          },
        ],
      },
    ];
    expect(turnCheckpointInfo(messages, SHA, 1)?.label).toBe("attachments");
  });
});
