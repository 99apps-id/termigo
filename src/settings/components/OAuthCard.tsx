import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { OAuthProfile } from "@/modules/oauth/presets";
import { OAUTH_PRESETS } from "@/modules/oauth/presets";
import { useOAuthConnect } from "@/modules/oauth/useOAuthConnect";
import {
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Logout03Icon,
  Plug01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

/**
 * A sign-in card for one OAuth provider (Codex / Claude / Antigravity).
 * Shows Connected + model info once tokens exist; otherwise a Connect
 * button. Claude uses the manual-code flow (paste the code from the
 * browser); Codex/Antigravity use loopback polling.
 */
export function OAuthCard({ profile }: { profile: OAuthProfile }) {
  const preset = OAUTH_PRESETS[profile];
  const {
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
  } = useOAuthConnect(profile);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  // Reset the collapsed state once we connect so the form hides.
  useEffect(() => {
    if (status === "connected") setExpanded(false);
  }, [status]);

  const connected = status === "connected" && !!tokens;
  const connecting = status === "connecting" || busy;

  const copyToken = async () => {
    if (!tokens?.access_token) return;
    await navigator.clipboard.writeText(tokens.access_token).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br text-[10px] font-bold text-white shadow-sm",
            preset.tile,
          )}
        >
          {preset.shortName.slice(0, 1).toUpperCase()}
        </span>
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
            {preset.displayName}
            {connected ? (
              <Badge
                variant="outline"
                className="h-4 gap-1 border-teal-500/30 bg-teal-500/10 px-1.5 text-[10px] font-normal text-teal-700 dark:text-teal-300"
              >
                <HugeiconsIcon
                  icon={CheckmarkCircle02Icon}
                  size={9}
                  strokeWidth={2}
                />
                Connected
              </Badge>
            ) : null}
          </span>
          <span className="truncate text-[10.5px] text-muted-foreground">
            {preset.tagline} · {preset.defaultModelLabel}
          </span>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {connected ? (
            <>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 text-muted-foreground hover:text-foreground"
                title="Copy access token"
                onClick={() => void copyToken()}
              >
                <HugeiconsIcon icon={Plug01Icon} size={13} strokeWidth={1.75} />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 text-muted-foreground hover:text-destructive"
                title="Disconnect"
                onClick={() => void disconnect()}
              >
                <HugeiconsIcon
                  icon={Logout03Icon}
                  size={13}
                  strokeWidth={1.75}
                />
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              className="h-7 gap-1 px-2.5 text-[11px]"
              disabled={connecting}
              onClick={() => {
                setExpanded(true);
                void start();
              }}
            >
              {connecting ? (
                <Spinner className="size-3" />
              ) : (
                <HugeiconsIcon icon={Plug01Icon} size={12} strokeWidth={2} />
              )}
              {connecting ? "Connecting…" : "Sign in"}
            </Button>
          )}
        </div>
      </div>

      {error ? (
        <p className="text-[10.5px] text-destructive">{error}</p>
      ) : null}

      {!connected && isManual && (expanded || connecting) ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            A browser opened. After you authorize, Anthropic shows a{" "}
            <span className="font-mono">code</span> — paste it here.
          </p>
          <div className="flex gap-1.5">
            <Input
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder="Paste the code"
              className="h-7 text-[11.5px]"
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitManual();
              }}
            />
            <Button
              size="sm"
              className="h-7 shrink-0 px-2.5 text-[11px]"
              disabled={busy || !manualCode.trim()}
              onClick={() => void submitManual()}
            >
              {busy ? <Spinner className="size-3" /> : "Connect"}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-7 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setExpanded(false);
                void disconnect();
              }}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
            </Button>
          </div>
        </div>
      ) : null}

      {connected ? (
        <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <span className="truncate font-mono">
            {tokens?.access_token
              ? `${tokens.access_token.slice(0, 6)}…${tokens.access_token.slice(-4)}`
              : "—"}
          </span>
          {copied ? <span className="text-teal-600">copied</span> : null}
        </div>
      ) : null}
    </div>
  );
}
