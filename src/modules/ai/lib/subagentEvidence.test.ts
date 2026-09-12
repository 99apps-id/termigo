import { describe, expect, it } from "vitest";
import { declaresIncomplete, judgeSubagentEvidence } from "./subagentEvidence";

const FOUND_SOMETHING =
  "Read src/modules/pty/session.rs: SPAWN_LOCK is taken before spawn and " +
  "released on close. No findings.";

describe("declaresIncomplete", () => {
  it("catches a review that says it could not see the code", () => {
    expect(
      declaresIncomplete(
        "No actionable findings could be confirmed from this review - but " +
          "that is a statement about the evidence, not a clean bill of health.",
      ),
    ).toBe(true);
    expect(
      declaresIncomplete(
        "Every body I was able to obtain consisted only of the import preamble.",
      ),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(declaresIncomplete("COULD NOT OBTAIN the file contents")).toBe(true);
  });

  // The false positive that would make the signal useless: a real finding
  // worded as a negation must not be read as an incomplete review.
  it("does not match a finding that merely reports a negative", () => {
    expect(declaresIncomplete("Could not reproduce the crash on Linux.")).toBe(
      false,
    );
    expect(
      declaresIncomplete("The guard does not reject a trailing separator."),
    ).toBe(false);
    expect(declaresIncomplete(FOUND_SOMETHING)).toBe(false);
  });

  it("is false for an empty summary", () => {
    expect(declaresIncomplete("")).toBe(false);
  });
});

describe("judgeSubagentEvidence", () => {
  it("leaves a mutating sub-agent alone", () => {
    const v = judgeSubagentEvidence("Wrote the file.", { steps: 0, toolCalls: 0 }, {
      audit: false,
    });
    expect(v.inconclusive).toBe(false);
    expect(v.note).toBeNull();
  });

  it("flags an audit of a run that inspected nothing", () => {
    const v = judgeSubagentEvidence("Looks fine.", { steps: 2, toolCalls: 1 }, {
      audit: true,
    });
    expect(v.inconclusive).toBe(true);
    expect(v.note).toContain("[inconclusive]");
    expect(v.note).toContain("1 tool call(s)");
  });

  it("flags an audit that declares itself incomplete even after reading", () => {
    const v = judgeSubagentEvidence(
      "Could not obtain the bodies of the files.",
      { steps: 6, toolCalls: 9 },
      { audit: true },
    );
    expect(v.inconclusive).toBe(true);
    expect(v.note).toContain("unverified");
  });

  it("passes an audit that read and reported", () => {
    const v = judgeSubagentEvidence(FOUND_SOMETHING, { steps: 5, toolCalls: 8 }, {
      audit: true,
    });
    expect(v.inconclusive).toBe(false);
    expect(v.note).toBeNull();
  });
});
