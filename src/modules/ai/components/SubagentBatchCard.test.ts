import { describe, expect, it } from "vitest";
import { extractWorkerData, fmtDuration } from "./SubagentBatchCard";

describe("fmtDuration", () => {
  it("formats milliseconds, seconds, and minutes correctly", () => {
    expect(fmtDuration(450)).toBe("450ms");
    expect(fmtDuration(1500)).toBe("1.5s");
    expect(fmtDuration(65000)).toBe("1m 5s");
  });
});

describe("extractWorkerData", () => {
  it("extracts batch tasks and links output results", () => {
    const input = {
      tasks: [
        {
          type: "explore",
          prompt: "Check src/auth",
          description: "Explore auth",
        },
        {
          type: "code-review",
          prompt: "Review changes",
          description: "Review auth",
          depends_on: [0],
        },
      ],
      max_concurrency: 2,
    };

    const output = {
      count: 2,
      maxConcurrency: 2,
      note: "All tasks completed successfully",
      results: [
        {
          index: 0,
          type: "explore",
          description: "Explore auth",
          summary: "Found 3 auth files",
          stepCount: 2,
          durationMs: 800,
        },
        {
          index: 1,
          type: "code-review",
          description: "Review auth",
          summary: "No vulnerabilities found",
          stepCount: 4,
          durationMs: 1200,
        },
      ],
    };

    const { workers, note, maxConcurrency } = extractWorkerData(
      "run_subagents",
      input,
      output,
      [],
    );

    expect(note).toBe("All tasks completed successfully");
    expect(maxConcurrency).toBe(2);
    expect(workers.length).toBe(2);

    expect(workers[0].status).toBe("done");
    expect(workers[0].summary).toBe("Found 3 auth files");
    expect(workers[0].stepCount).toBe(2);

    expect(workers[1].status).toBe("done");
    expect(workers[1].dependsOn).toEqual([0]);
    expect(workers[1].summary).toBe("No vulnerabilities found");
  });

  it("handles single subagent execution", () => {
    const input = {
      type: "security",
      prompt: "Scan dependencies",
      description: "Audit packages",
    };
    const output = {
      type: "security",
      description: "Audit packages",
      summary: "Clean audit",
      stepCount: 3,
      durationMs: 950,
    };

    const { workers } = extractWorkerData("run_subagent", input, output, []);
    expect(workers.length).toBe(1);
    expect(workers[0].status).toBe("done");
    expect(workers[0].label).toBe("Audit packages");
    expect(workers[0].stepCount).toBe(3);
    expect(workers[0].durationMs).toBe(950);
  });

  it("handles errors and skips gracefully", () => {
    const input = {
      tasks: [
        { type: "general", prompt: "task 1" },
        { type: "general", prompt: "task 2", depends_on: [0] },
      ],
    };
    const output = {
      results: [
        { index: 0, error: "Network timeout" },
        { index: 1, skipped: "dependency failed" },
      ],
    };

    const { workers } = extractWorkerData(
      "run_subagents",
      input,
      output,
      [],
    );
    expect(workers[0].status).toBe("error");
    expect(workers[0].error).toBe("Network timeout");
    expect(workers[1].status).toBe("skipped");
    expect(workers[1].skipped).toBe("dependency failed");
  });

  it("extracts workers when input contains todos instead of tasks", () => {
    const input = {
      max_concurrency: 4,
      todos:
        '[{"id": "map", "status": "completed", "title": "Petakan struktur kode Rust + TypeScript"}, {"id": "ipc", "status": "in_progress", "title": "Audit surface IPC/Tauri commands + capabilities allowlist"}]',
    };

    const { workers, maxConcurrency } = extractWorkerData(
      "run_subagents",
      input,
      undefined,
      [],
    );

    expect(maxConcurrency).toBe(4);
    expect(workers).toHaveLength(2);
    expect(workers[0].label).toBe("Petakan struktur kode Rust + TypeScript");
    expect(workers[1].label).toBe(
      "Audit surface IPC/Tauri commands + capabilities allowlist",
    );
  });

  // A batch whose workers reported an incomplete review must not read as a
  // clean fan-out: the flag travels from the tool output, or from the live run
  // when the output has not landed yet.
  it("carries the unverified flag from the result or the live run", () => {
    const flagged = extractWorkerData(
      "run_subagents",
      { tasks: [{ type: "code-review", prompt: "a" }] },
      {
        count: 1,
        inconclusive: 1,
        results: [
          {
            index: 0,
            summary: "Could not obtain the bodies.",
            inconclusive: true,
          },
        ],
      },
      [],
    );
    expect(flagged.workers[0].status).toBe("done");
    expect(flagged.workers[0].inconclusive).toBe(true);

    const single = extractWorkerData(
      "run_subagent",
      { type: "code-review", prompt: "a" },
      { summary: "Could not obtain the bodies.", inconclusive: true },
      [],
    );
    expect(single.workers[0].inconclusive).toBe(true);

    const fromRun = extractWorkerData(
      "run_subagents",
      { tasks: [{ type: "code-review", prompt: "a" }] },
      undefined,
      [
        {
          id: "r1",
          sessionId: "s",
          type: "code-review",
          label: "a",
          status: "done",
          startedAt: 0,
          inconclusive: true,
        },
      ] as never,
    );
    expect(fromRun.workers[0].inconclusive).toBe(true);
  });
});
