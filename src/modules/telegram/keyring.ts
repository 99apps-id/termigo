// Telegram bot token, stored in the OS keychain (never in a settings file).

import { invoke } from "@tauri-apps/api/core";

const SERVICE = "termigo-telegram";
const ACCOUNT = "token";

export async function getTelegramToken(): Promise<string | null> {
  try {
    const v = await invoke<string | null>("secrets_get", {
      service: SERVICE,
      account: ACCOUNT,
    });
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function setTelegramToken(token: string): Promise<void> {
  const t = token.trim();
  if (!t) throw new Error("Token is empty");
  await invoke("secrets_set", {
    service: SERVICE,
    account: ACCOUNT,
    password: t,
  });
}

export async function clearTelegramToken(): Promise<void> {
  try {
    await invoke("secrets_delete", { service: SERVICE, account: ACCOUNT });
  } catch {
    // ignore
  }
}
