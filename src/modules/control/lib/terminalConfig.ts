// Terminal-facing configuration: the model catalogue, the settings a terminal
// may read and write, and API-key storage.
//
// Why this exists as its own module: the Go CLI has no idea which models this
// build ships (the registry is TypeScript, ~60 entries), and it must never learn
// how a secret is persisted (OS keychain on macOS and Windows, a local store on
// Linux). Both facts live in the app, so the terminal asks the app. The Rust
// control server forwards `models-list` / `config-get` / `config-set` /
// `secret-set` to these functions.
//
// The write allowlist is the security boundary. "Set any key in
// termigo-settings.json" would let a terminal-adjacent caller write arbitrary
// values into the app's configuration, so only the keys below are writable -
// each routed through the SAME setter the Settings UI uses, so validation
// (clamping, normalisation, event emission) cannot diverge.

import {
  MODELS,
  type ModelInfo,
  PROVIDERS,
  type ProviderId,
  providerSupportsKey,
} from "@/modules/ai/config";
import { APPROVAL_MODES, type ApprovalMode } from "@/modules/ai/lib/approvalPolicy";
import { setKey } from "@/modules/ai/lib/keyring";
import {
  loadPreferences,
  setAgentApprovalMode,
  setDefaultModel,
  setDisabledToolGroups,
  setToolSearchEnabled,
} from "@/modules/settings/store";

/**
 * The registry is declared `as const` for literal-id safety elsewhere, and that
 * narrows the union so optional fields (`apiModelId`, `tags`) are not readable
 * on members that omit them. Widening once, here, keeps the catalogue readable
 * without loosening the registry's own types.
 */
const CATALOGUE: readonly ModelInfo[] = MODELS;

/** One model as the terminal needs it: enough to list and select, nothing more. */
export type TerminalModel = {
  id: string;
  provider: string;
  label: string;
  hint?: string;
  description: string;
  /** Provider-side name, when it differs from the registry id. */
  apiModelId?: string;
  capabilities?: { intelligence?: number; speed?: number; cost?: number };
  tags?: readonly string[];
};

/** One provider, with whether it needs a key - the onboarding decision. */
export type TerminalProvider = {
  id: string;
  label: string;
  /** True when this provider stores an API key at all. */
  needsKey: boolean;
  /** Where to get one, for the wizard's hint. */
  consoleUrl?: string;
};

export type ModelsListResult = {
  providers: TerminalProvider[];
  models: TerminalModel[];
  current: {
    defaultModelId: string | null;
    /** Providers that already have a key stored. Never the key itself. */
    configuredProviders: string[];
  };
};

export function listModels(): ModelsListResult {
  return {
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      needsKey: providerSupportsKey(p.id),
      consoleUrl: p.consoleUrl,
    })),
    models: CATALOGUE.map((m) => ({
      id: m.id,
      provider: m.provider,
      label: m.label,
      hint: m.hint,
      description: m.description,
      apiModelId: m.apiModelId,
      capabilities: m.capabilities,
      tags: m.tags,
    })),
    current: { defaultModelId: null, configuredProviders: [] },
  };
}

/**
 * Settings a terminal may read. Deliberately a small, named set rather than the
 * whole preferences blob: this response crosses a socket and may be printed.
 */
export type TerminalConfig = {
  defaultModelId: string | null;
  toolSearchEnabled: boolean;
  disabledToolGroups: readonly string[];
  agentApprovalMode: string;
  language: string;
};

export async function readTerminalConfig(): Promise<TerminalConfig> {
  const prefs = await loadPreferences();
  return {
    defaultModelId: prefs.defaultModelId ?? null,
    toolSearchEnabled: prefs.toolSearchEnabled,
    disabledToolGroups: prefs.disabledToolGroups,
    agentApprovalMode: prefs.agentApprovalMode,
    language: prefs.language,
  };
}

/**
 * The writable keys, each mapped to the setter the Settings UI itself uses.
 *
 * `agentApprovalMode` is here because a headless operator needs it (with nobody
 * at the window, `ask` blocks every edit) - but it is a real loosening of the
 * approval gate, which is why the Go command that reaches it is named
 * `approval` rather than folded into a generic `config set`, and why the value
 * is validated rather than passed through.
 */
const WRITERS: Record<string, (value: unknown) => Promise<void>> = {
  defaultModelId: async (value) => {
    const id = typeof value === "string" ? value.trim() : "";
    if (!id) throw new Error("defaultModelId must be a non-empty model id");
    if (!CATALOGUE.some((m) => m.id === id)) {
      throw new Error(`unknown model id '${id}'`);
    }
    await setDefaultModel(id);
  },
  toolSearchEnabled: async (value) => {
    if (typeof value !== "boolean") {
      throw new Error("toolSearchEnabled must be true or false");
    }
    await setToolSearchEnabled(value);
  },
  disabledToolGroups: async (value) => {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new Error("disabledToolGroups must be a list of group names");
    }
    await setDisabledToolGroups(value as string[]);
  },
  agentApprovalMode: async (value) => {
    const mode = typeof value === "string" ? value.trim() : "";
    // Validated against the app's own list, not a hand-written copy: a mode
    // added or renamed in approvalPolicy.ts must not be rejected here.
    if (!APPROVAL_MODES.includes(mode as ApprovalMode)) {
      throw new Error(
        `agentApprovalMode must be one of ${APPROVAL_MODES.join(", ")}`,
      );
    }
    await setAgentApprovalMode(mode as ApprovalMode);
  },
};

/** The keys `config-set` accepts, so the CLI can advertise them. */
export const WRITABLE_CONFIG_KEYS: readonly string[] = Object.keys(WRITERS);

export async function writeTerminalConfig(
  key: string,
  value: unknown,
): Promise<{ key: string; value: unknown }> {
  const writer = WRITERS[key];
  if (!writer) {
    throw new Error(
      `'${key}' is not writable from the terminal; writable keys: ${WRITABLE_CONFIG_KEYS.join(", ")}`,
    );
  }
  await writer(value);
  return { key, value };
}

/**
 * Store a provider's API key.
 *
 * Goes through the app so the platform-correct path is used, and so a failed
 * store is reported instead of silently writing a file the app does not read.
 * The key is never returned, logged or echoed.
 */
export async function setProviderSecret(
  provider: string,
  value: string,
): Promise<{ provider: string }> {
  const key = value.trim();
  if (!key) throw new Error("API key is empty");
  const known = PROVIDERS.find((p) => p.id === provider);
  if (!known) throw new Error(`unknown provider '${provider}'`);
  if (!providerSupportsKey(provider as ProviderId)) {
    throw new Error(`${known.label} does not use an API key`);
  }
  await setKey(provider as ProviderId, key);
  return { provider };
}
