// The progress card now carries the agent's own words, so the chat shows what
// it is saying while it says it (the behaviour asked for: the answer appearing
// under "[Termigo Agent] Writing response..." alongside the tool lines).
//
// The snippet has to stay bounded: the card is edited in place on every step, and
// Telegram rejects `editMessageText` past 4096 characters, so an unbounded answer
// would eventually break the card instead of updating it.

import { describe, expect, it } from "vitest";
import { formatLiveProgress, renderAnswerSnippet } from "./progressFormat";

describe("renderAnswerSnippet", () => {
  it("returns short text unchanged", () => {
    expect(renderAnswerSnippet("Baik, saya akan mengaudit Repo Termigo.")).toBe(
      "Baik, saya akan mengaudit Repo Termigo.",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(renderAnswerSnippet("\n\n  hello  \n")).toBe("hello");
  });

  it("returns empty for empty or whitespace-only text", () => {
    expect(renderAnswerSnippet("")).toBe("");
    expect(renderAnswerSnippet("   \n\t ")).toBe("");
  });

  it("keeps the opening and the newest text when it does not fit", () => {
    const head = "OPENING: here is my plan.";
    const middle = "x".repeat(2000);
    const tail = "TAIL: now reading file.rs";
    const out = renderAnswerSnippet(`${head}${middle}${tail}`, 700);
    // The opening says what the agent decided to do; the tail says what it is
    // doing now. The middle is what a reader can do without.
    expect(out).toContain("OPENING: here is my plan.");
    expect(out).toContain("TAIL: now reading file.rs");
    expect(out).toContain("…");
    expect(out.length).toBeLessThanOrEqual(700);
    expect(out).not.toContain(middle);
  });

  it("never exceeds the cap, whatever the input length", () => {
    for (const n of [0, 1, 699, 700, 701, 5000, 20000]) {
      expect(renderAnswerSnippet("y".repeat(n), 700).length).toBeLessThanOrEqual(
        700,
      );
    }
  });

  it("stays well inside Telegram's message limit once formatted", () => {
    const card = formatLiveProgress({
      status: "streaming",
      round: 12,
      tools: [
        { toolName: "read_file", state: "done", input: "/x/file.rs" },
        { toolName: "bash_run", state: "running", input: "cd /repo && node" },
      ],
      elapsedMs: 1200,
      mode: "task",
      answerText: "z".repeat(20000),
    });
    expect(card.length).toBeLessThan(4096);
    expect(card).toContain("Writing response");
  });
});

describe("formatLiveProgress with answer text", () => {
  it("places the agent's words under the header", () => {
    const card = formatLiveProgress({
      status: "streaming",
      round: 12,
      elapsedMs: 1000,
      mode: "task",
      answerText: "Baik, saya akan mengaudit Repo Termigo.",
    });
    const lines = card.split("\n");
    expect(lines[0]).toContain("**[Termigo Agent]**");
    expect(lines[0]).toContain("Writing response");
    expect(lines[1]).toBe("Baik, saya akan mengaudit Repo Termigo.");
  });

  it("omits the body when there is no text yet", () => {
    const card = formatLiveProgress({
      status: "thinking",
      round: 0,
      mode: "task",
      answerText: "",
    });
    expect(card).toContain("Thinking");
    expect(card.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(1);
  });
});
