// The Telegram token cache.
//
// The failure this guards against is silent: a read that comes back empty
// before the native secret store has loaded used to be cached for the process
// lifetime, so the relay never started and nothing retried. It was measured on
// a headless install after a deploy - the app came up healthy, localStorage
// still said `enabled: true`, and Telegram stayed dead until a restart.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  clearTelegramToken,
  getTelegramToken,
  resetTelegramTokenCache,
  setTelegramToken,
} from "./keyring";

/** How many times the keychain was asked for the token account. */
const tokenReads = () =>
  invokeMock.mock.calls.filter(
    ([cmd, args]) =>
      cmd === "secrets_get" &&
      (args as { account?: string } | undefined)?.account === "token",
  ).length;

beforeEach(() => {
  invokeMock.mockReset();
  resetTelegramTokenCache();
});

describe("getTelegramToken", () => {
  it("does not cache an empty read, so a later read can still find the token", () => {
    // THE regression: the store answered "nothing" at boot, the null was
    // cached, and every later caller was told there was no token forever.
    invokeMock.mockResolvedValueOnce(null);
    invokeMock.mockResolvedValueOnce("1234:token");

    return getTelegramToken()
      .then((first) => {
        expect(first).toBeNull();
        return getTelegramToken();
      })
      .then((second) => {
        expect(second).toBe("1234:token");
        expect(tokenReads()).toBe(2);
      });
  });

  it("also retries when the store answers with an empty string", () => {
    invokeMock.mockResolvedValueOnce("");
    invokeMock.mockResolvedValueOnce("1234:token");
    return getTelegramToken().then((first) => {
      expect(first).toBeNull();
      return getTelegramToken().then((second) => {
        expect(second).toBe("1234:token");
      });
    });
  });

  it("caches a token it found, so the poll path stops touching the keychain", () => {
    invokeMock.mockResolvedValue("1234:token");
    return Promise.all([getTelegramToken(), getTelegramToken()]).then(
      ([a, b]) => {
        expect(a).toBe("1234:token");
        expect(b).toBe("1234:token");
        return getTelegramToken().then(() => {
          // One read for the first caller; the rest are served from memory.
          expect(tokenReads()).toBe(1);
        });
      },
    );
  });

  it("does not cache a read that threw", () => {
    invokeMock.mockRejectedValueOnce(new Error("keychain not ready"));
    invokeMock.mockResolvedValueOnce("1234:token");
    return getTelegramToken().then((first) => {
      expect(first).toBeNull();
      return getTelegramToken().then((second) => {
        expect(second).toBe("1234:token");
      });
    });
  });
});

describe("set and clear", () => {
  it("caches the token it wrote, without reading it back", () => {
    invokeMock.mockResolvedValue(undefined);
    return setTelegramToken("  1234:fresh  ").then(() =>
      getTelegramToken().then((token) => {
        expect(token).toBe("1234:fresh");
        expect(tokenReads()).toBe(0);
      }),
    );
  });

  it("refuses an empty token", () => {
    invokeMock.mockResolvedValue(undefined);
    return setTelegramToken("   ").then(
      () => {
        throw new Error("expected setTelegramToken to reject");
      },
      () => undefined,
    );
  });

  it("makes a cleared token re-readable, so a re-pair is seen", () => {
    invokeMock.mockResolvedValue(undefined);
    return setTelegramToken("1234:old")
      .then(() => clearTelegramToken())
      .then(() => {
        invokeMock.mockResolvedValue("1234:new");
        return getTelegramToken();
      })
      .then((token) => {
        expect(token).toBe("1234:new");
      });
  });
});
