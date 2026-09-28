// Auto-detect and seed custom endpoints from environment variables.
//
// In headless VPS environments (Docker, systemd, cloud-init), operators
// configure services via environment variables rather than desktop GUIs.
// This utility seeds custom endpoints on startup when TERMIGO_CUSTOM_ENDPOINT_URL,
// OPENAI_BASE_URL, or OLLAMA_BASE_URL is provided, storing the API key securely
// and selecting the endpoint if no user default is set yet.

import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_MODEL_ID,
  compatModelIdForEndpoint,
} from "@/modules/ai/config";
import { setCustomEndpointKey } from "@/modules/ai/lib/keyring";
import {
  loadPreferences,
  setCustomEndpoints,
  setDefaultModel,
} from "@/modules/settings/store";

async function getEnv(name: string): Promise<string | null> {
  try {
    const val = await invoke<string | null>("env_get", { name });
    return val && val.trim().length > 0 ? val.trim() : null;
  } catch {
    return null;
  }
}

export async function seedCustomEndpointsFromEnv(): Promise<boolean> {
  const baseURL =
    (await getEnv("TERMIGO_CUSTOM_ENDPOINT_URL")) ||
    (await getEnv("OPENAI_BASE_URL")) ||
    (await getEnv("OLLAMA_BASE_URL"));

  if (!baseURL) return false;

  const modelId =
    (await getEnv("TERMIGO_CUSTOM_ENDPOINT_MODEL")) ||
    (await getEnv("OPENAI_MODEL")) ||
    (await getEnv("OLLAMA_MODEL")) ||
    "default";

  const name =
    (await getEnv("TERMIGO_CUSTOM_ENDPOINT_NAME")) ||
    (baseURL.includes("11434") ? "Ollama Local" : "Env Custom Endpoint");

  const apiKey =
    (await getEnv("TERMIGO_CUSTOM_ENDPOINT_KEY")) ||
    (await getEnv("OPENAI_API_KEY"));

  const rawSetDefault = await getEnv("TERMIGO_CUSTOM_ENDPOINT_DEFAULT");
  const forceDefault =
    rawSetDefault === "1" ||
    rawSetDefault === "true" ||
    rawSetDefault === "yes";

  const prefs = await loadPreferences();
  const existing = prefs.customEndpoints.find(
    (e) =>
      e.baseURL.trim().toLowerCase() === baseURL.toLowerCase() &&
      e.modelId.trim().toLowerCase() === modelId.toLowerCase(),
  );

  let endpointId = existing?.id;
  if (!existing) {
    endpointId = crypto.randomUUID().slice(0, 8);
    const newEndpoint = {
      id: endpointId,
      name,
      baseURL,
      modelId,
      contextLimit: 128_000,
    };
    await setCustomEndpoints([...prefs.customEndpoints, newEndpoint]);
  }

  if (endpointId && apiKey) {
    await setCustomEndpointKey(endpointId, apiKey);
  }

  if (endpointId) {
    const compatId = compatModelIdForEndpoint(endpointId);
    const shouldSetDefault =
      forceDefault ||
      !prefs.defaultModelId ||
      prefs.defaultModelId === DEFAULT_MODEL_ID;
    if (shouldSetDefault && prefs.defaultModelId !== compatId) {
      await setDefaultModel(compatId);
    }
  }

  return true;
}
