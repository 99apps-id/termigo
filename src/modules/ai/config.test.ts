import { describe, expect, it } from "vitest";
import {
  apiModelIdDiffers,
  type CustomEndpoint,
  compatModelIdForEndpoint,
  DEFAULT_MODEL_ID,
  effectiveModelName,
  endpointIdFromCompatModel,
  getModelContextLimit,
  isCompactTierModel,
  isCompatModelId,
  MAX_AGENT_STEPS,
  MODEL_PRICING,
  MODELS,
  migrateLegacyCompatEndpoint,
  modelKeepsReasoning,
  modelSupportsTemperature,
  modelUsesReasoningTokens,
  normalizeModelId,
  resolveApiModelId,
  resolveModel,
  resolveModelContextLimit,
  resolveModelLabel,
  stepBudgetForRound,
  subagentModelExceedsBudget,
} from "./config";

const endpoint: CustomEndpoint = {
  id: "ab12cd34",
  name: "My LLM",
  baseURL: "https://api.example.com/v1",
  modelId: "llama-3.3-70b",
  contextLimit: 64_000,
};

describe("compat model id helpers", () => {
  it("round-trips endpoint id through the synthetic model id", () => {
    const mid = compatModelIdForEndpoint(endpoint.id);
    expect(isCompatModelId(mid)).toBe(true);
    expect(endpointIdFromCompatModel(mid)).toBe(endpoint.id);
  });

  it("treats static model ids as non-compat", () => {
    expect(isCompatModelId("gpt-5.4-mini")).toBe(false);
    expect(endpointIdFromCompatModel("gpt-5.4-mini")).toBe("");
  });
});

describe("resolveModel", () => {
  it("resolves a compat model id against its endpoint", () => {
    const mid = compatModelIdForEndpoint(endpoint.id);
    const info = resolveModel(mid, [endpoint]);
    expect(info.provider).toBe("openai-compatible");
    expect(info.id).toBe(mid);
    expect(info.label).toBe(endpoint.modelId);
  });

  it("falls back to a placeholder when the endpoint is gone", () => {
    const info = resolveModel(compatModelIdForEndpoint("missing"), []);
    expect(info.provider).toBe("openai-compatible");
  });

  it("resolves a static model id from the registry", () => {
    expect(resolveModel("gpt-5.4-mini").provider).toBe("openai");
  });

  it.each([
    ["gpt-5.6", "openai"],
    ["gpt-5.6-terra", "openai"],
    ["gpt-5.6-luna", "openai"],
    ["claude-fable-5", "anthropic"],
    ["claude-sonnet-5", "anthropic"],
    ["grok-4.5", "xai"],
  ] as const)("resolves current model %s through %s", (modelId, provider) => {
    expect(resolveModel(modelId).provider).toBe(provider);
  });

  it("falls back to the default model for an unknown static model id", () => {
    expect(resolveModel("nope-not-real").id).toBe(DEFAULT_MODEL_ID);
  });
});

describe("getModelContextLimit", () => {
  it("uses the per-endpoint override for compat models", () => {
    const mid = compatModelIdForEndpoint(endpoint.id);
    expect(getModelContextLimit(mid, endpoint.contextLimit)).toBe(64_000);
  });

  it("reads the static table for known models", () => {
    expect(getModelContextLimit("claude-opus-4-7")).toBe(1_000_000);
  });

  it.each([
    ["gpt-5.6", 1_050_000],
    ["gpt-5.6-terra", 1_050_000],
    ["gpt-5.6-luna", 1_050_000],
    ["claude-fable-5", 1_000_000],
    ["claude-sonnet-5", 1_000_000],
    ["grok-4.5", 500_000],
  ] as const)("uses the published context limit for %s", (modelId, limit) => {
    expect(getModelContextLimit(modelId)).toBe(limit);
  });

  // The models served with a 1M-token window. A limit set too LOW is the
  // harmful direction: the context indicator overstates fullness and the
  // conversation is pruned early, which reads as the agent forgetting context.
  it.each([
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-opus-4-8",
    "claude-fable-5",
    "claude-sonnet-5",
    "gpt-5.3-codex",
    "chatgpt-codex",
    "chatgpt-codex-mini",
  ])("gives %s its 1M-token window", (modelId) => {
    expect(getModelContextLimit(modelId)).toBe(1_000_000);
  });
});

