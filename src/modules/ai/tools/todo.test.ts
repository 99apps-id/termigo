import type { ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";

const storeMock = vi.hoisted(() => ({
  setTodos: vi.fn(),
  currentTodos: [] as any[],
}));

vi.mock("../store/todoStore", () => ({
  useTodosStore: { getState: () => ({ setTodos: storeMock.setTodos }) },
  getTodos: () => storeMock.currentTodos,
}));

import { buildTodoTools } from "./todo";

const toolOptions: ToolExecutionOptions = {
  toolCallId: "tool-call",
  messages: [],
};

function makeContext(sessionId: string | null = "session"): ToolContext {
  return {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    // No SSH session in these fixtures: tools resolve locally.
    getRemoteSession: () => null,
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    openPreview: () => false,
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache: new Map(),
    getSessionId: () => sessionId,
  } as unknown as ToolContext;
}

// biome-ignore lint/suspicious/noExplicitAny: tool results are heterogeneous.
type Result = Record<string, any>;

async function runWrite(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<Result> {
  const execute = buildTodoTools(ctx).todo_write.execute;
  if (!execute) throw new Error("todo_write has no execute");
  return (await execute(input as never, toolOptions)) as unknown as Result;
}

async function runUpdate(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<Result> {
  const execute = buildTodoTools(ctx).todo_update.execute;
  if (!execute) throw new Error("todo_update has no execute");
  return (await execute(input as never, toolOptions)) as unknown as Result;
}

async function runRead(
  ctx: ToolContext,
  input: Record<string, unknown> = {},
): Promise<Result> {
  const execute = buildTodoTools(ctx).todo_read.execute;
  if (!execute) throw new Error("todo_read has no execute");
  return (await execute(input as never, toolOptions)) as unknown as Result;
}

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.currentTodos = [];
});

describe("todo_write", () => {
  it("errors when there is no active session", async () => {
    const r = await runWrite(makeContext(null), { todos: [] });
    expect(r.error).toContain("no active session");
    expect(storeMock.setTodos).not.toHaveBeenCalled();
  });

  it("persists todos and reports the count and current item", async () => {
    const r = await runWrite(makeContext(), {
      todos: [
        { id: "a", title: "first", status: "in_progress" },
        { id: "b", title: "second", status: "pending" },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.count).toBe(2);
    expect(r.inProgress).toBe("first");
    expect(storeMock.setTodos).toHaveBeenCalledWith(
      "session",
      expect.any(Array),
      "/workspace",
    );
  });

  it("assigns an id to a todo that lacks one", async () => {
    await runWrite(makeContext(), {
      todos: [{ title: "no id yet", status: "pending" }],
    });
    const persisted = storeMock.setTodos.mock.calls[0][1];
    expect(persisted[0].id).toBeTruthy();
  });

  it("rejects an invalid batch without persisting", async () => {
    const r = await runWrite(makeContext(), {
      todos: [
        { id: "a", title: "x", status: "in_progress" },
        { id: "b", title: "y", status: "in_progress" },
      ],
    });
    expect(r.error).toContain("in_progress");
    expect(storeMock.setTodos).not.toHaveBeenCalled();
  });
});

describe("todo_read", () => {
  it("errors when there is no active session", async () => {
    const r = await runRead(makeContext(null));
    expect(r.error).toContain("no active session");
  });

  it("reads all todos and reports inProgress correctly", async () => {
    storeMock.currentTodos = [
      { id: "1", title: "T1", status: "completed" },
      { id: "2", title: "T2", status: "in_progress" },
      { id: "3", title: "T3", status: "pending" },
    ];
    const r = await runRead(makeContext());
    expect(r.ok).toBe(true);
    expect(r.count).toBe(3);
    expect(r.total).toBe(3);
    expect(r.inProgress).toBe("T2");
  });

  it("filters todos by status", async () => {
    storeMock.currentTodos = [
      { id: "1", title: "T1", status: "completed" },
      { id: "2", title: "T2", status: "in_progress" },
      { id: "3", title: "T3", status: "pending" },
    ];
    const r = await runRead(makeContext(), { status: "pending" });
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
    expect(r.total).toBe(3);
    expect(r.todos[0].title).toBe("T3");
  });
});

describe("todo_update", () => {
  it("errors when there is no active session", async () => {
    const r = await runUpdate(makeContext(null), {
      action: "add",
      title: "new task",
    });
    expect(r.error).toContain("no active session");
  });

  it("adds a new todo", async () => {
    const r = await runUpdate(makeContext(), {
      action: "add",
      title: "Fresh task",
      status: "pending",
    });
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
    expect(r.item.title).toBe("Fresh task");
    expect(storeMock.setTodos).toHaveBeenCalledWith(
      "session",
      expect.arrayContaining([
        expect.objectContaining({ title: "Fresh task", status: "pending" }),
      ]),
      "/workspace",
    );
  });

  it("updates an existing todo by id", async () => {
    storeMock.currentTodos = [
      { id: "a", title: "Task A", status: "pending" },
      { id: "b", title: "Task B", status: "pending" },
    ];
    const r = await runUpdate(makeContext(), {
      action: "update",
      id: "a",
      status: "in_progress",
    });
    expect(r.ok).toBe(true);
    expect(r.item.id).toBe("a");
    expect(r.item.status).toBe("in_progress");
    expect(r.inProgress).toBe("Task A");
  });

  it("updates an existing todo by title match", async () => {
    storeMock.currentTodos = [
      { id: "a", title: "Write documentation", status: "pending" },
    ];
    const r = await runUpdate(makeContext(), {
      action: "update",
      title: "Write documentation",
      status: "completed",
    });
    expect(r.ok).toBe(true);
    expect(r.item.status).toBe("completed");
  });

  it("auto-completes previously in_progress task when starting a new one", async () => {
    storeMock.currentTodos = [
      { id: "a", title: "Task A", status: "in_progress" },
      { id: "b", title: "Task B", status: "pending" },
    ];
    const r = await runUpdate(makeContext(), {
      action: "update",
      id: "b",
      status: "in_progress",
    });
    expect(r.ok).toBe(true);
    const persisted = storeMock.setTodos.mock.calls[0][1];
    expect(persisted.find((t: any) => t.id === "a").status).toBe("completed");
    expect(persisted.find((t: any) => t.id === "b").status).toBe("in_progress");
  });

  it("removes a todo by id", async () => {
    storeMock.currentTodos = [
      { id: "a", title: "Task A", status: "pending" },
      { id: "b", title: "Task B", status: "pending" },
    ];
    const r = await runUpdate(makeContext(), {
      action: "remove",
      id: "a",
    });
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
    expect(r.removed.id).toBe("a");
  });

  it("returns error when target todo is not found", async () => {
    storeMock.currentTodos = [{ id: "a", title: "Task A", status: "pending" }];
    const r = await runUpdate(makeContext(), {
      action: "update",
      id: "missing",
      status: "completed",
    });
    expect(r.error).toContain("todo item not found");
  });
});

