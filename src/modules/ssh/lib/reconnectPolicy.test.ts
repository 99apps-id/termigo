import { describe, expect, it } from "vitest";
import {
  backoffMs,
  gaveUpNotice,
  MAX_ATTEMPTS,
  reconnectedNotice,
  reconnectNotice,
  shouldReconnect,
} from "./reconnectPolicy";

const ctx = (
  over: Partial<{ closedByUser: boolean; attempts: number }> = {},
) => ({
  closedByUser: false,
  attempts: 0,
  ...over,
});

// The failure worth preventing is not a failed reconnect - it is reconnecting
// a session the user deliberately closed. Both arrive as exit code 0; only the
// `clean` flag separates them, and it comes from whether the remote sent an
// exit status before the channel ended.
describe("reconnecting only when the link died", () => {
  it("reconnects when the channel ended with no exit status", () => {
    expect(shouldReconnect({ code: 0, clean: false }, ctx())).toBe(true);
  });

  it("does not reconnect after the user typed exit", () => {
    expect(shouldReconnect({ code: 0, clean: true }, ctx())).toBe(false);
  });

  // A command that failed still exited on purpose. Reconnecting there would
  // resurrect a shell whose job was done.
  it("does not reconnect on a non-zero clean exit", () => {
    expect(shouldReconnect({ code: 1, clean: true }, ctx())).toBe(false);
  });

  it("does not reconnect a tab the user closed", () => {
    expect(
      shouldReconnect({ code: 0, clean: false }, ctx({ closedByUser: true })),
    ).toBe(false);
  });

  it("closing wins even over a dropped link, since the tab is going away", () => {
    expect(
      shouldReconnect(
        { code: -1, clean: false },
        ctx({ closedByUser: true, attempts: 1 }),
      ),
    ).toBe(false);
  });

  it("gives up after the attempt cap", () => {
    expect(
      shouldReconnect(
        { code: 0, clean: false },
        ctx({ attempts: MAX_ATTEMPTS }),
      ),
    ).toBe(false);
  });

  it("still tries on the last allowed attempt", () => {
    expect(
      shouldReconnect(
        { code: 0, clean: false },
        ctx({ attempts: MAX_ATTEMPTS - 1 }),
      ),
    ).toBe(true);
  });
});

describe("backoff", () => {
  it("doubles from one second", () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([1000, 2000, 4000, 8000]);
  });

  // Capped because the common cause is a laptop lid or a tunnel blip. Beyond
  // this, a manual reconnect is faster than waiting.
  it("caps rather than growing without bound", () => {
    expect(backoffMs(5)).toBe(16000);
    expect(backoffMs(50)).toBe(16000);
  });

  it("treats a zeroth attempt as the first", () => {
    expect(backoffMs(0)).toBe(1000);
  });

  it("spans well under a minute in total", () => {
    const total = Array.from({ length: MAX_ATTEMPTS }, (_, i) =>
      backoffMs(i + 1),
    ).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(60_000);
  });
});

describe("what the terminal is told", () => {
  it("counts the attempt and the wait", () => {
    const line = reconnectNotice(2, 2000);
    expect(line).toContain("2s");
    expect(line).toContain(`2/${MAX_ATTEMPTS}`);
  });

  // A reconnected shell is a new shell. Saying so is the difference between a
  // confusing `pwd` and an expected one.
  it("says the shell is new rather than resumed", () => {
    expect(reconnectedNotice()).toMatch(/new shell/i);
    expect(reconnectedNotice()).toMatch(/working directory/i);
  });

  it("says what to do after giving up", () => {
    expect(gaveUpNotice()).toMatch(/reopen the tab/i);
  });

  it("keeps every notice on its own line", () => {
    for (const line of [
      reconnectNotice(1, 1000),
      reconnectedNotice(),
      gaveUpNotice(),
    ]) {
      expect(line.startsWith("\r\n")).toBe(true);
      expect(line.endsWith("\r\n")).toBe(true);
    }
  });
});
