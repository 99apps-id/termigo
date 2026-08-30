import { describe, expect, it } from "vitest";
import { buildModelGroups, type ModelGroupsInput } from "./modelGroups";

const input = (over: Partial<ModelGroupsInput> = {}): ModelGroupsInput => ({
  models: [
    { id: "gpt-5.6", provider: "openai", label: "GPT-5.6 Sol" },
    { id: "claude-4", provider: "anthropic", label: "Claude 4" },
    { id: "llama-local", provider: "ollama", label: "Llama Local" },
  ],
  providerLabel: (id) => id,
  current: "gpt-5.6",
  apiKeys: { openai: "sk-..." },
  customEndpointKeys: {},
  customEndpoints: [],
  isCompatModelId: (id) => id.startsWith("compat-"),
  compatModelIdForEndpoint: (id) => `compat-${id}`,
  ...over,
});

describe("buildModelGroups", () => {
  it("keeps the current model's provider even without a key", () => {
    const groups = buildModelGroups(
      input({ current: "claude-4", apiKeys: {} }),
    );
    expect(groups.map((g) => g.key)).toContain("anthropic");
  });

  it("shows local no-key providers and keyed providers", () => {
    const groups = buildModelGroups(input());
    expect(groups.map((g) => g.key).sort()).toEqual(
      ["ollama", "openai"].sort(),
    );
  });

  it("drops keyed providers with no key", () => {
    const groups = buildModelGroups(input());
    // openai has a key; anthropic has none and is not the current model.
    expect(groups.map((g) => g.key)).not.toContain("anthropic");
  });

  it("adds a configured custom endpoint (e.g. StepFun) as its own group", () => {
    const groups = buildModelGroups(
      input({
        customEndpointKeys: { stepfun: "k" },
        customEndpoints: [{ id: "stepfun", name: "StepFun", modelId: "mid-1" }],
      }),
    );
    const g = groups.find((x) => x.key === "endpoint:stepfun");
    expect(g).toMatchObject({ label: "StepFun" });
    expect(g?.models).toEqual([{ id: "compat-stepfun", label: "mid-1" }]);
  });

  it("hides a custom endpoint that has no key and is not current", () => {
    const groups = buildModelGroups(
      input({
        customEndpointKeys: {},
        customEndpoints: [{ id: "zai", name: "Z.ai", modelId: "glm" }],
      }),
    );
    expect(groups.find((x) => x.key === "endpoint:zai")).toBeUndefined();
  });

  it("keeps a custom endpoint that hosts the current model", () => {
    const groups = buildModelGroups(
      input({
        current: "compat-stepfun",
        customEndpointKeys: {},
        customEndpoints: [{ id: "stepfun", name: "StepFun", modelId: "mid-1" }],
      }),
    );
    expect(groups.find((x) => x.key === "endpoint:stepfun")).toBeDefined();
  });
});
