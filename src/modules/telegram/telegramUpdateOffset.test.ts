import { describe, expect, it } from "vitest";

import {
  botIdFromToken,
  loadUpdateOffset,
  offsetStorageKey,
  parseStoredOffset,
  saveUpdateOffset,
} from "./telegramUpdateOffset";

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    size: () => map.size,
  };
}

describe("telegramUpdateOffset", () => {
  describe("botIdFromToken", () => {
    it("extracts the numeric bot id from a token", () => {
      expect(botIdFromToken("123456789:AAF-secret-part")).toBe("123456789");
    });

    it("trims and rejects a non-numeric prefix", () => {
      expect(botIdFromToken(" 42 :secret")).toBe("42");
      expect(botIdFromToken("bot:secret")).toBeNull();
      expect(botIdFromToken(":secret")).toBeNull();
    });

    it("returns null for a missing token", () => {
      expect(botIdFromToken(null)).toBeNull();
      expect(botIdFromToken(undefined)).toBeNull();
      expect(botIdFromToken("")).toBeNull();
    });
  });

  describe("parseStoredOffset", () => {
    it("accepts non-negative integers", () => {
      expect(parseStoredOffset("0")).toBe(0);
      expect(parseStoredOffset("150")).toBe(150);
    });

    it("falls back to 0 for anything else", () => {
      expect(parseStoredOffset(null)).toBe(0);
      expect(parseStoredOffset("-5")).toBe(0);
      expect(parseStoredOffset("1.5")).toBe(0);
      expect(parseStoredOffset("abc")).toBe(0);
    });
  });

  describe("durable offset", () => {
    it("round-trips an offset, which is what survives a restart", () => {
      const store = fakeStorage();
      saveUpdateOffset("123", 500, store);
      expect(loadUpdateOffset("123", store)).toBe(500);
      // A second read is what the restarted relay performs.
      expect(loadUpdateOffset("123", store)).toBe(500);
    });

    it("keeps separate bots from sharing an offset", () => {
      const store = fakeStorage();
      saveUpdateOffset("111", 10, store);
      saveUpdateOffset("222", 99, store);
      expect(loadUpdateOffset("111", store)).toBe(10);
      expect(loadUpdateOffset("222", store)).toBe(99);
    });

    it("returns 0 when nothing was stored yet", () => {
      expect(loadUpdateOffset("123", fakeStorage())).toBe(0);
    });

    it("does nothing without a bot id", () => {
      const store = fakeStorage();
      saveUpdateOffset(null, 500, store);
      expect(store.size()).toBe(0);
      expect(loadUpdateOffset(null, store)).toBe(0);
    });

    it("rejects negative and non-integer offsets", () => {
      const store = fakeStorage();
      saveUpdateOffset("123", -1, store);
      saveUpdateOffset("123", 1.5, store);
      expect(store.size()).toBe(0);
    });

    it("is a no-op when storage is unavailable", () => {
      expect(loadUpdateOffset("123", null)).toBe(0);
      expect(() => saveUpdateOffset("123", 5, null)).not.toThrow();
    });

    it("keys by bot id", () => {
      expect(offsetStorageKey("123")).toBe("termigo-telegram-offset:123");
    });
  });
});
