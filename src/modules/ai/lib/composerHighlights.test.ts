import { describe, expect, it } from "vitest";
import {
  type HighlightVocab,
  splitComposerHighlights,
} from "./composerHighlights";

const vocab: HighlightVocab = {
  commands: new Set(["plan", "init", "model", "stop"]),
  snippets: new Set(["apikey", "env"]),
};

function refs(text: string): string[] {
  return splitComposerHighlights(text, vocab)
    .filter((s) => s.ref)
    .map((s) => s.text);
}

describe("splitComposerHighlights", () => {
  it("reproduces the input exactly when spans are concatenated", () => {
    const input = "run /plan then check @src/lib/a.ts with #apikey now";
    const joined = splitComposerHighlights(input, vocab)
      .map((s) => s.text)
      .join("");
    expect(joined).toBe(input);
  });

  it("lights a known slash command", () => {
    expect(refs("/plan the audit")).toEqual(["/plan"]);
  });

  it("lights a prefix mid-typing so the picker has visual feedback", () => {
    expect(refs("/pl")).toEqual(["/pl"]);
  });

  it("leaves an unknown command as plain prose", () => {
    expect(refs("/frobnicate everything")).toEqual([]);
  });

  it("leaves filesystem paths alone", () => {
    expect(refs("copy /usr/local/bin and a/b/c")).toEqual([]);
  });

  it("lights a mid-prose slash command but not one glued to a word", () => {
    expect(refs("please /stop now")).toEqual(["/stop"]);
    expect(refs("a/b/stop")).toEqual([]);
  });

  it("lights a known snippet handle", () => {
    expect(refs("use #apikey here")).toEqual(["#apikey"]);
  });

  it("lights any @ token as a file ref candidate", () => {
    expect(refs("look at @src/main.ts please")).toEqual(["@src/main.ts"]);
  });

  it("lights a bare @ the moment it is typed", () => {
    expect(refs("check @")).toEqual(["@"]);
  });

  it("does not light an @ glued to a word (email-like)", () => {
    expect(refs("mail me at foo@bar.com")).toEqual([]);
  });

  it("handles multiple tokens in one string", () => {
    expect(refs("/plan with #env and @a.ts")).toEqual(["/plan", "#env", "@a.ts"]);
  });

  it("returns one plain span for text with no tokens", () => {
    expect(splitComposerHighlights("hello world", vocab)).toEqual([
      { ref: false, text: "hello world" },
    ]);
  });

  it("returns one plain span for empty input", () => {
    expect(splitComposerHighlights("", vocab)).toEqual([
      { ref: false, text: "" },
    ]);
  });

  it("is case-insensitive for command names", () => {
    expect(refs("/PLAN now")).toEqual(["/PLAN"]);
  });
});
