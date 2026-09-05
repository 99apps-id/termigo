import { describe, expect, it } from "vitest";
import {
  buildPartGroups,
  isReadFilePart,
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

  it("merges multiple reasoning parts into one reasoning block", () => {
    const parts = [
      { type: "reasoning", text: "Thinking step 1" },
      { type: "tool-bash_run", toolCallId: "sh-1" },
      { type: "reasoning", text: "Thinking step 2" },
      { type: "text", text: "Here is the answer" },
    ] as unknown as AnyPart[];

    const groups = buildPartGroups(parts);
    // Reasoning appears in the first slot where reasoning was seen
    expect(groups[0].kind).toBe("reasoning");
    if (groups[0].kind === "reasoning") {
      expect(groups[0].text).toBe("Thinking step 1\n\nThinking step 2");
    }
    expect(groups[1].kind).toBe("single"); // bash_run
    expect(groups[2].kind).toBe("single"); // text
  });
});
