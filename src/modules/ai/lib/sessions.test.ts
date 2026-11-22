import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it, vi } from "vitest";

// The session store is a Tauri LazyStore (unavailable in node tests), so stub
// the plugin with an in-memory map-of-maps keyed by store path that also
// records operations and supports simulated save failures.
const harness = vi.hoisted(() => {
  const files = new Map<string, Map<string, unknown>>();
  const calls: string[] = [];
  const closedPaths = new Set<string>();
  let failSaveForPath: string | null = null;
  let invokeImpl:
    | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>)
    | null = null;

  const getFile = (path: string) => {
    let m = files.get(path);
    if (!m) {
      m = new Map<string, unknown>();
      files.set(path, m);
    }
    return m;
  };

  class FakeLazyStore {
    constructor(
      public path: string,
      public opts: unknown,
    ) {
      void this.opts;
    }
    async get<T>(key: string): Promise<T | undefined> {
      calls.push(`get:${this.path}:${key}`);
      return getFile(this.path).get(key) as T | undefined;
    }
    async set(key: string, value: unknown): Promise<void> {
      calls.push(`set:${this.path}:${key}`);
      getFile(this.path).set(key, value);
    }
    async has(key: string): Promise<boolean> {
      return getFile(this.path).has(key);
    }
    async delete(key: string): Promise<boolean> {
      calls.push(`delete:${this.path}:${key}`);
      return getFile(this.path).delete(key);
    }
    async clear(): Promise<void> {
      calls.push(`clear:${this.path}`);
      getFile(this.path).clear();
    }
    async save(): Promise<void> {
      calls.push(`save:${this.path}`);
      if (failSaveForPath === this.path) {
        throw new Error(`simulated save failure for ${this.path}`);
      }
    }
    async close(): Promise<void> {
      calls.push(`close:${this.path}`);
      closedPaths.add(this.path);
    }
    async entries(): Promise<Array<[string, unknown]>> {
      calls.push("entries");
      return [...getFile(this.path).entries()];
    }
  }
  return {
    files,
    calls,
    closedPaths,
    getFile,
    setFailSaveForPath: (p: string | null) => {
      failSaveForPath = p;
    },
    setInvokeImpl: (
      fn:
        | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>)
        | null,
    ) => {
      invokeImpl = fn;
    },
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      if (invokeImpl) return invokeImpl(cmd, args);
      return Promise.reject(new TypeError("window is not defined"));
    },
    FakeLazyStore,
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) =>
    harness.invoke(cmd, args),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: harness.FakeLazyStore,
}));

import {
  _resetMigrationForTest,
  buildSessionSearchIndex,
  capPersistedMessages,
  closeSessionStore,
  deleteRunInFlight,
  deleteRunMeta,
  deleteSessionData,
  ensureLegacyMigrated,
  extractMessageText,
  loadAll,
  loadMessages,
  loadRunInFlight,
  loadRunMeta,
  MAX_PERSISTED_OUTPUT_CHARS,
  saveActiveId,
  saveMessages,
  saveRunInFlight,
  saveRunMeta,
  saveSessionsList,
  sessionStorePath,
} from "./sessions";

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
  const META_PATH = "termigo-ai-sessions.json";
  const seed = () => {
    harness.files.clear();
    harness.closedPaths.clear();
    harness.setFailSaveForPath(null);
    const meta = harness.getFile(META_PATH);
    meta.set("sessions", [
      { id: "s-1", title: "first", createdAt: 1, updatedAt: 2 },
      { id: "s-2", title: "second", createdAt: 3, updatedAt: 4 },
    ]);
    meta.set("activeId", "s-2");
    // Legacy transcript keys alongside the two metadata keys.
    meta.set("messages:s-1", [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "x".repeat(50_000) }],
      },
    ]);
    meta.set("messages:s-2", [
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
    harness.files.clear();
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
      `get:${META_PATH}:activeId`,
      `get:${META_PATH}:sessions`,
    ]);
  });
});

