import { beforeEach, describe, expect, it, vi } from "vitest";

// A minimal in-memory stand-in for the Tauri LazyStore, so the serialisation
// contract can be tested without a webview.
function fakeStore() {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn(async (key: string) => data.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
  };
}

describe("search history index", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("keeps both sessions when they persist in the same tick", async () => {
    const fake = fakeStore();
    vi.doMock("@tauri-apps/plugin-store", () => ({
      LazyStore: class {
        get = fake.get;
        set = fake.set;
      },
    }));
    const { indexMessagesBatch, searchHistory } = await import("./fts5");

    // Two sessions persist concurrently, exactly as `saveMessages` does on its
    // 300 ms debounce. Before the writes were serialised, both read the same
    // array and the second write dropped the first session's entries.
    await Promise.all([
      indexMessagesBatch("session-a", [{ messageId: "m1", text: "alpha" }]),
      indexMessagesBatch("session-b", [{ messageId: "m1", text: "beta" }]),
    ]);

    const a = await searchHistory("alpha");
    const b = await searchHistory("beta");
    expect(a.total).toBe(1);
    expect(b.total).toBe(1);
    expect(fake.data.get("index")).toHaveLength(2);
  });

  it("replaces a message instead of duplicating it on re-index", async () => {
    const fake = fakeStore();
    vi.doMock("@tauri-apps/plugin-store", () => ({
      LazyStore: class {
        get = fake.get;
        set = fake.set;
      },
    }));
    const { indexMessagesBatch, searchHistory } = await import("./fts5");

    await indexMessagesBatch("s", [{ messageId: "m1", text: "first version" }]);
    await indexMessagesBatch("s", [
      { messageId: "m1", text: "second version" },
    ]);

    const hits = await searchHistory("version");
    expect(hits.total).toBe(1);
    expect(hits.hits[0].text).toBe("second version");
  });

  it("drops a deleted session's entries", async () => {
    const fake = fakeStore();
    vi.doMock("@tauri-apps/plugin-store", () => ({
      LazyStore: class {
        get = fake.get;
        set = fake.set;
      },
    }));
    const { indexMessagesBatch, deleteSessionFromIndex, searchHistory } =
      await import("./fts5");

    await indexMessagesBatch("keep", [{ messageId: "m1", text: "alpha" }]);
    await indexMessagesBatch("drop", [{ messageId: "m1", text: "beta" }]);
    await deleteSessionFromIndex("drop");

    expect((await searchHistory("beta")).total).toBe(0);
    expect((await searchHistory("alpha")).total).toBe(1);
  });

  it("ignores empty text", async () => {
    const fake = fakeStore();
    vi.doMock("@tauri-apps/plugin-store", () => ({
      LazyStore: class {
        get = fake.get;
        set = fake.set;
      },
    }));
    const { indexMessagesBatch } = await import("./fts5");
    await indexMessagesBatch("s", [{ messageId: "m1", text: "   " }]);
    expect(fake.set).not.toHaveBeenCalled();
  });
});
