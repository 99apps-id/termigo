import { describe, expect, it } from "vitest";
import {
  buildPartGroups,
  isReadFilePart,
  isThinkingLive,
  lastReasoningGroupIndex,
  partKey,
  partType,
  type AnyPart,
} from "./chatPartGrouping";

describe("chatPartGrouping", () => {
  it("partType returns type string", () => {
    expect(partType({ type: "text" } as AnyPart)).toBe("text");
    expect(partType({} as AnyPart)).toBe("");
  });

  it("isReadFilePart detects read_file parts unless approval is requested", () => {
    expect(
      isReadFilePart({
        type: "tool-read_file",
        state: "output-available",
      } as AnyPart),
    ).toBe(true);

    expect(
      isReadFilePart({
        type: "tool-read_file",
        state: "approval-requested",
      } as AnyPart),
    ).toBe(false);

    expect(
      isReadFilePart({
        type: "tool-bash_run",
        state: "output-available",
      } as AnyPart),
    ).toBe(false);
  });

  it("partKey identifies key from toolCallId or approval", () => {
    expect(partKey({ toolCallId: "tc-123" } as AnyPart, 0)).toBe("tc-123");
    expect(
      partKey({ approval: { id: "appr-456" } } as unknown as AnyPart, 1),
    ).toBe("appr-456");
    expect(partKey({} as AnyPart, 3)).toBe("i-3");
  });

  it("groups adjacent read_file parts when count >= 2", () => {
    const parts = [
      { type: "text", text: "Reading files..." },
      { type: "tool-read_file", toolCallId: "rf-1", input: { path: "a.ts" } },
      { type: "tool-read_file", toolCallId: "rf-2", input: { path: "b.ts" } },
      { type: "text", text: "Finished reading" },
    ] as unknown as AnyPart[];

    const groups = buildPartGroups(parts);
    expect(groups.length).toBe(3);
    expect(groups[0].kind).toBe("single");
    expect(groups[1].kind).toBe("reads");
    if (groups[1].kind === "reads") {
      expect(groups[1].parts.length).toBe(2);
    }
    expect(groups[2].kind).toBe("single");
  });

  it("does not group a single read_file part into a reads group", () => {
    const parts = [
      { type: "tool-read_file", toolCallId: "rf-1", input: { path: "a.ts" } },
    ] as unknown as AnyPart[];

    const groups = buildPartGroups(parts);
    expect(groups.length).toBe(1);
    expect(groups[0].kind).toBe("single");
  });

  it("keeps one thinking block per step instead of folding them all together", () => {
    // Regression: folding produced ONE block parked at the top of the message,
    // so a ten-step run grew its thinking far from the tool card it explained,
    // and the step being worked was never the block that was open.
    const parts = [
      { type: "reasoning", text: "Thinking step 1" },
      { type: "tool-bash_run", toolCallId: "sh-1" },
      { type: "reasoning", text: "Thinking step 2" },
      { type: "text", text: "Here is the answer" },
    ] as unknown as AnyPart[];

    const groups = buildPartGroups(parts);
    expect(groups.map((g) => g.kind)).toEqual([
      "reasoning",
      "single",
      "reasoning",
      "single",
    ]);
    const first = groups[0];
    const second = groups[2];
    if (first.kind !== "reasoning" || second.kind !== "reasoning") {
      throw new Error("expected two reasoning groups");
    }
    expect(first.text).toBe("Thinking step 1");
    expect(second.text).toBe("Thinking step 2");
    // Distinct keys, or React reuses one component instance and the second
    // step inherits the first one's open/closed state.
    expect(first.key).not.toBe(second.key);
  });

  it("keeps whole think-work-answer cycles in order across steps", () => {
    // The transcript contract: thinking, then the work it explains, then the
    // answer - repeated per step, never folded into one block at the top.
    const parts = [
      { type: "reasoning", text: "Thinking step 1" },
      {
        type: "tool-read_file",
        toolCallId: "rf-1",
        state: "output-available",
      },
      { type: "tool-bash_run", toolCallId: "sh-1", state: "output-available" },
      { type: "reasoning", text: "Thinking step 2" },
      { type: "tool-grep", toolCallId: "gr-1", state: "output-available" },
      { type: "text", text: "Here is the answer" },
    ] as unknown as AnyPart[];

    const groups = buildPartGroups(parts);
    expect(groups.map((g) => g.kind)).toEqual([
      "reasoning",
      "single",
      "single",
      "reasoning",
      "single",
      "single",
    ]);
  });

  it("merges only the reasoning parts belonging to one step", () => {
    const parts = [
      { type: "reasoning", text: "part one" },
      { type: "reasoning", text: "part two" },
      { type: "tool-bash_run", toolCallId: "sh-1" },
    ] as unknown as AnyPart[];

    const groups = buildPartGroups(parts);
    expect(groups[0].kind).toBe("reasoning");
    if (groups[0].kind === "reasoning") {
      expect(groups[0].text).toBe("part one\n\npart two");
    }
  });

  it("starts a new thinking block at each step-start", () => {
    // The real shape from a tool-using run.
    const parts = [
      { type: "step-start" },
      { type: "reasoning", text: "first" },
      { type: "tool-bash_run", toolCallId: "sh-1" },
      { type: "step-start" },
      { type: "reasoning", text: "second" },
    ] as unknown as AnyPart[];

    const groups = buildPartGroups(parts);
    const thinking = groups.filter((g) => g.kind === "reasoning");
    expect(thinking.length).toBe(2);
  });
});

describe("isThinkingLive", () => {
  const thinking = { type: "reasoning", text: "..." } as unknown as AnyPart;
  const tool = {
    type: "tool-bash_run",
    toolCallId: "sh-1",
  } as unknown as AnyPart;

  it("is true while the newest part is reasoning", () => {
    expect(isThinkingLive([thinking], true)).toBe(true);
    expect(isThinkingLive([tool, thinking], true)).toBe(true);
  });

  it("is false once the model has moved on to anything else", () => {
    // The case the old positional rule could not express. The thinking block is
    // still present, but a tool card now trails it, so the model is no longer
    // thinking and the block must stop claiming to be live. Previously the rule
    // asked whether the block was the last GROUP, which never held here - so
    // live thinking never opened during a real run.
    expect(isThinkingLive([thinking, tool], true)).toBe(false);
    expect(
      isThinkingLive(
        [thinking, { type: "text", text: "hi" } as unknown as AnyPart],
        true,
      ),
    ).toBe(false);
  });

  it("is false when the message is not streaming or has no parts", () => {
    expect(isThinkingLive([thinking], false)).toBe(false);
    expect(isThinkingLive([], true)).toBe(false);
  });
});

describe("lastReasoningGroupIndex", () => {
  it("returns -1 when nothing is reasoning", () => {
    expect(lastReasoningGroupIndex([])).toBe(-1);
    expect(
      lastReasoningGroupIndex([
        { kind: "single", part: {} as AnyPart, idx: 0, key: "a" },
      ]),
    ).toBe(-1);
  });

  it("returns the LAST reasoning group, so the trailing step is the live one", () => {
    const groups = buildPartGroups([
      { type: "reasoning", text: "one" },
      { type: "tool-bash_run", toolCallId: "sh-1" },
      { type: "reasoning", text: "two" },
      { type: "tool-bash_run", toolCallId: "sh-2" },
    ] as unknown as AnyPart[]);

    expect(lastReasoningGroupIndex(groups)).toBe(2);
  });
});