describe("current model pricing", () => {
  it.each([
    ["gpt-5.6", 5, 30, 0.5],
    ["gpt-5.6-terra", 2.5, 15, 0.25],
    ["gpt-5.6-luna", 1, 6, 0.1],
    ["claude-fable-5", 10, 50, 1],
    ["claude-sonnet-5", 3, 15, 0.3],
    ["grok-4.5", 2, 6, 0.5],
  ] as const)(
    "uses the published token pricing for %s",
    (modelId, input, output, cacheRead) => {
      expect(MODEL_PRICING[modelId]).toEqual({ input, output, cacheRead });
    },
  );
});

describe("subagentModelExceedsBudget (BatikCode cost-tier guard)", () => {
  it("flags a subagent model that is much pricier than the main model", () => {
    expect(
      subagentModelExceedsBudget("claude-opus-4-7", "deepseek-v4-flash"),
    ).toBe(true);
  });

  it("allows a cheaper or equal subagent model", () => {
    expect(
      subagentModelExceedsBudget("deepseek-v4-flash", "claude-opus-4-7"),
    ).toBe(false);
  });

  it("allows a modest premium within the multiplier", () => {
    // deepseek-v4-pro (0.28) vs deepseek-v4-flash (0.07): exactly 4x, over 1.5x.
    expect(
      subagentModelExceedsBudget("deepseek-v4-pro", "deepseek-v4-flash"),
    ).toBe(true);
  });

  it("cannot judge an unpriced model (custom endpoint / local), so it allows", () => {
    expect(
      subagentModelExceedsBudget("openai-compatible-custom", "gpt-5.6"),
    ).toBe(false);
  });

  it("ignores an empty / undefined subagent model", () => {
    expect(subagentModelExceedsBudget(undefined, "gpt-5.6")).toBe(false);
  });

  it("respects a custom multiplier", () => {
    expect(
      subagentModelExceedsBudget("deepseek-v4-pro", "deepseek-v4-flash", 10),
    ).toBe(false);
  });
});

describe("modelKeepsReasoning", () => {
  it("keeps reasoning for compat endpoints (freeform provider)", () => {
    const info = resolveModel(compatModelIdForEndpoint(endpoint.id), [
      endpoint,
    ]);
    expect(modelKeepsReasoning(info)).toBe(true);
  });

  it("drops reasoning for plain non-reasoning models", () => {
    expect(modelKeepsReasoning(resolveModel("gpt-5.4-mini"))).toBe(false);
  });

  it("keeps reasoning for tagged reasoning models", () => {
    expect(modelKeepsReasoning(resolveModel("claude-opus-4-7"))).toBe(true);
  });
});

describe("model sampling capabilities", () => {
  it.each([
    ["openai", "gpt-5.4-nano"],
    ["openai", "gpt-5.6"],
    ["anthropic", "claude-fable-5"],
    ["anthropic", "claude-sonnet-5"],
  ] as const)("omits temperature for %s/%s", (provider, modelId) => {
    expect(modelSupportsTemperature(provider, modelId)).toBe(false);
  });

  it("keeps temperature for models that accept sampling parameters", () => {
    expect(modelSupportsTemperature("openai", "gpt-4.1-mini")).toBe(true);
    expect(modelSupportsTemperature("xai", "grok-4.5")).toBe(true);
  });

  it("defaults unknown provider models to temperature support", () => {
    expect(modelSupportsTemperature("openai-compatible", "custom-model")).toBe(
      true,
    );
  });

  it.each([
    ["openai", "gpt-5.4-nano"],
    ["openai", "gpt-5.6-luna"],
    ["anthropic", "claude-sonnet-5"],
    ["xai", "grok-4.5"],
    ["groq", "openai/gpt-oss-20b"],
  ] as const)(
    "allocates a reasoning output budget for %s/%s",
    (provider, modelId) => {
      expect(modelUsesReasoningTokens(provider, modelId)).toBe(true);
    },
  );
});

