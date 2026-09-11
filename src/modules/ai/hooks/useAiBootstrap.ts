import { useEffect, useState } from "react";
import { firePendingReviewForSession } from "@/modules/agents/lib/review";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { onKeysChanged, setDefaultModel } from "@/modules/settings/store";
import {
  getAllCustomEndpointKeys,
  getAllKeys,
  hasAnyKey,
} from "../lib/keyring";
import {
  isSignedInToChatGpt,
  onChatGptAuthChanged,
} from "../lib/chatgptAuth";
import {
  DEFAULT_MODEL_ID,
  compatModelIdForEndpoint,
  normalizeModelId,
} from "../config";
import { useAgentsStore } from "../store/agentsStore";
import { useChatStore } from "../store/chatStore";
import { useSnippetsStore } from "../store/snippetsStore";

/**
 * Startup wiring for the AI subsystem: loads provider keys (and keeps them in
 * sync), hydrates the preference store and mirrors the default model, hydrates
 * chat/agents/snippets stores, and fires any pending review for the active
 * session. Returns the two derived flags the shell needs.
 */
export function useAiBootstrap(): {
  hasComposer: boolean;
  keysLoaded: boolean;
} {
  const apiKeys = useChatStore((s) => s.apiKeys);
  const setApiKeys = useChatStore((s) => s.setApiKeys);
  const setCustomEndpointKeys = useChatStore((s) => s.setCustomEndpointKeys);
  const setSelectedModelId = useChatStore((s) => s.setSelectedModelId);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const hydrateSessions = useChatStore((s) => s.hydrateSessions);

  useEffect(() => {
    if (activeSessionId) firePendingReviewForSession(activeSessionId);
  }, [activeSessionId]);

  const lmstudioModelId = usePreferencesStore((s) => s.lmstudioModelId);
  const lmstudioBaseURL = usePreferencesStore((s) => s.lmstudioBaseURL);
  const mlxModelId = usePreferencesStore((s) => s.mlxModelId);
  const mlxBaseURL = usePreferencesStore((s) => s.mlxBaseURL);
  const ollamaModelId = usePreferencesStore((s) => s.ollamaModelId);
  const ollamaBaseURL = usePreferencesStore((s) => s.ollamaBaseURL);
  const openaiCompatibleModelId = usePreferencesStore(
    (s) => s.openaiCompatibleModelId,
  );
  const openaiCompatibleBaseURL = usePreferencesStore(
    (s) => s.openaiCompatibleBaseURL,
  );
  const customEndpoints = usePreferencesStore((s) => s.customEndpoints);
  const modelIdOverrides = usePreferencesStore((s) => s.modelIdOverrides);
  const hasLocalModel =
    (lmstudioBaseURL.trim().length > 0 && lmstudioModelId.trim().length > 0) ||
    (mlxBaseURL.trim().length > 0 && mlxModelId.trim().length > 0) ||
    (ollamaBaseURL.trim().length > 0 && ollamaModelId.trim().length > 0) ||
    (openaiCompatibleBaseURL.trim().length > 0 &&
      openaiCompatibleModelId.trim().length > 0) ||
    customEndpoints.some(
      (e) => e.baseURL.trim().length > 0 && e.modelId.trim().length > 0,
    );
  const [hasChatGptAuth, setHasChatGptAuth] = useState(false);
  const hasComposer = hasAnyKey(apiKeys) || hasLocalModel || hasChatGptAuth;

  const prefsHydrated = usePreferencesStore((s) => s.hydrated);
  const [keysLoaded, setKeysLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const reload = () => {
      void getAllKeys().then((keys) => {
        if (!alive) return;
        setApiKeys(keys);
        setKeysLoaded(true);
      });
      void isSignedInToChatGpt().then((signedIn) => {
        if (!alive) return;
        setHasChatGptAuth(signedIn);
      });
      if (!prefsHydrated) return;
      void getAllCustomEndpointKeys(
        usePreferencesStore.getState().customEndpoints,
      ).then((epKeys) => {
        if (!alive) return;
        setCustomEndpointKeys(epKeys);
      });
    };
    reload();
    const unlistenP = onKeysChanged(reload);
    const unlistenChatGpt = onChatGptAuthChanged(reload);
    return () => {
      alive = false;
      void unlistenP.then((fn) => fn());
      unlistenChatGpt();
    };
  }, [setApiKeys, setCustomEndpointKeys, prefsHydrated]);

  // Hydrate the cross-window preference store and mirror the default model
  // into chatStore so the dropdown reflects what the user picked in Settings.
  const initPrefs = usePreferencesStore((s) => s.init);
  const prefDefaultModel = usePreferencesStore((s) => s.defaultModelId);
  useEffect(() => {
    void initPrefs();
  }, [initPrefs]);
  useEffect(() => {
    if (!prefsHydrated) return;
    const rawDefault = String(prefDefaultModel).trim();
    // Accepts the registry id, the compat-<id> form, a bare endpoint id, an
    // endpoint's name, or the provider's own model id. Hand-written config on
    // a VPS uses most of those, and only the compat-<id> form used to work.
    const resolved = normalizeModelId(
      rawDefault,
      customEndpoints,
      modelIdOverrides,
    );
    if (resolved) {
      setSelectedModelId(resolved);
      // Write the repair back: a bare endpoint id left in the settings file
      // would resolve the same way on every boot, and the next reader (a
      // support note, the deployment guide) learns the wrong shape from it.
      if (resolved !== rawDefault) void setDefaultModel(resolved).catch(() => {});
      return;
    }
    setSelectedModelId(
      customEndpoints.length > 0
        ? compatModelIdForEndpoint(customEndpoints[0].id)
        : DEFAULT_MODEL_ID,
    );
  }, [
    prefsHydrated,
    prefDefaultModel,
    setSelectedModelId,
    customEndpoints,
    modelIdOverrides,
  ]);

  useEffect(() => {
    void hydrateSessions();
    void useAgentsStore.getState().hydrate();
    void useSnippetsStore.getState().hydrate();
  }, [hydrateSessions]);

  return { hasComposer, keysLoaded };
}
