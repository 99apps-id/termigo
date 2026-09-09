import { describe, expect, it } from "vitest";
import {
  activeTodoIndex,
  belongsToWorkspace,
  formatTodoStatusBlock,
  isFinished,
  parseStoredTodos,
  standDownRunning,
  type Todo,
  todoTree,
  validateTodos,
} from "./todos";

function todo(over: Partial<Todo> = {}): Todo {
  return { id: "t1", title: "task", status: "pending", ...over };
}

describe("validateTodos", () => {
  it("accepts an empty list", () => {
    expect(validateTodos([])).toBeNull();
  });

  it("accepts a list with a single in_progress item", () => {
    expect(
      validateTodos([
        todo({ id: "a", status: "in_progress" }),
        todo({ id: "b", status: "pending" }),
      ]),
    ).toBeNull();
  });

  it("rejects an empty or whitespace title", () => {
    expect(validateTodos([todo({ title: "" })])).toContain("title");
    expect(validateTodos([todo({ title: "   " })])).toContain("title");
  });

  it("rejects more than one in_progress item", () => {
    const err = validateTodos([
      todo({ id: "a", status: "in_progress" }),
      todo({ id: "b", status: "in_progress" }),
    ]);
    expect(err).toContain("in_progress");
    expect(err).toContain("2");
  });
});

const item = (id: string, status: Todo["status"]): Todo => ({
  id,
  title: id,
  status,
});

// Three reported symptoms, one cause: a list's lifetime was tied only to the
// session being deleted. Nothing ended it when the work finished, nothing
// ended it when the run stopped, and nothing noticed when the user moved to a
// different project. The app's own store had 9 sessions holding 53 items -
// 4 of those sessions fully completed and still on screen, and 5 items frozen
// mid-run.
describe("a finished list stops taking up the screen", () => {
  it("is finished when every item is completed", () => {
    expect(isFinished([item("a", "completed"), item("b", "completed")])).toBe(
      true,
    );
  });

  it("is not finished while one is still pending", () => {
    expect(isFinished([item("a", "completed"), item("b", "pending")])).toBe(
      false,
    );
  });

  // The old check was `todos.length === 0`, which an empty list also satisfies.
  // Keeping them apart matters: empty means none were ever written.
  it("is not finished when there is nothing in it", () => {
    expect(isFinished([])).toBe(false);
  });
});

describe("a stopped run does not leave work claiming to be running", () => {
  it("stands the running item back down to pending", () => {
    const out = standDownRunning([
      item("a", "completed"),
      item("b", "in_progress"),
    ]);
    expect(out.map((t) => t.status)).toEqual(["completed", "pending"]);
  });

  it("leaves completed work completed", () => {
    const out = standDownRunning([
      item("a", "completed"),
      item("b", "in_progress"),
    ]);
    expect(out[0].status).toBe("completed");
  });

  // Reference equality is what tells the store there is nothing to persist.
  it("returns the same list untouched when nothing was running", () => {
    const items = [item("a", "pending")];
    expect(standDownRunning(items)).toBe(items);
  });
});

describe("a list belongs to the project it was written in", () => {
  it("shows in the workspace it was written for", () => {
    expect(belongsToWorkspace({ workspaceRoot: "/a", items: [] }, "/a")).toBe(
      true,
    );
  });

  it("hides in a different one, which is the reported bug", () => {
    expect(belongsToWorkspace({ workspaceRoot: "/a", items: [] }, "/b")).toBe(
      false,
    );
  });

  it("hides when no project is open", () => {
    expect(belongsToWorkspace({ workspaceRoot: "/a", items: [] }, null)).toBe(
      false,
    );
  });

  // Lists written before the tag existed have no project recorded. Hiding
  // those would read as data loss, so they keep the reach they already had.
  it("shows an untagged list everywhere", () => {
    expect(belongsToWorkspace({ workspaceRoot: null, items: [] }, "/b")).toBe(
      true,
    );
  });
});

describe("stored lists survive the shape change", () => {
  it("reads a legacy bare array as untagged", () => {
    const rec = parseStoredTodos([item("a", "pending")]);
    expect(rec.workspaceRoot).toBeNull();
    expect(rec.items).toHaveLength(1);
  });

  it("reads a tagged record", () => {
    const rec = parseStoredTodos({
      workspaceRoot: "/w",
      items: [item("a", "pending")],
    });
    expect(rec.workspaceRoot).toBe("/w");
    expect(rec.items).toHaveLength(1);
  });

  it("reads anything else as empty rather than throwing", () => {
    for (const junk of [null, undefined, 42, "todos", {}]) {
      expect(parseStoredTodos(junk).items).toEqual([]);
    }
  });
});

