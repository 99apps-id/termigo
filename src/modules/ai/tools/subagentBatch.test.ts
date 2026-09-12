import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";

/** Records the order and overlap of runs so concurrency can be asserted. */
const runs = vi.hoisted(() => ({
  started: [] as string[],
  peak: 0,
  active: 0,
  /** Prompts as the subagent received them, keyed by the task's own text. */
  prompts: new Map<string, string>(),
  fail: new Set<string>(),
  /** Tasks whose run finishes without having inspected anything. */
  inconclusive: new Set<string>(),
  delayMs: 0,
}));

vi.mock("../agents/runSubagent", () => ({
  MAX_SUBAGENT_DEPTH: 3,
  effectiveSubagentMaxDepth: () => 3,
  runSubagent: vi.fn(async ({ prompt }: { prompt: string }) => {
    // The task's own instruction is the last line; dependency context is above.
    const own = prompt.split("\n").pop() as string;
    runs.started.push(own);
    runs.prompts.set(own, prompt);
    runs.active++;
    runs.peak = Math.max(runs.peak, runs.active);
    await new Promise((r) => setTimeout(r, runs.delayMs));
    runs.active--;
    if (runs.fail.has(own)) throw new Error(`boom: ${own}`);
    return {
      summary: `summary of ${own}`,
      stepCount: 1,
      durationMs: 1,
      ...(runs.inconclusive.has(own) ? { inconclusive: true } : {}),
    };
  }),
}));

vi.mock("../store/chatStore", () => ({
  useChatStore: {
    getState: () => ({
      apiKeys: {},
      selectedModelId: "test-model",
      patchAgentMeta: () => {},
    }),
  },
}));

const { buildSubagentTools } = await import("./subagent");

function ctx(): ToolContext {
  return {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    getRemoteSession: () => null,
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    openPreview: () => false,
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache: new Map(),
    getSessionId: () => "session",
  } as unknown as ToolContext;
}

type BatchOut = {
  count: number;
  maxConcurrency: number;
  failedOrSkipped?: number;
  inconclusive?: number;
  note?: string;
  results: {
    index: number;
    summary?: string;
    error?: string;
    skipped?: string;
    inconclusive?: boolean;
  }[];
};

async function run(input: unknown): Promise<BatchOut> {
  const tools = buildSubagentTools(ctx());
  const execute = tools.run_subagents.execute;
  if (!execute) throw new Error("run_subagents has no execute");
  return (await execute(
    input as never,
    {
      toolCallId: "t",
      messages: [],
    } as never,
  )) as BatchOut;
}

beforeEach(() => {
  runs.started = [];
  runs.peak = 0;
  runs.active = 0;
  runs.prompts.clear();
  runs.fail.clear();
  runs.inconclusive.clear();
  runs.delayMs = 0;
});

