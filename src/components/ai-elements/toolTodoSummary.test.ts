import { describe, expect, it } from "vitest";

import { todoResultSummary } from "./tool";

describe("todoResultSummary", () => {
  it("counts done and surfaces the running item from a full list", () => {
    expect(
      todoResultSummary({
        ok: true,
        count: 3,
        inProgress: "Write code",
        todos: [
          { id: "a", title: "Plan", status: "completed" },
          { id: "b", title: "Write code", status: "in_progress" },
          { id: "c", title: "Test", status: "pending" },
        ],
      }),
    ).toEqual({
      shown: 3,
      total: 3,
      done: 1,
      working: "Write code",
      filtered: false,
    });
  });

  it("marks a filtered read as shown-of-total instead of a false fraction", () => {
    expect(
      todoResultSummary({
        ok: true,
        count: 1,
        total: 5,
        inProgress: "Write code",
        todos: [{ id: "b", title: "Write code", status: "in_progress" }],
      }),
    ).toEqual({
      shown: 1,
      total: 5,
      done: 0,
      working: "Write code",
      filtered: true,
    });
  });

  it("falls back to the count fields when no list is attached", () => {
    expect(todoResultSummary({ ok: true, count: 2, inProgress: "X" })).toEqual({
      shown: 0,
      total: 2,
      done: null,
      working: "X",
      filtered: false,
    });
  });

  it("reports an emptied list as zero items", () => {
    expect(
      todoResultSummary({ ok: true, action: "remove", count: 0, todos: [] }),
    ).toEqual({ shown: 0, total: 0, done: 0, working: null, filtered: false });
  });

  it("returns null for shapes it cannot summarise", () => {
    expect(todoResultSummary(null)).toBeNull();
    expect(todoResultSummary("done")).toBeNull();
    expect(todoResultSummary({ ok: true })).toBeNull();
  });
});
