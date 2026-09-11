// Pure model-listing logic for the Telegram /model picker.
//
// The bot displays a two-level inline menu: providers first, then a model per
// provider. Only providers the user can actually reach appear (a key is set,
// it is a local no-key provider, or it hosts the currently-selected model), and
// user-defined OpenAI-compatible endpoints (e.g. StepFun) are their own group.
// Kept pure so it is tested without the AI stack / Tauri stores.

export type ModelChoice = {
  /** Callback payload and registry id. Never shown to the user for a custom
   *  endpoint, whose real name is `displayId`. */
  id: string;
  label: string;
  /**
   * What the user types with `/model <id>`.
   *
   * For a custom endpoint the registry id is the synthetic `compat-<endpoint>`
   * form, which is an implementation detail: showing it made the picker look
   * broken and gave the user a string they had no way to recognise. The
   * endpoint's name (or its model id) is what they typed into Settings, and
   * `resolveModelInput` accepts it.
   */
  displayId: string;
};
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
  /** Registry model id -> the id the provider actually accepts. Shown next to
   *  the friendly label whenever the two differ (a vendor rename, or a user
   *  override in Settings), because the wire id is the one that fails. */
  apiModelIdFor?: (modelId: string) => string;
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
    apiModelIdFor,
  } = input;

  // "DeepSeek Flash (deepseek-flash)" when the wire id differs, else the label.
  const labelFor = (m: BuiltinLike): string => {
    const wire = apiModelIdFor?.(m.id);
    return wire && wire !== m.id ? `${m.label} (${wire})` : m.label;
  };

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
    g.models.push({ id: m.id, label: labelFor(m), displayId: m.id });
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
      models: [
        {
          id: modelId,
          label: ep.modelId || ep.name || "Custom endpoint",
          // What the user typed into Settings, and what `/model <text>`
          // resolves: the internal compat-<id> must never be shown.
          displayId: ep.name || ep.modelId || "",
        },
      ],
    });
  }
  return groups;
}