describe("run_subagents", () => {
  it("runs independent tasks at the same time", async () => {
    runs.delayMs = 20;
    const out = await run({
      tasks: [
        { type: "explore", prompt: "a" },
        { type: "explore", prompt: "b" },
        { type: "explore", prompt: "c" },
      ],
    });
    expect(out.count).toBe(3);
    expect(runs.peak).toBeGreaterThan(1);
    expect(out.results.every((r) => r.summary)).toBe(true);
  });

  it("honours max_concurrency", async () => {
    runs.delayMs = 20;
    await run({
      tasks: Array.from({ length: 4 }, (_, i) => ({
        type: "explore",
        prompt: `t${i}`,
      })),
      max_concurrency: 2,
    });
    expect(runs.peak).toBeLessThanOrEqual(2);
  });

  // Scatter then gather: the dependent must start only after its sources, and
  // must be handed what they found - it has no history to ask for it.
  it("waits for dependencies and passes their summaries down", async () => {
    const out = await run({
      tasks: [
        { type: "explore", prompt: "front" },
        { type: "explore", prompt: "back" },
        { type: "general", prompt: "join", depends_on: [0, 1] },
      ],
    });
    expect(runs.started.indexOf("join")).toBe(2);
    const joinPrompt = runs.prompts.get("join") as string;
    expect(joinPrompt).toContain("summary of front");
    expect(joinPrompt).toContain("summary of back");
    expect(out.results[2].summary).toBeTruthy();
  });

  it("skips a task whose dependency failed, and says which", async () => {
    runs.fail.add("a");
    const out = await run({
      tasks: [
        { type: "explore", prompt: "a" },
        { type: "general", prompt: "b", depends_on: [0] },
      ],
    });
    expect(out.results[0].error).toContain("boom");
    expect(out.results[1].skipped).toContain("#0");
    expect(runs.started).not.toContain("b");
    expect(out.failedOrSkipped).toBe(2);
  });

  // The failure that would otherwise hang the run rather than end it.
  it("finishes a batch that contains a cycle instead of waiting on it", async () => {
    const out = await run({
      tasks: [
        { type: "explore", prompt: "x", depends_on: [1] },
        { type: "explore", prompt: "y", depends_on: [0] },
      ],
    });
    expect(out.results[0].skipped).toContain("cycle");
    expect(out.results[1].skipped).toContain("cycle");
    expect(runs.started).toEqual([]);
  });

  it("drops tasks past the cap and reports it rather than running fewer quietly", async () => {
    const out = await run({
      tasks: Array.from({ length: 12 }, (_, i) => ({
        type: "explore",
        prompt: `t${i}`,
      })),
    });
    expect(out.count).toBe(8);
    expect(out.note).toContain("dropped");
  });

  it("reports a dependency on a task that does not exist, and still runs", async () => {
    const out = await run({
      tasks: [{ type: "explore", prompt: "solo", depends_on: [9] }],
    });
    expect(out.note).toContain("does not exist");
    expect(out.results[0].summary).toBeTruthy();
  });

  // A run that produced prose without looking at anything must not read as a
  // clean audit: the flag has to reach both the payload and the batch note.
  it("counts a sub-agent that reported an incomplete review", async () => {
    runs.inconclusive.add("b");
    const out = await run({
      tasks: [
        { type: "code-review", prompt: "a" },
        { type: "code-review", prompt: "b" },
      ],
    });
    expect(out.inconclusive).toBe(1);
    expect(out.results[1].inconclusive).toBe(true);
    expect(out.results[0].inconclusive).toBeUndefined();
    expect(out.note).toContain("1 of 2 subagent(s)");
  });

  it("says nothing about inconclusive runs when every run read", async () => {
    const out = await run({
      tasks: [{ type: "code-review", prompt: "a" }],
    });
    expect(out.inconclusive).toBeUndefined();
    expect(out.note ?? "").not.toContain("unverified");
  });

  it("returns results in the order they were given", async () => {
    runs.delayMs = 5;
    const out = await run({
      tasks: [
        { type: "explore", prompt: "first" },
        { type: "explore", prompt: "second" },
      ],
    });
    expect(out.results.map((r) => r.index)).toEqual([0, 1]);
  });

  it("handles user error payload with todos and stringified array", async () => {
    const rawInput = {
      max_concurrency: 4,
      todos:
        '[{"id": "map", "status": "completed", "title": "Petakan struktur kode Rust + TypeScript"}, {"id": "ipc", "status": "in_progress", "title": "Audit surface IPC/Tauri commands + capabilities allowlist"}, {"id": "subagent-audit", "status": "in_progress", "title": "Audit paralel: control server, ssh, pty/shell, extensions, net/ssrf"}]',
    };

    const tools = buildSubagentTools(ctx());
    // Test schema validation
    const parsed = tools.run_subagents.inputSchema.parse(rawInput) as {
      tasks: Array<{ prompt: string; type?: string; description?: string }>;
      max_concurrency?: number;
    };
    expect(parsed.tasks).toHaveLength(3);
    expect(parsed.tasks[0].prompt).toBe(
      "Petakan struktur kode Rust + TypeScript",
    );
    expect(parsed.tasks[1].prompt).toBe(
      "Audit surface IPC/Tauri commands + capabilities allowlist",
    );
    expect(parsed.tasks[2].prompt).toBe(
      "Audit paralel: control server, ssh, pty/shell, extensions, net/ssrf",
    );
    expect(parsed.max_concurrency).toBe(4);

    // Test tool execution
    const out = await run(parsed);
    expect(out.count).toBe(3);
    expect(out.results).toHaveLength(3);
  });

  it("resolves named dependencies in tasks", async () => {
    const rawInput = {
      tasks: [
        { id: "step-1", title: "Task 1" },
        { id: "step-2", title: "Task 2", depends_on: ["step-1"] },
      ],
    };

    const tools = buildSubagentTools(ctx());
    const parsed = tools.run_subagents.inputSchema.parse(rawInput) as {
      tasks: Array<{ depends_on?: number[] }>;
    };
    expect(parsed.tasks[1].depends_on).toEqual([0]);
  });
});
