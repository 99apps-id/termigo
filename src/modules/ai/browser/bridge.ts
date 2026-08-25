// Typed wrappers over the native `browser_*` Tauri commands. Kept separate
// from the tool definitions so the tools stay thin and the bridge is the only
// place that knows the command names and the camelCase payload shape.

import { invoke } from "@tauri-apps/api/core";

/** Mirrors the Rust `BrowserSnapshot` struct (serde rename_all = camelCase). */
export type BrowserSnapshot = { instance: string; url: string | null };

function unexpected(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function browserOpen(
  instance: string,
  url: string,
): Promise<BrowserSnapshot> {
  try {
    return await invoke<BrowserSnapshot>("browser_open", { instance, url });
  } catch (e) {
    throw new Error(unexpected(e));
  }
}

export async function browserNavigate(
  instance: string,
  url: string,
): Promise<BrowserSnapshot> {
  try {
    return await invoke<BrowserSnapshot>("browser_navigate", { instance, url });
  } catch (e) {
    throw new Error(unexpected(e));
  }
}

export async function browserBack(instance: string): Promise<void> {
  try {
    await invoke("browser_back", { instance });
  } catch (e) {
    throw new Error(unexpected(e));
  }
}

export async function browserForward(instance: string): Promise<void> {
  try {
    await invoke("browser_forward", { instance });
  } catch (e) {
    throw new Error(unexpected(e));
  }
}

export async function browserReload(instance: string): Promise<void> {
  try {
    await invoke("browser_reload", { instance });
  } catch (e) {
    throw new Error(unexpected(e));
  }
}

export async function browserWait(instance: string, ms: number): Promise<void> {
  try {
    await invoke("browser_wait", { instance, ms });
  } catch (e) {
    throw new Error(unexpected(e));
  }
}

export async function browserEval(instance: string, js: string): Promise<void> {
  try {
    await invoke("browser_eval", { instance, js });
  } catch (e) {
    throw new Error(unexpected(e));
  }
}

export async function browserExtract(instance: string): Promise<string> {
  try {
    return await invoke<string>("browser_extract", { instance });
  } catch (e) {
    throw new Error(unexpected(e));
  }
}

export async function browserConsole(instance: string): Promise<string> {
  try {
    return await invoke<string>("browser_console", { instance });
  } catch (e) {
    throw new Error(unexpected(e));
  }
}

export async function browserScreenshot(instance: string): Promise<string> {
  try {
    return await invoke<string>("browser_screenshot", { instance });
  } catch (e) {
    throw new Error(unexpected(e));
  }
}

export async function browserUrl(instance: string): Promise<string> {
  try {
    return await invoke<string>("browser_url", { instance });
  } catch (e) {
    throw new Error(unexpected(e));
  }
}

export async function browserClose(instance: string): Promise<void> {
  try {
    await invoke("browser_close", { instance });
  } catch (e) {
    throw new Error(unexpected(e));
  }
}

export async function browserList(): Promise<string[]> {
  try {
    return await invoke<string[]>("browser_list");
  } catch (e) {
    throw new Error(unexpected(e));
  }
}