describe("migrateLegacyCompatEndpoint", () => {
  it("migrates a fully configured legacy endpoint", () => {
    const out = migrateLegacyCompatEndpoint(
      "https://api.example.com/v1",
      "llama-3.3-70b",
      32_000,
      "fixedid1",
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "fixedid1",
      baseURL: "https://api.example.com/v1",
      modelId: "llama-3.3-70b",
      contextLimit: 32_000,
    });
  });

  it("skips migration when base URL or model id is missing", () => {
    expect(migrateLegacyCompatEndpoint("", "m", 1, "x")).toEqual([]);
    expect(migrateLegacyCompatEndpoint("u", "  ", 1, "x")).toEqual([]);
  });
});

describe("stepBudgetForRound", () => {
  it("starts at VS Code's agent-mode default", () => {
    expect(stepBudgetForRound(0)).toBe(25);
    expect(MAX_AGENT_STEPS).toBe(25);
  });

  it("climbs one tier per Continue", () => {
    expect(stepBudgetForRound(1)).toBe(50);
    expect(stepBudgetForRound(2)).toBe(100);
  });

  it("holds at the top tier instead of growing without bound", () => {
    expect(stepBudgetForRound(3)).toBe(100);
    expect(stepBudgetForRound(99)).toBe(100);
  });

  it("clamps a negative round to the first tier", () => {
    expect(stepBudgetForRound(-1)).toBe(25);
  });

  it("never lets a later round shrink the budget", () => {
    for (let r = 1; r < 8; r++) {
      expect(stepBudgetForRound(r)).toBeGreaterThanOrEqual(
        stepBudgetForRound(r - 1),
      );
    }
  });
});

describe("resolveModelContextLimit", () => {
  it("uses a custom endpoint's own contextLimit for its compat model", () => {
    const eps = [
      {
        id: "stepfun",
        name: "StepFun",
        baseURL: "x",
        modelId: "step-3",
        contextLimit: 256_000,
      },
    ];
    const mid = compatModelIdForEndpoint("stepfun");
    // Without endpoints it falls back to 128k; with them it must be the saved 256k.
    expect(getModelContextLimit(mid)).toBe(128_000);
    expect(resolveModelContextLimit(mid, eps)).toBe(256_000);
  });

  it("leaves a first-class model at its configured limit", () => {
    expect(resolveModelContextLimit("claude-opus-4-7", [])).toBe(1_000_000);
  });
});

