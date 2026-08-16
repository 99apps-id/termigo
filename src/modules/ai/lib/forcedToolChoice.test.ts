// The bug: "audit dan analisa kembali repo ini" on DeepSeek V4 Flash failed
// with "Thinking mode does not support this tool_choice". The fan-out pin was
// decided from the request alone, so the models most worth asking a broad
// question were the ones that could not be asked it.
import { describe, expect, it } from "vitest";
import {
  MODELS,
  modelAllowsForcedToolChoice,
  modelKeepsReasoning,
  type ModelInfo,
} from "../config";

// `MODELS` is a const array of literals, so a few entries have no `tags` key at
// all and the union rejects `.tags`. Reading it as the type the functions
// accept is what the code under test does anyway.
const ALL: readonly ModelInfo[] = MODELS;

const byId = (id: string) => {
  const m = ALL.find((x) => x.id === id);
  if (!m) throw new Error(`no such model in the registry: ${id}`);
  return m;
};

describe("a pinned tool choice is only sent where it is accepted", () => {
  it("is withheld from the model that reported the failure", () => {
    expect(modelAllowsForcedToolChoice(byId("deepseek-v4-flash"))).toBe(false);
  });

  it("is withheld from every reasoning-tagged model", () => {
    const reasoning = ALL.filter((m) => m.tags?.includes("reasoning"));
    expect(reasoning.length).toBeGreaterThan(0);
    for (const m of reasoning) {
      expect(modelAllowsForcedToolChoice(m), m.id).toBe(false);
    }
  });

  it("is still sent to models that take it", () => {
    const plain = ALL.filter((m) => !m.tags?.includes("reasoning"));
    expect(plain.length).toBeGreaterThan(0);
    for (const m of plain) {
      expect(modelAllowsForcedToolChoice(m), m.id).toBe(true);
    }
  });

  // These answer different questions - what the history keeps, and what the
  // API accepts - and are separate so that one can change without the other.
  it("is not the same question as whether reasoning is kept", () => {
    const local = ALL.find(
      (m) => modelKeepsReasoning(m) && !m.tags?.includes("reasoning"),
    );
    if (local) expect(modelAllowsForcedToolChoice(local)).toBe(true);
  });
});
