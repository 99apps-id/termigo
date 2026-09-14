import { describe, expect, it } from "vitest";
import {
  addCommentToBatch,
  clearCommentsForFile,
  createDiffComment,
  createEmptyDiffBatch,
  formatDiffFeedbackPrompt,
  groupCommentsByFile,
  removeCommentFromBatch,
} from "./diffComments";

describe("diffComments", () => {
  it("creates and accumulates comments in batch", () => {
    let batch = createEmptyDiffBatch();
    expect(batch.comments).toHaveLength(0);

    const c1 = createDiffComment("src/utils/math.ts", 42, "Use safe integer addition", "const sum = a + b;");
    batch = addCommentToBatch(batch, c1);
    expect(batch.comments).toHaveLength(1);
    expect(batch.comments[0].filePath).toBe("src/utils/math.ts");
    expect(batch.comments[0].lineNumber).toBe(42);

    // Overwrites existing comment on same file, line, and side
    const c1Updated = createDiffComment("src/utils/math.ts", 42, "Use BigInt instead", "const sum = a + b;");
    batch = addCommentToBatch(batch, c1Updated);
    expect(batch.comments).toHaveLength(1);
    expect(batch.comments[0].comment).toBe("Use BigInt instead");

    // Adds comment on another line
    const c2 = createDiffComment("src/utils/math.ts", 10, "Add jsdoc here");
    batch = addCommentToBatch(batch, c2);
    expect(batch.comments).toHaveLength(2);
  });

  it("removes single comment and clears file comments", () => {
    let batch = createEmptyDiffBatch();
    const c1 = createDiffComment("src/a.ts", 5, "fix a");
    const c2 = createDiffComment("src/b.ts", 12, "fix b");
    const c3 = createDiffComment("src/b.ts", 18, "fix b2");

    batch = addCommentToBatch(batch, c1);
    batch = addCommentToBatch(batch, c2);
    batch = addCommentToBatch(batch, c3);
    expect(batch.comments).toHaveLength(3);

    batch = removeCommentFromBatch(batch, c1.id);
    expect(batch.comments).toHaveLength(2);
    expect(batch.comments.some((c) => c.id === c1.id)).toBe(false);

    batch = clearCommentsForFile(batch, "src/b.ts");
    expect(batch.comments).toHaveLength(0);
  });

  it("groups comments by file in ascending line order", () => {
    let batch = createEmptyDiffBatch();
    batch = addCommentToBatch(batch, createDiffComment("src/z.ts", 50, "comment 50"));
    batch = addCommentToBatch(batch, createDiffComment("src/z.ts", 10, "comment 10"));
    batch = addCommentToBatch(batch, createDiffComment("src/a.ts", 5, "comment 5"));

    const grouped = groupCommentsByFile(batch);
    expect(Object.keys(grouped)).toEqual(["src/z.ts", "src/a.ts"]);
    expect(grouped["src/z.ts"].map((c) => c.lineNumber)).toEqual([10, 50]);
  });

  it("formats structured feedback prompt for AI agent", () => {
    let batch = createEmptyDiffBatch();
    expect(formatDiffFeedbackPrompt(batch)).toBe("");

    batch = addCommentToBatch(
      batch,
      createDiffComment("src/auth.ts", 42, "Use crypto.timingSafeEqual here", "if (a === b) return true;")
    );
    batch = addCommentToBatch(
      batch,
      createDiffComment("src/auth.ts", 80, "Handle null or expired tokens gracefully")
    );

    const prompt = formatDiffFeedbackPrompt(batch);
    expect(prompt).toContain("I have reviewed your changes and noted 2 inline annotation(s)");
    expect(prompt).toContain("### File: `src/auth.ts`");
    expect(prompt).toContain("- Line 42: `if (a === b) return true;`");
    expect(prompt).toContain("Feedback: Use crypto.timingSafeEqual here");
    expect(prompt).toContain("- Line 80:");
    expect(prompt).toContain("Feedback: Handle null or expired tokens gracefully");
    expect(prompt).toContain("Please apply these changes directly and verify that tests still pass.");
  });
});
