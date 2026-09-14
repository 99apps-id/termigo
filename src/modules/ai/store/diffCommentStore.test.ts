import { beforeEach, describe, expect, it } from "vitest";
import { formatDiffFeedbackPrompt } from "../lib/diffComments";
import { useDiffCommentStore } from "./diffCommentStore";

const batch = () => useDiffCommentStore.getState().batch;

describe("diffCommentStore", () => {
  beforeEach(() => {
    useDiffCommentStore.getState().clear();
  });

  it("starts empty", () => {
    expect(batch().comments).toEqual([]);
  });

  it("collects notes across files, because a review spans more than one", () => {
    const { add } = useDiffCommentStore.getState();
    add("src/a.ts", 3, "rename this");
    add("src/b.ts", 9, "n+1 query");
    expect(batch().comments).toHaveLength(2);
  });

  it("removes one note without touching the others", () => {
    const { add, remove } = useDiffCommentStore.getState();
    add("src/a.ts", 3, "first");
    add("src/a.ts", 4, "second");
    const target = batch().comments.find((c) => c.comment === "first");
    if (!target) throw new Error("setup failed");

    remove(target.id);

    expect(batch().comments).toHaveLength(1);
    expect(batch().comments[0]?.comment).toBe("second");
  });

  // The card filters by path, so a Windows separator must land as the same key
  // the card computes - otherwise a note is stored but never rendered.
  it("normalises Windows separators so a card can match its own file", () => {
    useDiffCommentStore.getState().add("src\\modules\\a.ts", 1, "note");
    expect(batch().comments[0]?.filePath).toBe("src/modules/a.ts");
  });

  it("replaces a note on the same line instead of stacking two", () => {
    const { add } = useDiffCommentStore.getState();
    add("src/a.ts", 5, "first thought");
    add("src/a.ts", 5, "second thought");
    expect(batch().comments).toHaveLength(1);
    expect(batch().comments[0]?.comment).toBe("second thought");
  });

  // What the whole flow exists for: the batch has to become a usable prompt.
  it("formats the batch into a steering prompt", () => {
    const { add } = useDiffCommentStore.getState();
    add("src/a.ts", 12, "this leaks a file handle");
    const prompt = formatDiffFeedbackPrompt(batch());
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("Line 12");
    expect(prompt).toContain("this leaks a file handle");
  });

  it("clears everything after a send, so the same notes are not sent twice", () => {
    const { add, clear } = useDiffCommentStore.getState();
    add("src/a.ts", 1, "note");
    add("src/b.ts", 2, "another");
    clear();
    expect(batch().comments).toEqual([]);
    expect(formatDiffFeedbackPrompt(batch())).toBe("");
  });
});
