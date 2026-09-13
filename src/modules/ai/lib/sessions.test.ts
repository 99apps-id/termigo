import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it, vi } from "vitest";

// The session store is a Tauri LazyStore (unavailable in node tests), so stub
// the plugin with an in-memory map that also records how it was read.
const harness = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  const calls: string[] = [];
  class FakeLazyStore {
    constructor(
      public path: string,
      public opts: unknown,
    ) {
      void this.path;
      void this.opts;
    }
    async get<T>(key: string): Promise<T | undefined> {
      calls.push(`get:${key}`);
      return data.get(key) as T | undefined;
    }
    async set(key: string, value: unknown): Promise<void> {
      data.set(key, value);
    }
    async entries(): Promise<Array<[string, unknown]>> {
      calls.push("entries");
      return [...data.entries()];
    }
  }
  return { data, calls, FakeLazyStore };
});

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: harness.FakeLazyStore,
}));

import { extractMessageText, loadAll } from "./sessions";

const msg = (role: "user" | "assistant", ...texts: string[]): UIMessage =>
  ({
    id: `${role}-${texts.join("|")}`,
    role,
    parts: texts.map((text) => ({ type: "text", text })),
  }) as UIMessage;

describe("extractMessageText", () => {
  it("concatenates all text parts across roles, lowercased", () => {
    const text = extractMessageText([
      msg("user", "Deploy the API"),
      msg("assistant", "Running the DEPLOY now"),
    ]);
    expect(text).toContain("deploy the api");
    expect(text).toContain("running the deploy now");
  });

  it("strips injected context wrappers so search matches real content", () => {
    const text = extractMessageText([
      msg(
        "user",
        "<terminal-context>secret-noise</terminal-context>\nfix the bug",
      ),
    ]);
    expect(text).toContain("fix the bug");
    expect(text).not.toContain("secret-noise");
  });

  it("ignores non-text parts and empty conversations", () => {
    const withTool = {
      id: "a",
      role: "assistant",
      parts: [{ type: "tool-invocation", toolName: "bash_run" }],
    } as unknown as UIMessage;
    expect(extractMessageText([withTool])).toBe("");
    expect(extractMessageText([])).toBe("");
  });
});

describe("loadAll", () => {
  const seed = () => {
    harness.data.clear();
    harness.data.set("sessions", [
      { id: "s-1", title: "first", createdAt: 1, updatedAt: 2 },
      { id: "s-2", title: "second", createdAt: 3, updatedAt: 4 },
    ]);
    harness.data.set("activeId", "s-2");
    // The key that makes enumerating the store expensive: every session's
    // transcript lives here alongside the two keys above.
    harness.data.set("messages:s-1", [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "x".repeat(50_000) }],
      },
    ]);
    harness.data.set("messages:s-2", [
      {
        id: "m2",
        role: "assistant",
        parts: [{ type: "text", text: "y".repeat(50_000) }],
      },
    ]);
    harness.calls.length = 0;
  };

  it("returns the session list and the active id", async () => {
    seed();
    const loaded = await loadAll();
    expect(loaded.sessions.map((s) => s.id)).toEqual(["s-1", "s-2"]);
    expect(loaded.activeId).toBe("s-2");
  });

  it("defaults when the keys were never written", async () => {
    harness.data.clear();
    harness.calls.length = 0;
    const loaded = await loadAll();
    expect(loaded.sessions).toEqual([]);
    expect(loaded.activeId).toBeNull();
  });

  it("reads the two known keys and never enumerates the store", async () => {
    // The invariant: boot must not pull every transcript into the webview.
    // `entries()` returns every value in the file, so a regression here is a
    // memory regression on every launch of a long-lived install.
    seed();
    await loadAll();
    expect(harness.calls).not.toContain("entries");
    expect(harness.calls.filter((c) => c.startsWith("get:")).sort()).toEqual([
      "get:activeId",
      "get:sessions",
    ]);
  });
});
