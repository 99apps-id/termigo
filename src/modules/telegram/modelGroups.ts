// Pure model-listing logic for the Telegram /model picker.
//
// The bot displays a two-level inline menu: providers first, then a model per
// provider. Only providers the user can actually reach appear (a key is set,
// it is a local no-key provider, or it hosts the currently-selected model), and
// user-defined OpenAI-compatible endpoints (e.g. StepFun) are their own group.
// Kept pure so it is tested without the AI stack / Tauri stores.

export type ModelChoice = { id: string; label: string };
export type ProviderGroup = {
  key: string;
  label: string;
  models: ModelChoice[];
};

type BuiltinLike = { id: string; provider: string; label: string };
type EndpointLike = { id: string; name: string; modelId: string };

export type ModelGroupsInput = {
  models: readonly BuiltinLike[];
  providerLabel: (id: string) => string;
  current: string;
  apiKeys: Record<string, string | undefined>;
  customEndpointKeys: Record<string, string | null | undefined>;
  customEndpoints: readonly EndpointLike[];
  isCompatModelId: (id: string) => boolean;
  compatModelIdForEndpoint: (id: string) => string;
};

const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "mlx"]);

export function buildModelGroups(input: ModelGroupsInput): ProviderGroup[] {
  const {
    models,
    providerLabel,
    current,
    apiKeys,
    customEndpointKeys,
    customEndpoints,
    isCompatModelId,
    compatModelIdForEndpoint,
  } = input;

  const currentProvider = isCompatModelId(current)
    ? "openai-compatible"
    : (models.find((m) => m.id === current)?.provider ?? "");
  const isActive = (provider: string): boolean => {
    if (provider === currentProvider) return true;
    if (LOCAL_PROVIDERS.has(provider)) return true;
    return !!apiKeys[provider];
  };

  const groups: ProviderGroup[] = [];
  const seen = new Map<string, ProviderGroup>();
  for (const m of models) {
    if (!isActive(m.provider)) continue;
    let g = seen.get(m.provider);
    if (!g) {
      g = { key: m.provider, label: providerLabel(m.provider), models: [] };
      seen.set(m.provider, g);
      groups.push(g);
    }
    g.models.push({ id: m.id, label: m.label });
  }

  // A user-defined OpenAI-compatible endpoint (e.g. StepFun) is its own group
  // so it is reachable by name; show it only when usable or hosting the current
  // model.
  for (const ep of customEndpoints) {
    const modelId = compatModelIdForEndpoint(ep.id);
    const isCurrent = current === modelId;
    if (!isCurrent && !customEndpointKeys[ep.id]) continue;
    groups.push({
      key: `endpoint:${ep.id}`,
      label: ep.name || ep.modelId || "Custom endpoint",
      models: [{ id: modelId, label: ep.modelId || ep.name }],
    });
  }
  return groups;
}
