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
