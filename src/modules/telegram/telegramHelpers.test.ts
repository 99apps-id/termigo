// The relay's answer extraction.
//
// This is the function that decides what a Telegram user actually receives after
// a run, so its failure mode is not a crash but silence: the relay sends a bare
// status line instead of the work. The cases below are the shapes measured on a
// live install, including the one that regressed.

import { describe, expect, it } from "vitest";
import {
  type ChatLike,
  hasActiveToolCalls,
  lastAssistantText,
  runBusy,
} from "./telegramHelpers";

const text = (value: string) => ({ type: "text", text: value });
const tool = (name: string) => ({
  type: `tool-${name}`,
  state: "output-available",
});
const reasoning = { type: "reasoning", text: "scratchpad" };

/** A chat whose assistant messages have the given parts, in order. */
function chatWith(messages: ChatLike["messages"]): ChatLike {
  return { messages };
}

const getter = (chat: ChatLike | undefined) => (): ChatLike | undefined => chat;

describe("lastAssistantText", () => {
  it("returns the text of the newest assistant message", () => {
    const chat = chatWith([
      { role: "user", parts: [text("audit this repo")] },
      {
        role: "assistant",
        parts: [tool("read_file"), text("Found three bugs.")],
      },
    ]);
    expect(lastAssistantText(getter(chat), "s1", 0)).toBe("Found three bugs.");
  });

  it("recovers the answer when the run ends on a tool call", () => {
    // THE regression: the final assistant message of a run commonly carries only
    // reasoning and tool parts, with no closing prose. Reading only that message
    // returned null, so the relay answered a finished audit with "Run finished."
    // while the findings sat in the message before it.
    const chat = chatWith([
      { role: "user", parts: [text("audit deeply")] },
      {
        role: "assistant",
        parts: [
          tool("bash_run"),
          text("Audit result: 3 findings, 1 critical."),
        ],
      },
      { role: "assistant", parts: [reasoning, tool("git_status")] },
    ]);
    expect(lastAssistantText(getter(chat), "s1", 0)).toBe(
      "Audit result: 3 findings, 1 critical.",
    );
  });

  it("skips several trailing text-less messages", () => {
    const chat = chatWith([
      { role: "assistant", parts: [text("The refactor is done.")] },
      { role: "assistant", parts: [reasoning, tool("bash_run")] },
      { role: "assistant", parts: [reasoning, tool("bash_run"), tool("grep")] },
    ]);
    expect(lastAssistantText(getter(chat), "s1", 0)).toBe(
      "The refactor is done.",
    );
  });

  it("prefers the newest text over an older one", () => {
    const chat = chatWith([
      { role: "assistant", parts: [text("First thought.")] },
      { role: "assistant", parts: [text("Final answer.")] },
      { role: "assistant", parts: [tool("bash_run")] },
    ]);
    expect(lastAssistantText(getter(chat), "s1", 0)).toBe("Final answer.");
  });

  it("never returns reasoning as if it were the answer", () => {
    // Reasoning is the agent's scratchpad. Publishing it would put raw internal
    // deliberation in the chat, so a run with reasoning and nothing else must
    // read as no output rather than as an answer.
    const chat = chatWith([
      { role: "assistant", parts: [reasoning, tool("read_file")] },
    ]);
    expect(lastAssistantText(getter(chat), "s1", 0)).toBeNull();
  });

  it("returns null when there is no assistant message at all", () => {
    const chat = chatWith([{ role: "user", parts: [text("hi")] }]);
    expect(lastAssistantText(getter(chat), "s1", 0)).toBeNull();
  });

  it("ignores messages before the baseline, so a new run does not resend the old reply", () => {
    const chat = chatWith([
      { role: "assistant", parts: [text("Previous run's answer.")] },
      { role: "user", parts: [text("now do this")] },
      { role: "assistant", parts: [reasoning, tool("bash_run")] },
    ]);
    // baseline 1 means only the newest assistant message counts, and it has no
    // text, so there is nothing to send rather than the previous answer again.
    expect(lastAssistantText(getter(chat), "s1", 1)).toBeNull();
  });

  it("joins multiple text parts of the same message", () => {
    const chat = chatWith([
      {
        role: "assistant",
        parts: [text("Step one."), tool("edit"), text("Step two.")],
      },
    ]);
    expect(lastAssistantText(getter(chat), "s1", 0)).toBe(
      "Step one.\nStep two.",
    );
  });

  it("treats whitespace-only text as no text", () => {
    const chat = chatWith([
      { role: "assistant", parts: [text("Real answer.")] },
      { role: "assistant", parts: [text("   \n  "), tool("bash_run")] },
    ]);
    expect(lastAssistantText(getter(chat), "s1", 0)).toBe("Real answer.");
  });

  it("returns null for an unknown session", () => {
    expect(lastAssistantText(getter(undefined), "missing", 0)).toBeNull();
  });
});