describe("resolveApiModelId", () => {
  it("returns the registry id for an ordinary model", () => {
    expect(resolveApiModelId("claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(apiModelIdDiffers("claude-opus-4-7")).toBe(false);
  });

  it("uses the registry apiModelId when it differs from the id", () => {
    // The chatgpt-* ids are internal; the Codex backend wants the bare name.
    expect(resolveApiModelId("chatgpt-codex")).toBe("gpt-5.3-codex");
    expect(apiModelIdDiffers("chatgpt-codex")).toBe(true);
  });

  it("lets a user override win over the registry apiModelId", () => {
    expect(
      resolveApiModelId("deepseek-v4-flash", {
        "deepseek-v4-flash": "deepseek-flash-latest",
      }),
    ).toBe("deepseek-flash-latest");
  });

  it("ignores a blank override so clearing the field restores the default", () => {
    expect(resolveApiModelId("deepseek-v4-flash", { "deepseek-v4-flash": " " }))
      .toBe("deepseek-flash");
  });

  it("passes a compat model id through untouched", () => {
    const mid = compatModelIdForEndpoint("stepfun");
    expect(resolveApiModelId(mid, { [mid]: "nope" })).toBe(mid);
    expect(apiModelIdDiffers(mid)).toBe(false);
  });

  it("returns an unknown id unchanged rather than guessing", () => {
    expect(resolveApiModelId("some-future-model")).toBe("some-future-model");
  });
});

describe("DeepSeek model registry", () => {
  it("lists the current line-up and drops the retired reasoner", () => {
    const ids = MODELS.filter((m) => m.provider === "deepseek").map(
      (m) => m.id,
    );
    expect(ids).toContain("deepseek-v4-pro");
    expect(ids).toContain("deepseek-v4-flash");
    expect(ids).not.toContain("deepseek-reasoner");
  });

  it("sends the renamed everyday tier as deepseek-flash", () => {
    expect(resolveApiModelId("deepseek-v4-flash")).toBe("deepseek-flash");
    expect(resolveApiModelId("deepseek-v4-pro")).toBe("deepseek-v4-pro");
  });

  it("keeps pricing and context limits keyed by the stable registry id", () => {
    expect(MODEL_PRICING["deepseek-v4-flash"]).toBeDefined();
    expect(getModelContextLimit("deepseek-v4-flash")).toBe(1_000_000);
  });
});

describe("resolveModelLabel", () => {
  it("does not repeat the brand in the label", () => {
    expect(resolveModelLabel("deepseek-v4-pro")).toBe("DeepSeek V4 Pro");
  });

  it("appends the wire id only when it differs", () => {
    expect(resolveModelLabel("deepseek-v4-flash")).toBe(
      "DeepSeek Flash (deepseek-flash)",
    );
    expect(
      resolveModelLabel("deepseek-v4-flash", [], {
        "deepseek-v4-flash": "deepseek-flash-2",
      }),
    ).toBe("DeepSeek Flash (deepseek-flash-2)");
  });

  it("keeps a compat endpoint's own name and model id as the label", () => {
    const mid = compatModelIdForEndpoint(endpoint.id);
    expect(resolveModelLabel(mid, [endpoint], {})).toBe(
      "My LLM llama-3.3-70b",
    );
  });
});

describe("normalizeModelId", () => {
  const eps: CustomEndpoint[] = [
    {
      id: "15292c18",
      name: "DeepSeek",
      baseURL: "https://api.deepseek.com/v1",
      modelId: "deepseek-flash",
      contextLimit: 1_000_000,
    },
  ];

  it("accepts a built-in registry id unchanged", () => {
    expect(normalizeModelId("gpt-5.4-mini", eps)).toBe("gpt-5.4-mini");
  });

  it("accepts the compat form when the endpoint exists", () => {
    expect(normalizeModelId("compat-15292c18", eps)).toBe("compat-15292c18");
  });

  it("rejects a compat id whose endpoint is gone", () => {
    expect(normalizeModelId("compat-missing", eps)).toBeNull();
  });

  it("maps a bare endpoint id to the compat form", () => {
    // The form the deployment guide used to document, and what most existing
    // hand-written VPS configs contain.
    expect(normalizeModelId("15292c18", eps)).toBe("compat-15292c18");
  });

  it("maps the endpoint name, case-insensitively", () => {
    expect(normalizeModelId("deepseek", eps)).toBe("compat-15292c18");
    expect(normalizeModelId("  DeepSeek  ", eps)).toBe("compat-15292c18");
  });

  it("maps the endpoint's provider-side model id", () => {
    expect(normalizeModelId("deepseek-flash", eps)).toBe("compat-15292c18");
  });

  it("prefers a configured endpoint over a built-in wire-id alias", () => {
    // `deepseek-flash` is both this endpoint's modelId and the id the built-in
    // DeepSeek model is served under. The endpoint is what the user configured.
    expect(normalizeModelId("deepseek-flash", eps)).toBe("compat-15292c18");
    // With no such endpoint, the same string resolves to the built-in model.
    expect(normalizeModelId("deepseek-flash", [])).toBe("deepseek-v4-flash");
  });

  it("maps a built-in provider's renamed wire id", () => {
    expect(normalizeModelId("deepseek-flash", [])).toBe("deepseek-v4-flash");
  });

  it("honours a user override when matching a wire id", () => {
    expect(
      normalizeModelId("my-model", [], { "deepseek-v4-pro": "my-model" }),
    ).toBe("deepseek-v4-pro");
  });

  it("returns null for an unknown id rather than guessing", () => {
    expect(normalizeModelId("nope", eps)).toBeNull();
    expect(normalizeModelId("", eps)).toBeNull();
    expect(normalizeModelId("   ", [])).toBeNull();
  });

  it("returns null when a bare id matches nothing and no endpoint exists", () => {
    expect(normalizeModelId("15292c18", [])).toBeNull();
  });
});

describe("compact tier detection", () => {
  it("matches a lite model by its registry id", () => {
    expect(isCompactTierModel("claude-haiku-4-5")).toBe(true);
    expect(isCompactTierModel("gpt-4.1-mini")).toBe(true);
    expect(isCompactTierModel("qwen-3-32b")).toBe(true);
  });

  it("matches a lite model by the id the provider serves it under", () => {
    // Every lite model is served under its registry id today, so this asserts
    // the provider-side route is wired to the same list - the route a rename or
    // a user override reaches the request through.
    for (const id of ["claude-haiku-4-5", "gemini-2.5-flash", "gpt-4.1-mini"])
      expect(isCompactTierModel(resolveApiModelId(id))).toBe(true);
  });

  it("does not match a non-lite model", () => {
    expect(isCompactTierModel("claude-opus-4-7")).toBe(false);
    expect(isCompactTierModel("deepseek-v4-pro")).toBe(false);
    expect(isCompactTierModel(undefined)).toBe(false);
  });

  // Regression: `deepseek-v4-flash` is DeepSeek's everyday reasoning tier, not a
  // small model - the registry rates it 4/5 intelligence (the same as
  // claude-sonnet-4-6), it serves a 1M window, and it is the provider's default.
  // Classifying it as lite by name association pruned 99 of 126 tools for every
  // DeepSeek user, and a reach for a real-but-pruned tool ended the run.
  it("keeps DeepSeek Flash on the full tier, despite the name", () => {
    expect(isCompactTierModel("deepseek-v4-flash")).toBe(false);
    expect(isCompactTierModel("deepseek-flash")).toBe(false);
    expect(isCompactTierModel("deepseek-v4-pro")).toBe(false);
  });

  it("keeps a DeepSeek endpoint on the full tier", () => {
    // The exact configuration from the field: a custom OpenAI-compatible
    // endpoint pointed at DeepSeek, served as `deepseek-flash`.
    const eps: CustomEndpoint[] = [
      {
        id: "762d2bd6",
        name: "DeepSeek",
        baseURL: "https://api.deepseek.com",
        modelId: "deepseek-flash",
        contextLimit: 1_128_000,
      },
    ];
    const mid = compatModelIdForEndpoint("762d2bd6");
    expect(effectiveModelName(mid, eps)).toBe("deepseek-flash");
    expect(isCompactTierModel(effectiveModelName(mid, eps))).toBe(false);
  });

  it("resolves a custom endpoint to the model it actually serves", () => {
    const eps: CustomEndpoint[] = [
      {
        id: "ep1",
        name: "Haiku",
        baseURL: "https://x/v1",
        modelId: "claude-haiku-4-5",
        contextLimit: 200_000,
      },
    ];
    const mid = compatModelIdForEndpoint("ep1");
    expect(effectiveModelName(mid, eps)).toBe("claude-haiku-4-5");
    // The synthetic id alone would miss the lite tier; the resolved name hits.
    expect(isCompactTierModel(mid)).toBe(false);
    expect(isCompactTierModel(effectiveModelName(mid, eps))).toBe(true);
  });

  it("keeps a non-lite custom endpoint on the full tier", () => {
    const eps: CustomEndpoint[] = [
      {
        id: "ep2",
        name: "Big",
        baseURL: "https://x/v1",
        modelId: "some-70b-instruct",
        contextLimit: 128_000,
      },
    ];
    const name = effectiveModelName(compatModelIdForEndpoint("ep2"), eps);
    expect(name).toBe("some-70b-instruct");
    expect(isCompactTierModel(name)).toBe(false);
  });

  it("falls back to the compat id when the endpoint is unknown", () => {
    expect(effectiveModelName("compat-gone", [])).toBe("compat-gone");
  });

  it("resolves a built-in through its rename override", () => {
    expect(effectiveModelName("deepseek-v4-flash")).toBe("deepseek-flash");
    expect(
      effectiveModelName("deepseek-v4-pro", [], {
        "deepseek-v4-pro": "deepseek-flash",
      }),
    ).toBe("deepseek-flash");
  });
});
