// The relay's answer extraction.
//
// This is the function that decides what a Telegram user actually receives after
// a run, so its failure mode is not a crash but silence: the relay sends a bare
// status line instead of the work. The cases below are the shapes measured on a
// live install, including the one that regressed.

import { describe, expect, it } from "vitest";
import { type ChatLike, lastAssistantText } from "./telegramHelpers";

const text = (value: string) => ({ type: "text", text: value });
const tool = (name: string) => ({ type: `tool-${name}`, state: "output-available" });
const reasoning = { type: "reasoning", text: "scratchpad" };

/** A chat whose assistant messages have the given parts, in order. */
function chatWith(messages: ChatLike["messages"]): ChatLike {
  return { messages };
}

const getter =
  (chat: ChatLike | undefined) =>
  (): ChatLike | undefined =>
    chat;

describe("lastAssistantText", () => {
  it("returns the text of the newest assistant message", () => {
    const chat = chatWith([
      { role: "user", parts: [text("audit this repo")] },
      { role: "assistant", parts: [tool("read_file"), text("Found three bugs.")] },
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
        parts: [tool("bash_run"), text("Audit result: 3 findings, 1 critical.")],
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
    expect(lastAssistantText(getter(chat), "s1", 0)).toBe("The refactor is done.");
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
      { role: "assistant", parts: [text("Step one."), tool("edit"), text("Step two.")] },
    ]);
    expect(lastAssistantText(getter(chat), "s1", 0)).toBe("Step one.\nStep two.");
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
