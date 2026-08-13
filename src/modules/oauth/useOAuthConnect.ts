// Sign-in flow hook for a single OAuth profile.
//
// Loopback profiles (codex, antigravity): start -> open browser -> poll the
// local callback server until the code arrives -> exchange -> store.
// Manual-code profiles (claude): start -> open browser -> the browser shows a
// code -> user pastes it -> completeManual exchanges it.

import { useCallback, useEffect, useRef, useState } from "react";
import { OAUTH_PRESETS, type OAuthProfile } from "./presets";
import {
  extractOAuthCode,
  oauthExchange,
  oauthPoll,
  oauthStart,
  oauthStore,
  openOAuthBrowser,
} from "./bridge";
import { useOAuthStore } from "./store";

const POLL_INTERVAL_MS = 1500;

export function useOAuthConnect(profile: OAuthProfile) {
  const status = useOAuthStore((s) => s.status[profile]);
  const error = useOAuthStore((s) => s.error[profile]);
  const tokens = useOAuthStore((s) => s.tokens[profile]);
  const setStatus = useCallback((v: typeof status) => {
    useOAuthStore.setState((s) => ({
      status: { ...s.status, [profile]: v },
    }));
  }, [profile]);
  const setError = useCallback((msg: string | null) => {
    useOAuthStore.setState((s) => ({
      error: { ...s.error, [profile]: msg },
    }));
  }, [profile]);
  const setTokens = useCallback((t: typeof tokens) => {
    useOAuthStore.setState((s) => ({
      tokens: { ...s.tokens, [profile]: t },
    }));
  }, [profile]);

  const [manualCode, setManualCode] = useState("");
  const [busy, setBusy] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingState = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    pendingState.current = null;
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatus("connecting");
    try {
      const res = await oauthStart(profile);
      pendingState.current = res.state;
      await openOAuthBrowser(res.authorizeUrl);

      if (OAUTH_PRESETS[profile].manualCode) {
        // User pastes the code (or the full callback URL) from the browser.
        // Move to a dedicated waiting state (no spinner) so the paste+Connect
        // controls are enabled and the top button stops spinning.
        setBusy(false);
        setStatus("awaiting-code");
        return;
      }

      // Loopback: poll until the local server captures the code.
      const profileRef = profile;
      pollTimer.current = setInterval(async () => {
        const state = pendingState.current;
        if (!state) return;
        try {
          const r = await oauthPoll(state);
          if (r.kind === "ready") {
            stopPolling();
            // The code came back from the poll (and was consumed there); pass
            // it straight to the exchange.
            const t = await oauthExchange(profileRef, state, r.code);
            await oauthStore(profileRef, t);
            setTokens(t);
            setStatus("connected");
            setBusy(false);
          } else if (r.kind === "expired") {
            stopPolling();
            setError("Sign-in timed out. Try again.");
            setStatus("idle");
            setBusy(false);
          }
        } catch (e) {
          stopPolling();
          setError(`Sign-in failed: ${String(e)}`);
          setStatus("idle");
          setBusy(false);
        }
      }, POLL_INTERVAL_MS);
    } catch (e) {
      setError(`Sign-in failed: ${String(e)}`);
      setStatus("idle");
      setBusy(false);
    }
  }, [profile, setError, setStatus, setTokens, stopPolling]);

  const submitManual = useCallback(async () => {
    const state = pendingState.current;
    const code = extractOAuthCode(manualCode);
    if (!state || !code) return;
    setBusy(true);
    setError(null);
    try {
      const t = await oauthExchange(profile, state, code);
      await oauthStore(profile, t);
      setTokens(t);
      setStatus("connected");
      setManualCode("");
      pendingState.current = null;
    } catch (e) {
      setError(`Sign-in failed: ${String(e)}`);
      setStatus("error");
    } finally {
      setBusy(false);
    }
  }, [profile, manualCode, setError, setStatus, setTokens]);

  const disconnect = useCallback(async () => {
    stopPolling();
    const { disconnect } = useOAuthStore.getState();
    await disconnect(profile);
  }, [profile, stopPolling]);

  const isManual = OAUTH_PRESETS[profile].manualCode;

  return {
    status,
    error,
    tokens,
    isManual,
    manualCode,
    setManualCode,
    busy,
    start,
    submitManual,
    disconnect,
  };
}