describe("capPersistedMessages", () => {
  const toolMsg = (output: unknown): UIMessage =>
    ({
      id: "m-tool",
      role: "assistant",
      parts: [
        {
          type: "tool-read_file",
          toolCallId: "t1",
          state: "output-available",
          output,
        },
      ],
    }) as unknown as UIMessage;

  it("passes small transcripts through by reference", () => {
    const messages = [msg("user", "hello"), toolMsg({ content: "small" })];
    expect(capPersistedMessages(messages)).toBe(messages);
  });

  it("truncates an oversized string output, keeping head and tail", () => {
    const big = "H".repeat(40_000) + "M".repeat(100_000) + "T".repeat(40_000);
    const [capped] = capPersistedMessages([toolMsg(big)]);
    const out = (capped.parts[0] as { output: string }).output;
    expect(out.length).toBeLessThan(big.length);
    expect(out.startsWith("H")).toBe(true);
    expect(out.endsWith("T")).toBe(true);
    expect(out).toContain("truncated for session storage");
  });

  it("truncates oversized top-level string fields of an object output", () => {
    const big = "x".repeat(MAX_PERSISTED_OUTPUT_CHARS + 10);
    const [capped] = capPersistedMessages([
      toolMsg({ stdout: big, stderr: "ok", exit_code: 0 }),
    ]);
    const out = (capped.parts[0] as { output: Record<string, unknown> }).output;
    expect((out.stdout as string).length).toBeLessThan(big.length);
    expect(out.stderr).toBe("ok");
    expect(out.exit_code).toBe(0);
  });

  it("leaves text parts — the user's and model's words — untouched", () => {
    const hugeText = "word ".repeat(50_000);
    const messages = [msg("user", hugeText)];
    expect(capPersistedMessages(messages)).toBe(messages);
  });

  it("does not mutate the input messages", () => {
    const big = "x".repeat(MAX_PERSISTED_OUTPUT_CHARS + 10);
    const original = toolMsg(big);
    capPersistedMessages([original]);
    const out = (original.parts[0] as { output: string }).output;
    expect(out).toBe(big);
  });

  it("saveMessages persists the capped copy to the per-session store", async () => {
    harness.files.clear();
    const big = "x".repeat(MAX_PERSISTED_OUTPUT_CHARS + 10);
    await saveMessages("s-cap", [toolMsg(big)]);
    const stored = harness
      .getFile(sessionStorePath("s-cap"))
      .get("messages") as UIMessage[];
    const out = (stored[0].parts[0] as { output: string }).output;
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain("truncated for session storage");
    // Monolithic store must not receive the message blob.
    expect(
      harness.getFile("termigo-ai-sessions.json").has("messages:s-cap"),
    ).toBe(false);
  });
});

