import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import { getProvider, type OAuthProviderId } from "@/modules/ai/config";
import {
  type OAuthAccount,
  getOAuthAccount,
  onOAuthAuthChanged,
  signInWithOAuth,
  signOutOAuth,
} from "@/modules/ai/lib/oauthAuth";
import {
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  CheckmarkCircle01Icon,
  Copy01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import { ProviderIcon } from "./ProviderIcon";

type DevicePromptPayload = {
  provider: string;
  user_code: string;
  verification_uri: string;
};

const OAUTH_DESCRIPTIONS: Record<OAuthProviderId, string> = {
  chatgpt:
    "Use your ChatGPT Plus or Pro subscription. Opens your browser to sign in with OpenAI via Codex.",
  "claude-oauth":
    "Sign in with your Anthropic Claude account via OAuth to run turns against Claude models.",
  "xai-oauth":
    "Sign in with xAI Grok via device authorization to use Grok models.",
  "github-copilot":
    "Sign in with your GitHub account to run models through GitHub Copilot.",
  antigravity:
    "Sign in with Google Cloud Code / Antigravity through OAuth.",
  muse:
    "Sign in with Meta Muse Code via device authorization.",
};

type Props = {
  providerId: OAuthProviderId;
};

export function OAuthProviderCard({ providerId }: Props) {
  const provider = getProvider(providerId);
  const [account, setAccount] = useState<OAuthAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [devicePrompt, setDevicePrompt] = useState<DevicePromptPayload | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(() => {
    void getOAuthAccount(providerId)
      .then(setAccount)
      .finally(() => setLoading(false));
  }, [providerId]);

  useEffect(() => {
    reload();
    return onOAuthAuthChanged(reload);
  }, [reload]);

  useEffect(() => {
    const unUrl = listen<string>("oauth-auth-url", (e) => {
      setAuthUrl(e.payload);
    });
    const unChatgpt = listen<string>("chatgpt-auth-url", (e) => {
      if (providerId === "chatgpt") setAuthUrl(e.payload);
    });
    const unPrompt = listen<DevicePromptPayload>("oauth-device-prompt", (e) => {
      if (e.payload.provider === providerId || (providerId === "chatgpt" && e.payload.provider === "openai-codex")) {
        setDevicePrompt(e.payload);
      }
    });

    return () => {
      void unUrl.then((f) => f());
      void unChatgpt.then((f) => f());
      void unPrompt.then((f) => f());
    };
  }, [providerId]);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    setAuthUrl(null);
    setDevicePrompt(null);
    try {
      setAccount(await signInWithOAuth(providerId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setAuthUrl(null);
      setDevicePrompt(null);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await signOutOAuth(providerId);
      setAccount(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderIcon provider={providerId} size={16} />
        <span className="text-[12.5px] font-medium">{provider.label}</span>
        {account ? (
          <Badge
            variant="outline"
            className="ml-1 h-4 gap-1 border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-500"
          >
            <HugeiconsIcon
              icon={CheckmarkCircle01Icon}
              size={9}
              strokeWidth={2}
            />
            Signed in
          </Badge>
        ) : null}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Spinner className="size-3" />
          Checking…
        </div>
      ) : account ? (
        <>
          <div className="min-w-0 text-[11px]">
            <div className="truncate">{account.email ?? `${provider.label} account`}</div>
            <div className="text-[10.5px] text-muted-foreground">
              {account.plan ? `Plan: ${account.plan}. ` : ""}
              Connected via OAuth subscription.
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={DESTRUCTIVE_ACTION}
              disabled={busy}
              onClick={() => void signOut()}
            >
              Sign out
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[10.5px] text-muted-foreground">
            {OAUTH_DESCRIPTIONS[providerId]}
          </p>

          {devicePrompt ? (
            <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[11px]">
              <div className="font-medium text-amber-500">Device verification required:</div>
              <div className="mt-1 flex items-center gap-2">
                <span>Enter code:</span>
                <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[12px] font-semibold text-foreground">
                  {devicePrompt.user_code}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1 text-[10px]"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(devicePrompt.user_code)
                      .then(() => setCopied(true));
                  }}
                >
                  <HugeiconsIcon icon={Copy01Icon} size={10} strokeWidth={2} />
                  {copied ? "Copied" : "Copy code"}
                </Button>
              </div>
              <div className="mt-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 gap-1 px-2 text-[10px]"
                  onClick={() => {
                    void openUrl(devicePrompt.verification_uri);
                  }}
                >
                  <HugeiconsIcon icon={ArrowUpRight01Icon} size={10} strokeWidth={2} />
                  Open {devicePrompt.verification_uri}
                </Button>
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px]"
              disabled={busy}
              onClick={() => void signIn()}
            >
              {busy ? (
                <Spinner className="size-3" />
              ) : (
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  size={11}
                  strokeWidth={2}
                />
              )}
              {busy
                ? devicePrompt
                  ? "Waiting for verification…"
                  : "Waiting for browser…"
                : `Sign in with ${provider.label}`}
            </Button>
            {busy && authUrl ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(authUrl)
                    .then(() => setCopied(true));
                }}
              >
                <HugeiconsIcon icon={Copy01Icon} size={11} strokeWidth={2} />
                {copied ? "Link copied" : "Copy sign-in link"}
              </Button>
            ) : null}
          </div>
        </>
      )}

      {error ? <p className="text-[10.5px] text-destructive">{error}</p> : null}
    </div>
  );
}
