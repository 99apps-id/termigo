import { describe, expect, it } from "vitest";
import {
  belongsToWorkspace,
  isFinished,
  parseStoredTodos,
  standDownRunning,
  type Todo,
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
    expect(isFinished([item("a", "completed"), item("b", "completed")])).toBe(true);
  });

  it("is not finished while one is still pending", () => {
    expect(isFinished([item("a", "completed"), item("b", "pending")])).toBe(false);
  });

  // The old check was `todos.length === 0`, which an empty list also satisfies.
  // Keeping them apart matters: empty means none were ever written.
  it("is not finished when there is nothing in it", () => {
    expect(isFinished([])).toBe(false);
  });
});

describe("a stopped run does not leave work claiming to be running", () => {
  it("stands the running item back down to pending", () => {
    const out = standDownRunning([item("a", "completed"), item("b", "in_progress")]);
    expect(out.map((t) => t.status)).toEqual(["completed", "pending"]);
  });

  it("leaves completed work completed", () => {
    const out = standDownRunning([item("a", "completed"), item("b", "in_progress")]);
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
    expect(belongsToWorkspace({ workspaceRoot: "/a", items: [] }, "/a")).toBe(true);
  });

  it("hides in a different one, which is the reported bug", () => {
    expect(belongsToWorkspace({ workspaceRoot: "/a", items: [] }, "/b")).toBe(false);
  });

  it("hides when no project is open", () => {
    expect(belongsToWorkspace({ workspaceRoot: "/a", items: [] }, null)).toBe(false);
  });

  // Lists written before the tag existed have no project recorded. Hiding
  // those would read as data loss, so they keep the reach they already had.
  it("shows an untagged list everywhere", () => {
    expect(belongsToWorkspace({ workspaceRoot: null, items: [] }, "/b")).toBe(true);
  });
});

describe("stored lists survive the shape change", () => {
  it("reads a legacy bare array as untagged", () => {
    const rec = parseStoredTodos([item("a", "pending")]);
    expect(rec.workspaceRoot).toBeNull();
    expect(rec.items).toHaveLength(1);
  });

  it("reads a tagged record", () => {
    const rec = parseStoredTodos({ workspaceRoot: "/w", items: [item("a", "pending")] });
    expect(rec.workspaceRoot).toBe("/w");
    expect(rec.items).toHaveLength(1);
  });

  it("reads anything else as empty rather than throwing", () => {
    for (const junk of [null, undefined, 42, "todos", {}]) {
      expect(parseStoredTodos(junk).items).toEqual([]);
    }
  });
});
