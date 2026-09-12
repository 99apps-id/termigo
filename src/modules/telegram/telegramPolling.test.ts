// The update offset is the bot's only record of what it has already handled.
//
// Telegram keeps an unconfirmed update for ~24h and redelivers it on the next
// `getUpdates`, so a module-level offset that reset to 0 on every restart
// replayed the backlog: an old `/run`, `/approve` or `/mode all` ran a second
// time. These pin the persistence that stops it.

import { afterEach, describe, expect, it, vi } from "vitest";

function fakeLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    api: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
  };
}

describe("telegram update offset persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("restores the stored offset instead of starting from 0", async () => {
    vi.stubGlobal(
      "localStorage",
      fakeLocalStorage({ "termigo-telegram-offset": "777" }).api,
    );
    vi.resetModules();
    const mod = await import("./telegramPolling");
    expect(mod.currentUpdateOffset).toBe(777);
  });

  it("ignores a missing or malformed stored offset", async () => {
    vi.stubGlobal(
      "localStorage",
      fakeLocalStorage({ "termigo-telegram-offset": "not-a-number" }).api,
    );
    vi.resetModules();
    const mod = await import("./telegramPolling");
    expect(mod.currentUpdateOffset).toBe(0);
  });

  it("persists each advance of the offset", async () => {
    const { api, store } = fakeLocalStorage();
    vi.stubGlobal("localStorage", api);
    vi.resetModules();
    const mod = await import("./telegramPolling");
    mod.setCurrentUpdateOffset(500);
    expect(mod.currentUpdateOffset).toBe(500);
    expect(store.get("termigo-telegram-offset")).toBe("500");
  });

  it("still advances when localStorage is unavailable", async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    const mod = await import("./telegramPolling");
    expect(() => mod.setCurrentUpdateOffset(9)).not.toThrow();
    expect(mod.currentUpdateOffset).toBe(9);
  });
});
