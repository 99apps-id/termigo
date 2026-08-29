// Starting points for the OpenAI-compatible endpoint form.
//
// These are presets, not providers. Termigo already talks to any
// OpenAI-compatible service through a custom endpoint; what was missing was
// knowing the base URL, which is the one field a user cannot guess and the one
// most likely to be mistyped.
//
// Deliberately not first-class providers with pinned model lists. A hardcoded
// model id is wrong the week the service renames it, and then it is wrong in a
// shipped binary. A preset fills the URL and suggests a model, and every field
// stays editable - so a stale suggestion costs one correction rather than a
// release.

export type EndpointPreset = {
  id: string;
  name: string;
  baseURL: string;
  /** A model that existed when this was written. Editable, and expected to age. */
  suggestedModel: string;
  contextLimit: number;
  /** Where to get a key, so the form is not a dead end. */
  keysUrl: string;
  note?: string;
};

export const ENDPOINT_PRESETS: EndpointPreset[] = [
  {
    id: "zai",
    name: "Z.ai (GLM)",
    baseURL: "https://api.z.ai/api/paas/v4",
    suggestedModel: "glm-5.2",
    contextLimit: 128_000,
    keysUrl: "https://z.ai/manage-apikey/apikey-list",
  },
  {
    id: "nvidia-nim",
    name: "NVIDIA NIM",
    baseURL: "https://integrate.api.nvidia.com/v1",
    suggestedModel: "meta/llama-3.3-70b-instruct",
    contextLimit: 128_000,
    keysUrl: "https://build.nvidia.com/",
    note: "Hosts many open models; the catalogue page gives each one's exact id.",
  },
  {
    id: "qwen",
    name: "Qwen (DashScope)",
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    suggestedModel: "qwen-max",
    contextLimit: 131_072,
    keysUrl: "https://bailian.console.alibabacloud.com/",
    note: "This is the international endpoint. Inside mainland China use dashscope.aliyuncs.com instead.",
  },
  {
    id: "stepfun",
    name: "StepFun",
    baseURL: "https://api.stepfun.ai/step_plan/v1",
    suggestedModel: "step-3",
    contextLimit: 256_000,
    keysUrl: "https://platform.stepfun.com/",
  },
  {
    id: "openrouter-compat",
    name: "OpenRouter (as a custom endpoint)",
    baseURL: "https://openrouter.ai/api/v1",
    suggestedModel: "anthropic/claude-sonnet-4.5",
    contextLimit: 200_000,
    keysUrl: "https://openrouter.ai/keys",
    note: "Termigo has OpenRouter as a built-in provider; use this only to pin a model the picker does not list.",
  },
];

/** Turn a preset into the endpoint the form saves. */
export function presetToEndpoint(
  preset: EndpointPreset,
  id: string,
): {
  id: string;
  name: string;
  baseURL: string;
  modelId: string;
  contextLimit: number;
} {
  return {
    id,
    name: preset.name,
    baseURL: preset.baseURL,
    modelId: preset.suggestedModel,
    contextLimit: preset.contextLimit,
  };
}

/** Look one up by id. */
export function findPreset(id: string): EndpointPreset | null {
  return ENDPOINT_PRESETS.find((p) => p.id === id) ?? null;
}
