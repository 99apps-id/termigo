import { describe, expect, it, vi } from "vitest";
import { type CwdSyncTarget, syncShellCwd } from "./useTerminalSession";

// Linux: a pane's directory is read from the OS so it stays right when OSC 7
// stops arriving (no integration, a replaced prompt hook, tmux). These pin the
// decisions around that read, not the Tauri call itself.
function target(over: Partial<CwdSyncTarget> = {}): CwdSyncTarget {
  return {
    pty: { id: 7 } as CwdSyncTarget["pty"],
    disposed: false,
    shellExited: false,
    opener: null,
    visibleNow: true,
    lastCwd: "/home/me/termixgo",
    callbacks: { onCwd: vi.fn() },
    ...over,
  };
}

describe("syncShellCwd", () => {
  it("follows the shell after `cd ~` even when OSC 7 reported once before", async () => {
    // lastCwd came from an OSC 7 at the first prompt; OSC 7 then stopped.
    const s = target();
    const read = vi.fn(async () => "/home/me");
    expect(await syncShellCwd(s, read)).toBe(true);
    expect(s.lastCwd).toBe("/home/me");
    expect(s.callbacks.onCwd).toHaveBeenCalledWith("/home/me");
  });

  it("passes the last known path as the hint", async () => {
    const read = vi.fn(async () => "/home/me/termixgo");
    await syncShellCwd(target(), read);
    expect(read).toHaveBeenCalledWith(7, "/home/me/termixgo");
  });

  it("does nothing when the OS agrees with the pane", async () => {
    const s = target();
    expect(await syncShellCwd(s, async () => "/home/me/termixgo")).toBe(false);
    expect(s.callbacks.onCwd).not.toHaveBeenCalled();
  });

  it("ignores an empty answer", async () => {
    const s = target();
    expect(await syncShellCwd(s, async () => null)).toBe(false);
    expect(s.lastCwd).toBe("/home/me/termixgo");
  });

  it("does not let an older answer overwrite an OSC 7 that landed meanwhile", async () => {
    const s = target();
    const read = vi.fn(async () => {
      // The prompt hook reports a newer directory while the OS call is in flight.
      s.lastCwd = "/srv/app";
      return "/home/me";
    });
    expect(await syncShellCwd(s, read)).toBe(false);
    expect(s.lastCwd).toBe("/srv/app");
    expect(s.callbacks.onCwd).not.toHaveBeenCalled();
  });

  it("skips panes it must not read", async () => {
    const read = vi.fn(async () => "/elsewhere");
    for (const over of [
      { pty: null },
      { disposed: true },
      { shellExited: true },
      { visibleNow: false },
      // An SSH pane reports remote paths; a local /proc read would be wrong.
      {
        opener: (() => Promise.reject()) as unknown as CwdSyncTarget["opener"],
      },
    ] satisfies Array<Partial<CwdSyncTarget>>) {
      const s = target(over);
      expect(await syncShellCwd(s, read)).toBe(false);
      expect(s.lastCwd).toBe("/home/me/termixgo");
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("survives the shell exiting mid-read", async () => {
    const s = target();
    const read = vi.fn(async () => {
      throw new Error("no PTY session 7");
    });
    expect(await syncShellCwd(s, read)).toBe(false);
    expect(s.lastCwd).toBe("/home/me/termixgo");
  });

  it("drops the answer when the pane's pty was replaced during the read", async () => {
    const s = target();
    const read = vi.fn(async () => {
      s.pty = { id: 9 } as CwdSyncTarget["pty"];
      return "/home/me";
    });
    expect(await syncShellCwd(s, read)).toBe(false);
    expect(s.lastCwd).toBe("/home/me/termixgo");
  });
});
