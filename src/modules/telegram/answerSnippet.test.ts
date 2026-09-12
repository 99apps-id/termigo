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
  it("separates the header, the answer and the tool lines with blank lines", () => {
    // Run together, the card reads as a wall where the agent's prose and the
    // tool lines are indistinguishable at a glance. The blank lines are what
    // let the eye split "what it is saying" from "what it is doing".
    const card = formatLiveProgress({
      status: "streaming",
      round: 2,
      elapsedMs: 10_000,
      mode: "task",
      answerText: "Mulai dengan mencari apakah repo sudah ada di mesin ini.",
      tools: [
        { toolName: "list_directory", state: "done", input: "/x/modules", output: "28 entries" },
        { toolName: "read_file", state: "done", input: "/x/file.rs" },
        { toolName: "run_subagents", state: "running", input: "explore" },
      ],
    });
    const lines = card.split("\n");
    expect(lines[0]).toContain("**[Termigo Agent]**");
    expect(lines[0]).toContain("Writing response");
    expect(lines[0]).toContain("step 3");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe(
      "Mulai dengan mencari apakah repo sudah ada di mesin ini.",
    );
    expect(lines[3]).toBe("");
    // The tool lines stay adjacent: a list of related facts, not four messages.
    expect(lines[4]).toContain("✓ Listed");
    expect(lines[5]).toContain("✓ Read");
    expect(lines[6]).toContain("⚡");
  });

  it("keeps the step line in its own block", () => {
    const card = formatLiveProgress({
      status: "streaming",
      round: 2,
      mode: "task",
      step: "Audit fs/control/secrets guards",
      answerText: "Mulai dari mencari repo.",
    });
    const lines = card.split("\n");
    expect(lines[0]).toContain("Writing response");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("*Audit fs/control/secrets guards*");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("Mulai dari mencari repo.");
  });

  it("preserves paragraph breaks inside the agent's own text", () => {
    const card = formatLiveProgress({
      status: "streaming",
      round: 1,
      mode: "task",
      answerText: "Paragraf pertama.\n\nParagraf kedua.",
    });
    // The blank line inside the answer is content, not layout.
    expect(card).toContain("Paragraf pertama.\n\nParagraf kedua.");
  });

  it("omits the body when there is no text yet", () => {
    const card = formatLiveProgress({
      status: "thinking",
      round: 0,
      mode: "task",
      answerText: "",
    });
    expect(card).toContain("Thinking");
    expect(card).toBe("**[Termigo Agent]** *Thinking...* (step 1)");
  });

  it("does not leave a trailing or leading blank line", () => {
    const card = formatLiveProgress({
      status: "streaming",
      round: 0,
      mode: "task",
      answerText: "hello",
    });
    expect(card.startsWith("\n")).toBe(false);
    expect(card.endsWith("\n")).toBe(false);
    expect(card).not.toContain("\n\n\n");
  });
});
