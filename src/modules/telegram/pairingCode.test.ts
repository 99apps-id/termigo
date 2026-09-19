import { beforeEach, describe, expect, it } from "vitest";
import { useTelegramStore } from "./store";

describe("telegram pairing code", () => {
  beforeEach(() => {
    useTelegramStore.setState({ pairingCode: null, chatId: null });
  });

  it("generates a stable six-digit code", () => {
    const first = useTelegramStore.getState().ensurePairingCode();
    expect(first).toMatch(/^\d{6}$/);
    expect(useTelegramStore.getState().ensurePairingCode()).toBe(first);
  });

  it("regenerates to a (practically always) different code", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      seen.add(useTelegramStore.getState().regeneratePairingCode());
    }
    // Five draws from 10^6 values collide with probability ~1e-11; if this
    // ever flakes, the RNG - not the assertion - is broken.
    expect(seen.size).toBeGreaterThan(1);
  });

  it("clears single-use after pairing", () => {
    useTelegramStore.getState().ensurePairingCode();
    expect(useTelegramStore.getState().pairingCode).not.toBeNull();
    useTelegramStore.getState().clearPairingCode();
    expect(useTelegramStore.getState().pairingCode).toBeNull();
  });
});