describe("formatTodoStatusBlock", () => {
  it("returns null for an empty list", () => {
    expect(formatTodoStatusBlock([])).toBeNull();
  });

  it("renders each item with its status", () => {
    const block = formatTodoStatusBlock([
      { title: "one", status: "completed" },
      { title: "two", status: "in_progress" },
      { title: "three", status: "pending" },
    ]);
    expect(block).toContain("- [completed] one");
    expect(block).toContain("- [in_progress] two");
    expect(block).toContain("- [pending] three");
  });

  it("indents nested items under their parent", () => {
    const block = formatTodoStatusBlock([
      { id: "a", title: "parent", status: "in_progress" },
      { id: "b", title: "child", status: "pending", parent: "a" },
      { id: "c", title: "grandchild", status: "pending", parent: "b" },
    ]);
    expect(block).toContain("- [in_progress] parent");
    expect(block).toContain("  - [pending] child");
    expect(block).toContain("    - [pending] grandchild");
  });

  it("caps indentation at depth 4", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      id: `n${i}`,
      title: `level ${i}`,
      status: "pending" as const,
      ...(i > 0 ? { parent: `n${i - 1}` } : {}),
    }));
    const block = formatTodoStatusBlock(items) ?? "";
    const deepest = block
      .split("\n")
      .find((l) => l.includes("level 7")) ?? "";
    expect(deepest.startsWith("        - ")).toBe(true); // 8 spaces = 4 levels
    expect(deepest.startsWith("          ")).toBe(false); // not 5+
  });
});

describe("todoTree", () => {
  it("returns an empty list unchanged", () => {
    expect(todoTree([])).toEqual([]);
  });

  it("keeps a flat list flat, in order", () => {
    const items = [item("a", "pending"), item("b", "completed")];
    expect(todoTree(items).map(([t, d]) => [t.id, d])).toEqual([
      ["a", 0],
      ["b", 0],
    ]);
  });

  it("places children directly after their parent", () => {
    const items: Todo[] = [
      { ...item("a", "pending") },
      { ...item("b", "pending"), parent: "a" },
      { ...item("c", "pending") },
      { ...item("d", "pending"), parent: "a" },
    ];
    expect(todoTree(items).map(([t, d]) => [t.id, d])).toEqual([
      ["a", 0],
      ["b", 1],
      ["d", 1],
      ["c", 0],
    ]);
  });

  it("nests grandchildren one level deeper", () => {
    const items: Todo[] = [
      { ...item("a", "pending") },
      { ...item("b", "pending"), parent: "a" },
      { ...item("c", "pending"), parent: "b" },
    ];
    expect(todoTree(items).map(([, d]) => d)).toEqual([0, 1, 2]);
  });

  it("treats a dangling parent as a root", () => {
    const items: Todo[] = [
      { ...item("a", "pending"), parent: "missing" },
      { ...item("b", "pending") },
    ];
    expect(todoTree(items).map(([t, d]) => [t.id, d])).toEqual([
      ["a", 0],
      ["b", 0],
    ]);
  });

  it("treats a self-parent as a root", () => {
    const items: Todo[] = [{ ...item("a", "pending"), parent: "a" }];
    expect(todoTree(items).map(([t, d]) => [t.id, d])).toEqual([["a", 0]]);
  });

  it("appends cycle members flat so nothing is lost", () => {
    const items: Todo[] = [
      { ...item("a", "pending") },
      { ...item("b", "pending"), parent: "c" },
      { ...item("c", "pending"), parent: "b" },
    ];
    const out = todoTree(items);
    expect(out).toHaveLength(3);
    expect(out.map(([t]) => t.id).sort()).toEqual(["a", "b", "c"]);
    // "a" is the only root; b and c land flat at depth 0.
    expect(out.map(([t, d]) => [t.id, d])).toEqual([
      ["a", 0],
      ["b", 0],
      ["c", 0],
    ]);
  });

  it("never emits an item twice", () => {
    const items: Todo[] = [
      { ...item("a", "pending") },
      { ...item("b", "pending"), parent: "a" },
      { ...item("c", "pending"), parent: "b" },
      { ...item("d", "pending"), parent: "a" },
    ];
    const ids = todoTree(items).map(([t]) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("activeTodoIndex", () => {
  it("prefers the explicit in_progress item", () => {
    expect(
      activeTodoIndex([
        { status: "completed" },
        { status: "in_progress" },
        { status: "pending" },
      ]),
    ).toBe(1);
  });

  it("derives the first non-completed item when none is marked", () => {
    expect(
      activeTodoIndex([
        { status: "completed" },
        { status: "pending" },
        { status: "pending" },
      ]),
    ).toBe(1);
  });

  it("returns -1 when every item is completed", () => {
    expect(
      activeTodoIndex([{ status: "completed" }, { status: "completed" }]),
    ).toBe(-1);
  });

  it("returns -1 for an empty list", () => {
    expect(activeTodoIndex([])).toBe(-1);
  });
});