describe("per-session LazyStore persistence, migration, concurrency, and recovery", () => {
  const META_PATH = "termigo-ai-sessions.json";

  it("encodes cross-platform safe, collision-free per-session filenames", () => {
    const p1 = sessionStorePath("123456:789");
    const p2 = sessionStorePath("-100123:42");
    const p3 = sessionStorePath("s-abc-123");
    expect(p1).not.toContain(":");
    expect(p2).not.toContain(":");
    expect(p1).not.toBe(p2);
    expect(p3).toBe("termigo-ai-session-s-abc-123.json");
    expect(sessionStorePath("a:b")).not.toBe(sessionStorePath("a_3a_b"));
    expect(sessionStorePath("a*b?c<d>e|f")).not.toMatch(/[*?<>|]/);
  });

  it("losslessly migrates legacy messages on loadMessages and removes the legacy key", async () => {
    harness.files.clear();
    harness.setFailSaveForPath(null);
    const id = "s-mig-lossless";
    const legacyMsgs = [
      msg("user", "hello legacy"),
      msg("assistant", "x".repeat(MAX_PERSISTED_OUTPUT_CHARS + 500)),
    ];
    harness.getFile(META_PATH).set(`messages:${id}`, legacyMsgs);

    const loaded = await loadMessages(id);
    expect(loaded).toEqual(legacyMsgs);

    // Per-session store now holds the exact legacy transcript.
    expect(harness.getFile(sessionStorePath(id)).get("messages")).toEqual(
      legacyMsgs,
    );
    // Legacy key was removed from the monolithic metadata store.
    expect(harness.getFile(META_PATH).has(`messages:${id}`)).toBe(false);
  });

  it("migrates empty legacy arrays cleanly without treating them as missing", async () => {
    harness.files.clear();
    harness.setFailSaveForPath(null);
    const id = "s-mig-empty";
    harness.getFile(META_PATH).set(`messages:${id}`, []);

    const loaded = await loadMessages(id);
    expect(loaded).toEqual([]);
    expect(harness.getFile(sessionStorePath(id)).get("messages")).toEqual([]);
    expect(harness.getFile(META_PATH).has(`messages:${id}`)).toBe(false);
  });

  it("preserves legacy messages if flushing the per-session store fails", async () => {
    harness.files.clear();
    const id = "s-mig-fail";
    const perSessionPath = sessionStorePath(id);
    const legacyMsgs = [msg("user", "do not lose me")];
    harness.getFile(META_PATH).set(`messages:${id}`, legacyMsgs);
    harness.setFailSaveForPath(perSessionPath);

    await expect(loadMessages(id)).rejects.toThrow(/simulated save failure/);
    // Legacy copy must still be intact in termigo-ai-sessions.json.
    expect(harness.getFile(META_PATH).get(`messages:${id}`)).toEqual(
      legacyMsgs,
    );

    // Retry once disk write recovers.
    harness.setFailSaveForPath(null);
    const recovered = await loadMessages(id);
    expect(recovered).toEqual(legacyMsgs);
    expect(harness.getFile(META_PATH).has(`messages:${id}`)).toBe(false);
  });

  it("removes stale legacy messages when saveMessages runs before loadMessages", async () => {
    harness.files.clear();
    harness.setFailSaveForPath(null);
    const id = "s-save-over-legacy";
    harness.getFile(META_PATH).set(`messages:${id}`, [msg("user", "old")]);
    const fresh = [msg("user", "new")];

    await saveMessages(id, fresh);
    expect(harness.getFile(META_PATH).has(`messages:${id}`)).toBe(false);
    expect(await loadMessages(id)).toEqual(fresh);
  });

  it("serializes concurrent loadMessages calls for the same session so migration runs once", async () => {
    harness.files.clear();
    harness.setFailSaveForPath(null);
    const id = "s-concurrent-load";
    const legacyMsgs = [msg("user", "concurrent")];
    harness.getFile(META_PATH).set(`messages:${id}`, legacyMsgs);
    harness.calls.length = 0;

    const [a, b, c] = await Promise.all([
      loadMessages(id),
      loadMessages(id),
      loadMessages(id),
    ]);
    expect(a).toEqual(legacyMsgs);
    expect(b).toEqual(legacyMsgs);
    expect(c).toEqual(legacyMsgs);

    const legacyDeletes = harness.calls.filter(
      (call) => call === `delete:${META_PATH}:messages:${id}`,
    );
    expect(legacyDeletes).toHaveLength(1);
  });

  it("serializes saveMessages and deleteSessionData so a pending save cannot resurrect a deleted session", async () => {
    harness.files.clear();
    harness.closedPaths.clear();
    harness.setFailSaveForPath(null);
    const id = "s-save-delete-race";
    const msgs = [msg("user", "ephemeral")];

    await Promise.all([saveMessages(id, msgs), deleteSessionData(id)]);

    expect(harness.closedPaths.has(sessionStorePath(id))).toBe(true);
    expect(harness.getFile(sessionStorePath(id)).has("messages")).toBe(false);
    expect(await loadMessages(id)).toBeNull();
  });

  it("preserves metadata and recovery state in termigo-ai-sessions.json and cleans up on delete", async () => {
    harness.files.clear();
    harness.setFailSaveForPath(null);
    const id = "s-recovery-meta";

    await saveMessages(id, [msg("user", "hi")]);
    await saveRunMeta(id, {
      runRound: 2,
      stopReason: "step-cap",
      stoppedByUser: false,
      at: 999,
    });
    await saveRunInFlight(id, 1000);

    expect(await loadRunMeta(id)).toEqual({
      runRound: 2,
      stopReason: "step-cap",
      stoppedByUser: false,
      at: 999,
    });
    expect(await loadRunInFlight(id)).toBe(1000);

    await deleteSessionData(id);
    expect(await loadRunMeta(id)).toBeNull();
    expect(await loadRunInFlight(id)).toBeNull();
  });

  it("closes temporary per-session stores after loadMessages and buildSessionSearchIndex", async () => {
    harness.files.clear();
    harness.closedPaths.clear();
    harness.setFailSaveForPath(null);
    harness
      .getFile(sessionStorePath("s-idx-1"))
      .set("messages", [msg("user", "alpha")]);
    harness
      .getFile(sessionStorePath("s-idx-2"))
      .set("messages", [msg("user", "beta")]);

    const idx = await buildSessionSearchIndex([
      { id: "s-idx-1", title: "1", createdAt: 1, updatedAt: 1 },
      { id: "s-idx-2", title: "2", createdAt: 2, updatedAt: 2 },
    ]);

    expect(idx.get("s-idx-1")).toContain("alpha");
    expect(idx.get("s-idx-2")).toContain("beta");
    expect(harness.closedPaths.has(sessionStorePath("s-idx-1"))).toBe(true);
    expect(harness.closedPaths.has(sessionStorePath("s-idx-2"))).toBe(true);
  });

  it("evicts and closes older per-session stores when exceeding LRU cap and on closeSessionStore", async () => {
    harness.files.clear();
    harness.closedPaths.clear();
    harness.setFailSaveForPath(null);

    await saveMessages("s-lru-1", [msg("user", "1")]);
    await saveMessages("s-lru-2", [msg("user", "2")]);
    expect(harness.closedPaths.has(sessionStorePath("s-lru-1"))).toBe(false);

    // Opening a 3rd store evicts & closes the oldest ("s-lru-1").
    await saveMessages("s-lru-3", [msg("user", "3")]);
    // Allow scheduled eviction lock to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(harness.closedPaths.has(sessionStorePath("s-lru-1"))).toBe(true);

    // Explicit closeSessionStore saves and closes remaining open stores.
    await closeSessionStore("s-lru-2");
    await closeSessionStore("s-lru-3");
    expect(harness.closedPaths.has(sessionStorePath("s-lru-2"))).toBe(true);
    expect(harness.closedPaths.has(sessionStorePath("s-lru-3"))).toBe(true);
  });

  it("runs ensureLegacyMigrated single-flight and safely handles unavailable Tauri runtime", async () => {
    _resetMigrationForTest();
    const [r1, r2] = await Promise.all([
      ensureLegacyMigrated(),
      ensureLegacyMigrated(),
    ]);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });

  it("awaits ensureLegacyMigrated before accessing metadata store in all helpers", async () => {
    const ops: Array<{ name: string; run: () => Promise<unknown> }> = [
      { name: "saveSessionsList", run: () => saveSessionsList([]) },
      { name: "saveActiveId", run: () => saveActiveId("s-1") },
      {
        name: "saveRunMeta",
        run: () =>
          saveRunMeta("s-1", {
            runRound: 1,
            stopReason: null,
            stoppedByUser: false,
            at: 1,
          }),
      },
      { name: "loadRunMeta", run: () => loadRunMeta("s-1") },
      { name: "deleteRunMeta", run: () => deleteRunMeta("s-1") },
      { name: "saveRunInFlight", run: () => saveRunInFlight("s-1", 1) },
      { name: "loadRunInFlight", run: () => loadRunInFlight("s-1") },
      { name: "deleteRunInFlight", run: () => deleteRunInFlight("s-1") },
    ];

    try {
      harness.setInvokeImpl(async (cmd) => {
        await new Promise((r) => setTimeout(r, 0));
        harness.calls.push(`invoke:${cmd}`);
        if (cmd === "sessions_migrate_legacy") {
          return { migrated: 0, alreadyMigrated: 0, backupCreated: false };
        }
        return null;
      });

      for (const op of ops) {
        harness.files.clear();
        harness.calls.length = 0;
        _resetMigrationForTest();

        await op.run();

        expect(harness.calls[0], `${op.name} first call`).toBe(
          "invoke:sessions_migrate_legacy",
        );
        expect(
          harness.calls.some((c) => c.includes(`:${META_PATH}:`)),
          `${op.name} accessed metadata store`,
        ).toBe(true);
      }
    } finally {
      harness.setInvokeImpl(null);
      _resetMigrationForTest();
    }
  });

  it("rejects on migration error without loading legacy LazyStore, preserves data, and allows retry", async () => {
    try {
      harness.files.clear();
      harness.calls.length = 0;
      _resetMigrationForTest();

      const legacyMsgs = [msg("user", "keep me safe")];
      harness
        .getFile(META_PATH)
        .set("sessions", [
          { id: "s-err", title: "err", createdAt: 1, updatedAt: 2 },
        ]);
      harness.getFile(META_PATH).set("activeId", "s-err");
      harness.getFile(META_PATH).set("messages:s-err", legacyMsgs);

      let shouldFail = true;
      let attempts = 0;
      harness.setInvokeImpl(async (cmd) => {
        harness.calls.push(`invoke:${cmd}`);
        if (cmd === "sessions_migrate_legacy") {
          attempts += 1;
          if (shouldFail) {
            throw new Error("aborting migration: disk error");
          }
          return { migrated: 1, alreadyMigrated: 0, backupCreated: true };
        }
        return null;
      });

      // First attempt fails: must reject and MUST NOT touch legacy LazyStore.
      await expect(loadAll()).rejects.toThrow(/aborting migration/);
      await expect(loadMessages("s-err")).rejects.toThrow(/aborting migration/);
      await expect(saveSessionsList([])).rejects.toThrow(/aborting migration/);
      expect(attempts).toBe(3);
      expect(harness.calls.some((c) => c.includes(`:${META_PATH}:`))).toBe(
        false,
      );
      // Old data in legacy store remains untouched.
      expect(harness.getFile(META_PATH).get("messages:s-err")).toEqual(
        legacyMsgs,
      );

      // Once the error clears, a retry succeeds and caches the result.
      shouldFail = false;
      const loaded = await loadAll();
      expect(attempts).toBe(4);
      expect(loaded.activeId).toBe("s-err");
      expect(loaded.sessions.map((s) => s.id)).toEqual(["s-err"]);

      // Subsequent call reuses the successful migration without re-invoking.
      await ensureLegacyMigrated();
      expect(attempts).toBe(4);
    } finally {
      harness.setInvokeImpl(null);
      _resetMigrationForTest();
    }
  });
});
