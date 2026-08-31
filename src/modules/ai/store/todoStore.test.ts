import { beforeEach, describe, expect, it, vi } from "vitest";

// The store persists to a Tauri LazyStore. In tests that is unavailable and
// would reject as an unhandled promise, so stub the persistence glue.
vi.mock("../lib/todos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/todos")>();
  return {
    ...actual,
    saveTodos: vi.fn().mockResolvedValue(undefined),
    loadTodos: vi.fn().mockResolvedValue({ workspaceRoot: null, items: [] }),
    deleteTodos: vi.fn().mockResolvedValue(undefined),
  };
});

import { useTodosStore } from "./todoStore";

describe("useTodosStore.completeInProgress", () => {
  beforeEach(() => {
    useTodosStore.setState({ bySession: {}, hydrated: new Set() });
  });

  it("marks the in_progress item completed", () => {
    useTodosStore.setState({
      bySession: {
        s1: {
          workspaceRoot: "/w",
          items: [
            { id: "1", title: "a", status: "completed" },
            { id: "2", title: "b", status: "in_progress" },
            { id: "3", title: "c", status: "pending" },
          ],
        },
      },
    });
    useTodosStore.getState().completeInProgress("s1");
    const items = useTodosStore.getState().bySession.s1.items;
    expect(items.find((t) => t.id === "2")?.status).toBe("completed");
    expect(items.find((t) => t.id === "3")?.status).toBe("pending");
  });

  it("leaves the list unchanged when nothing is in_progress", () => {
    useTodosStore.setState({
      bySession: {
        s1: {
          workspaceRoot: "/w",
          items: [
            { id: "1", title: "a", status: "completed" },
            { id: "2", title: "b", status: "pending" },
          ],
        },
      },
    });
    const before = useTodosStore.getState().bySession.s1.items;
    useTodosStore.getState().completeInProgress("s1");
    expect(useTodosStore.getState().bySession.s1.items).toBe(before);
  });

  it("does nothing for an unknown session", () => {
    expect(() =>
      useTodosStore.getState().completeInProgress("nope"),
    ).not.toThrow();
  });
});

describe("useTodosStore.completeStarted", () => {
  beforeEach(() => {
    useTodosStore.setState({ bySession: {}, hydrated: new Set() });
  });

  it("marks every item that was started (in_progress or forgotten) completed", () => {
    useTodosStore.setState({
      bySession: {
        s1: {
          workspaceRoot: "/w",
          items: [
            { id: "1", title: "done", status: "completed" },
            { id: "2", title: "working", status: "in_progress" },
            { id: "3", title: "forgot to check", status: "in_progress" },
            { id: "4", title: "not started", status: "pending" },
          ],
        },
      },
    });
    useTodosStore.getState().completeStarted("s1");
    const items = useTodosStore.getState().bySession.s1.items;
    // Anything begun (in_progress, or an earlier one left un-checked) is now
    // done; a genuinely-unstarted pending item is left alone.
    expect(items.find((t) => t.id === "1")?.status).toBe("completed");
    expect(items.find((t) => t.id === "2")?.status).toBe("completed");
    expect(items.find((t) => t.id === "3")?.status).toBe("completed");
    expect(items.find((t) => t.id === "4")?.status).toBe("pending");
  });

  it("leaves the list unchanged when every item is pending", () => {
    useTodosStore.setState({
      bySession: {
        s1: {
          workspaceRoot: "/w",
          items: [{ id: "1", title: "a", status: "pending" }],
        },
      },
    });
    const before = useTodosStore.getState().bySession.s1.items;
    useTodosStore.getState().completeStarted("s1");
    expect(useTodosStore.getState().bySession.s1.items).toBe(before);
  });

  it("does nothing for an unknown session", () => {
    expect(() =>
      useTodosStore.getState().completeStarted("nope"),
    ).not.toThrow();
  });
});