describe("hasActiveToolCalls", () => {
  it("returns false for undefined or empty chat", () => {
    expect(hasActiveToolCalls(undefined)).toBe(false);
    expect(hasActiveToolCalls(chatWith([]))).toBe(false);
  });

  it("returns false when tools are completed", () => {
    const chat = chatWith([
      {
        role: "assistant",
        parts: [
          { type: "tool-bash_run", state: "output-available", output: "done" },
        ],
      },
    ]);
    expect(hasActiveToolCalls(chat)).toBe(false);
  });

  it("returns true when tool call is in input-available or approval-responded state", () => {
    const chat1 = chatWith([
      {
        role: "assistant",
        parts: [{ type: "tool-bash_run", state: "input-available" }],
      },
    ]);
    expect(hasActiveToolCalls(chat1)).toBe(true);

    const chat2 = chatWith([
      {
        role: "assistant",
        parts: [{ type: "tool-bash_run", state: "approval-responded" }],
      },
    ]);
    expect(hasActiveToolCalls(chat2)).toBe(true);
  });

  it("returns true for dynamic-tool without output", () => {
    const chat = chatWith([
      {
        role: "assistant",
        parts: [{ type: "dynamic-tool", state: "call" }],
      },
    ]);
    expect(hasActiveToolCalls(chat)).toBe(true);
  });

  it("returns false when unfinished tool was in a previous message", () => {
    const chat = chatWith([
      {
        role: "assistant",
        parts: [{ type: "tool-bash_run", state: "approval-responded" }],
      },
      {
        role: "user",
        parts: [{ type: "text", text: "next question" }],
      },
    ]);
    expect(hasActiveToolCalls(chat)).toBe(false);
  });

  it("returns false when approval-responded was in an earlier step and latest step completed", () => {
    const chat = chatWith([
      {
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "tool-bash_run", state: "approval-responded" },
          { type: "step-start" },
          { type: "tool-read_file", state: "output-available", output: "ok" },
          { type: "text", text: "All done." },
        ],
      },
    ]);
    expect(hasActiveToolCalls(chat)).toBe(false);
  });
});

describe("runBusy", () => {
  it("returns true if hasActiveTools is true", () => {
    expect(runBusy("ready", "idle", false, true)).toBe(true);
  });

  it("returns true if hasPendingApproval is true", () => {
    expect(runBusy("ready", "idle", true, false)).toBe(true);
  });

  it("returns true for streaming or submitted or thinking statuses", () => {
    expect(runBusy("submitted", "idle")).toBe(true);
    expect(runBusy("streaming", "idle")).toBe(true);
    expect(runBusy("ready", "thinking")).toBe(true);
    expect(runBusy("ready", "streaming")).toBe(true);
    expect(runBusy("ready", "awaiting-approval")).toBe(true);
  });

  it("returns false when idle with no pending approvals or active tools", () => {
    expect(runBusy("ready", "idle", false, false)).toBe(false);
  });
});

