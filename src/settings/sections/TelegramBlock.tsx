import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  clearTelegramToken,
  setTelegramToken,
} from "@/modules/telegram/keyring";
import { useTelegramStore } from "@/modules/telegram/store";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SettingRow } from "../components/SettingRow";

/**
 * Relay Telegram messages to Termigo's in-app agent by driving the same agent
 * via `sendMessage`. The token is kept in the OS keychain (never the settings
 * file); `enabled` and the optional owner chat id persist here.
 */
export function TelegramBlock() {
  const enabled = useTelegramStore((s) => s.enabled);
  const online = useTelegramStore((s) => s.online);
  const hasToken = useTelegramStore((s) => s.hasToken);
  const lastError = useTelegramStore((s) => s.lastError);
  const chatId = useTelegramStore((s) => s.chatId);
  const setEnabled = useTelegramStore((s) => s.setEnabled);
  const setChatId = useTelegramStore((s) => s.setChatId);
  const setHasToken = useTelegramStore((s) => s.setHasToken);
  const refresh = useTelegramStore((s) => s.refresh);

  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [chatIdDraft, setChatIdDraft] = useState(chatId ?? "");

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setChatIdDraft(chatId ?? "");
  }, [chatId]);

  const saveToken = async () => {
    if (!token.trim()) {
      toast.info("Paste the bot token from @BotFather first.");
      return;
    }
    setSaving(true);
    try {
      await setTelegramToken(token);
      setHasToken(true);
      setToken("");
      toast.success("Telegram token saved.");
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const removeToken = async () => {
    await clearTelegramToken();
    setHasToken(false);
    toast.info("Telegram token removed.");
    void refresh();
  };

  const status = !hasToken
    ? "not set"
    : !enabled
      ? "disabled"
      : online
        ? "online"
        : "error";

  return (
    <section className="flex flex-col gap-2">
      <Label>Telegram relay</Label>
      <SettingRow
        title="Enable relay"
        description="Start the bot long-poll when a token is set. The bot answers /status, /query <question> and /run <task>."
      >
        <Switch checked={enabled} onCheckedChange={(v) => setEnabled(v)} />
      </SettingRow>

      <SettingRow
        title="Token"
        description="The bot token from @BotFather. Stored in the OS keychain."
      >
        <div className="flex items-center gap-2">
          <Input
            type="password"
            placeholder={hasToken ? "•••••••• (saved)" : "bot token"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="w-64"
          />
          <Button size="sm" onClick={saveToken} disabled={saving}>
            Save
          </Button>
          {hasToken && (
            <Button size="sm" variant="ghost" onClick={removeToken}>
              Remove
            </Button>
          )}
        </div>
      </SettingRow>

      <SettingRow
        title="Owner chat id (optional)"
        description="Only answer this chat (e.g. 123456789). Leave empty to answer anyone who finds the bot — not recommended."
      >
        <div className="flex items-center gap-2">
          <Input
            type="text"
            placeholder="chat id"
            value={chatIdDraft}
            onChange={(e) => setChatIdDraft(e.target.value)}
            className="w-40"
          />
          <Button
            size="sm"
            onClick={() => setChatId(chatIdDraft.trim() || null)}
          >
            Set
          </Button>
        </div>
      </SettingRow>

      <div className="flex items-center gap-3">
        <Badge
          variant={
            status === "online"
              ? "default"
              : status === "error"
                ? "destructive"
                : "secondary"
          }
        >
          {status}
        </Badge>
        <span className="text-[11px] text-muted-foreground">
          {lastError ? `Last error: ${lastError}` : "No errors."}
        </span>
      </div>
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
