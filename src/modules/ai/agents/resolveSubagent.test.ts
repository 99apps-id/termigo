import { describe, expect, it } from "vitest";
import { SUBAGENTS } from "./registry";
import { resolveSubagentLabel, resolveSubagentType } from "./resolveSubagent";

describe("resolveSubagentType", () => {
  it("returns exact ids unchanged", () => {
    for (const id of Object.keys(SUBAGENTS)) {
      expect(resolveSubagentType(id)).toBe(id);
    }
  });

  it("matches ids case-insensitively and by label", () => {
    expect(resolveSubagentType("PENTEST")).toBe("pentest");
    expect(resolveSubagentType("Code review")).toBe("code-review");
    expect(resolveSubagentType("codereview")).toBe("code-review");
  });

  it("resolves synonyms the model tends to invent", () => {
    expect(resolveSubagentType("search")).toBe("explore");
    expect(resolveSubagentType("analyze")).toBe("explore");
    expect(resolveSubagentType("review")).toBe("code-review");
    expect(resolveSubagentType("audit")).toBe("security");
    expect(resolveSubagentType("implement")).toBe("builder");
    expect(resolveSubagentType("recon")).toBe("pentest");
    expect(resolveSubagentType("plan")).toBe("general");
    expect(resolveSubagentType("screenshot")).toBe("vision");
    expect(resolveSubagentType("image")).toBe("vision");
    expect(resolveSubagentType("diagram")).toBe("vision");
  });

  it("falls back to general for anything unknown, never throws", () => {
    expect(resolveSubagentType("qwerty-nonsense")).toBe("general");
    expect(resolveSubagentType("")).toBe("general");
    // @ts-expect-error exercising a non-string input
    expect(resolveSubagentType(undefined)).toBe("general");
  });
});

describe("resolveSubagentLabel", () => {
  it("shows the label of the agent that actually runs", () => {
    expect(resolveSubagentLabel("search")).toBe(SUBAGENTS.explore.label);
    expect(resolveSubagentLabel("recon")).toBe(SUBAGENTS.pentest.label);
  });
});
