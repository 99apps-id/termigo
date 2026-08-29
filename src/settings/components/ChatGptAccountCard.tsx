import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import { getProvider } from "@/modules/ai/config";
import {
  type ChatGptAccount,
  getChatGptAccount,
  onChatGptAuthChanged,
  signInWithChatGpt,
  signOutChatGpt,
} from "@/modules/ai/lib/chatgptAuth";
import {
  ArrowRight01Icon,
  CheckmarkCircle01Icon,
  Copy01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { ProviderIcon } from "./ProviderIcon";

/**
 * Sign in with a ChatGPT account instead of pasting an API key.
 *
 * Turns run against the ChatGPT subscription rather than API credits. The card
 * is deliberately not a key card: there is no key to show, mask, or reveal, and
 * the only states are "signed out", "waiting for the browser", and "signed in".
 *
 * Best-effort against OpenAI's private Codex backend — it can change without
 * notice, and every failure path surfaces the server's own words.
 */
export function ChatGptAccountCard() {
  const provider = getProvider("chatgpt");
  const [account, setAccount] = useState<ChatGptAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The authorize URL, surfaced while the sign-in is pending. The system browser
  // usually opens on its own, but a locked-down desktop silently does nothing,
  // and then a spinner with no link is a dead end.
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(() => {
    void getChatGptAccount()
      .then(setAccount)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
    return onChatGptAuthChanged(reload);
  }, [reload]);

  useEffect(() => {
    const un = listen<string>("chatgpt-auth-url", (e) => setAuthUrl(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setAccount(await signInWithChatGpt());
    } catch (e) {
      // Rust returns a sentence naming the actual cause (port taken, timed out,
      // refused, token endpoint status). Show it verbatim.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setAuthUrl(null);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await signOutChatGpt();
      setAccount(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderIcon provider="chatgpt" size={16} />
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
            <div className="truncate">{account.email ?? "ChatGPT account"}</div>
            <div className="text-[10.5px] text-muted-foreground">
              {account.plan ? `Plan: ${account.plan}. ` : ""}
              Turns run on the subscription, not API credits.
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
            Use your ChatGPT Plus or Pro subscription instead of an API key.
            Opens your browser to sign in with OpenAI. Best-effort against
            OpenAI's Codex backend.
          </p>
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
              {busy ? "Waiting for browser…" : "Sign in with ChatGPT"}
            </Button>
            {busy && authUrl ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={() => {
                  // Webview clipboard WRITE works (only read is blocked in wry).
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
