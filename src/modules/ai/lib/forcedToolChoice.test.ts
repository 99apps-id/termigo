// The bug: "audit dan analisa kembali repo ini" on DeepSeek V4 Flash failed
// with "Thinking mode does not support this tool_choice". The fan-out pin was
// decided from the request alone, so the models most worth asking a broad
// question were the ones that could not be asked it.
import { describe, expect, it } from "vitest";
import {
  compatModelIdForEndpoint,
  getCompatModelInfo,
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
    const plain = ALL.filter(
      (m) =>
        !m.tags?.includes("reasoning") &&
        // A user-supplied endpoint carries no metadata, so it is excluded from
        // this half; see the describe block below.
        m.id !== "openrouter-custom" &&
        m.id !== "openai-compatible-custom" &&
        m.id !== "lmstudio-local" &&
        m.id !== "mlx-local" &&
        m.id !== "ollama-local",
    );
    expect(plain.length).toBeGreaterThan(0);
    for (const m of plain) {
      expect(modelAllowsForcedToolChoice(m), m.id).toBe(true);
    }
  });

  // These answer different questions - what the history keeps, and what the
  // API accepts - and are separate so that one can change without the other.
  it("is not the same question as whether reasoning is kept", () => {
    // Every freeform model keeps reasoning (we cannot know its shape) but is
    // NOT assumed to accept a pinned tool choice. The two disagree here on
    // purpose, which is what "separate questions" means.
    const freeformOnly = ALL.filter(
      (m) => modelKeepsReasoning(m) && !m.tags?.includes("reasoning"),
    );
    expect(freeformOnly.length).toBeGreaterThan(0);
    for (const m of freeformOnly) {
      expect(modelAllowsForcedToolChoice(m), m.id).toBe(false);
    }
  });
});

// The second report of this bug, from a real run on a custom endpoint:
//
//   provider responded in 661ms (status 400)
//   ai request failed: Thinking mode does not support this tool_choice
//
// `getCompatModelInfo` builds its ModelInfo without a `tags` key, so the gate
// read `undefined?.includes("reasoning") ?? false` -> false -> "allows forced
// tool choice" -> pinned step 0 -> 400 on the FIRST request of every such run.
describe("a model we carry no metadata for is not assumed capable", () => {
  const endpoint = {
    id: "762d2bd6",
    name: "DeepSeek",
    baseURL: "https://api.stepfun.ai/step_plan/v1",
    modelId: "deepseek-flash",
    contextLimit: 262_144,
  };
  const compatId = compatModelIdForEndpoint(endpoint.id);
  const info = getCompatModelInfo(compatId, [endpoint]);

  it("withholds the pin from a custom endpoint", () => {
    expect(info.tags).toBeUndefined();
    expect(modelAllowsForcedToolChoice(info)).toBe(false);
  });

  it("withholds it from every freeform provider", () => {
    for (const id of [
      "openrouter-custom",
      "openai-compatible-custom",
      "lmstudio-local",
      "mlx-local",
      "ollama-local",
    ]) {
      expect(modelAllowsForcedToolChoice(byId(id)), id).toBe(false);
    }
  });

  it("keeps reasoning in the history for the same model", () => {
    // The two decisions must stay independent: dropping the pin is not a
    // reason to drop reasoning, which is what these endpoints need kept.
    expect(modelKeepsReasoning(info)).toBe(true);
  });

  it("still forces nothing on a built-in that takes it", () => {
    // The fix must not disable the optimisation where it is known to work.
    const plain = ALL.find(
      (m) =>
        !m.tags?.includes("reasoning") &&
        m.provider === "openai",
    );
    if (plain) expect(modelAllowsForcedToolChoice(plain)).toBe(true);
  });
});
