import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  findVerifiedCut,
  formatPruneSummary,
  pruneVerifiedPrefix,
  summarizeSegment,
} from "./contextPrune";

type ToolPart = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
};

function toolCall(id: string, toolName: string, input: unknown) {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName, input }],
  } as ModelMessage;
}

function toolResult(id: string, toolName: string, output: unknown, ok = true) {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName,
        output: ok ? output : { error: "boom" },
      },
    ],
  } as ModelMessage;
}

function user(text: string) {
  return { role: "user", content: text } as ModelMessage;
}

function assistant(text: string) {
  return { role: "assistant", content: text } as ModelMessage;
}

/** A realistic verified transcript: reads → edits → checks → checkpoint. */
function verifiedTranscript(): ModelMessage[] {
  return [
    user("fix the bug"),
    toolCall("r1", "read_file", { path: "src/a.ts" }),
    toolResult("r1", "read_file", { path: "src/a.ts" }),
    toolCall("e1", "edit", {
      path: "src/a.ts",
      old_string: "x",
      new_string: "y",
    }),
    toolResult("e1", "edit", { path: "src/a.ts", ok: true }),
    toolCall("b1", "bash_run", { command: "pnpm test" }),
    toolResult("b1", "bash_run", { command: "pnpm test", exit_code: 0 }),
    toolCall("c1", "git_checkpoint", { message: "fix a" }),
    toolResult("c1", "git_checkpoint", {
      command: "git add -A && git commit -m 'checkpoint: fix a'",
      message: "checkpoint: fix a",
      exit_code: 0,
    }),
    assistant("done part one"),
    user("now the next part"),
    toolCall("r2", "read_file", { path: "src/b.ts" }),
    toolResult("r2", "read_file", { path: "src/b.ts" }),
    toolCall("e2", "edit", {
      path: "src/b.ts",
      old_string: "p",
      new_string: "q",
    }),
    toolResult("e2", "edit", { path: "src/b.ts", ok: true }),
    assistant("done part two"),
  ];
}

describe("findVerifiedCut", () => {
  it("returns -1 on an empty transcript", () => {
    expect(findVerifiedCut([])).toBe(-1);
  });

  it("returns -1 when no checkpoint/commit was made", () => {
    const messages = verifiedTranscript().filter(
      (m) =>
        !(
          m.role === "tool" &&
          Array.isArray(m.content) &&
          (m.content as ToolPart[]).some((p) => p.toolName === "git_checkpoint")
        ) &&
        !(
          m.role === "assistant" &&
          Array.isArray(m.content) &&
          (m.content as ToolPart[]).some((p) => p.toolName === "git_checkpoint")
        ),
    );
    expect(findVerifiedCut(messages)).toBe(-1);
  });

  it("cuts after the verified checkpoint, leaving the tail intact", () => {
    const messages = verifiedTranscript();
    const cut = findVerifiedCut(messages);
    expect(cut).toBeGreaterThan(0);
    // Cut must sit on a balanced boundary and keep >= 6 trailing messages.
    expect(messages.length - cut).toBeGreaterThanOrEqual(6);
  });

  it("refuses to cut mid-tool-round (imbalanced boundary)", () => {
    // A verified signal appears, but the prefix is not self-contained: the
    // read_file call before it never got its result.
    const messages: ModelMessage[] = [
      user("task"),
      toolCall("r1", "read_file", { path: "src/a.ts" }),
      toolResult("r1", "read_file", { path: "src/a.ts" }),
      toolCall("c1", "git_checkpoint", { message: "wip" }),
      toolResult("c1", "git_checkpoint", {
        message: "checkpoint: wip",
        exit_code: 0,
      }),
      // dangling call: no matching result anywhere after
      toolCall("e1", "edit", { path: "src/a.ts" }),
      assistant("done"),
      user("next"),
      toolCall("r2", "read_file", { path: "src/b.ts" }),
      toolResult("r2", "read_file", { path: "src/b.ts" }),
      toolCall("e2", "edit", { path: "src/b.ts" }),
      toolResult("e2", "edit", { path: "src/b.ts" }),
      assistant("done two"),
    ];
    // The only balanced, verified boundary is AFTER the checkpoint (index 5),
    // which is too close to the end for PRUNE_TAIL_KEEP — so no safe cut.
    expect(findVerifiedCut(messages)).toBe(-1);
  });

  it("does not treat a failed checkpoint as verified", () => {
    const messages = verifiedTranscript();
    // Break the checkpoint result.
    const idx = messages.findIndex(
      (m) =>
        m.role === "tool" &&
        Array.isArray(m.content) &&
        (m.content as ToolPart[]).some((p) => p.toolName === "git_checkpoint"),
    );
    const broken = messages.map((m, i) =>
      i === idx
        ? toolResult(
            "c1",
            "git_checkpoint",
            { error: "no git repository" },
            false,
          )
        : m,
    );
    expect(findVerifiedCut(broken)).toBe(-1);
  });

  it("never cuts past the last checkpoint, so unverified work survives", () => {
    // One checkpoint early, then a long stretch of unverified work. The
    // checkpoint proves only the work before it is saved; everything after is
    // in flight and must reach the model.
    const messages: ModelMessage[] = [
      user("start the refactor"),
      toolCall("c1", "git_checkpoint", { message: "cp" }),
      toolResult("c1", "git_checkpoint", {
        message: "checkpoint: cp",
        exit_code: 0,
      }),
    ];
    for (let i = 0; i < 30; i++) {
      messages.push(toolCall(`r${i}`, "read_file", { path: `src/f${i}.ts` }));
      messages.push(toolResult(`r${i}`, "read_file", { path: `src/f${i}.ts` }));
    }
    messages.push(user("now also rename the helper"));

    // Cut would run to n - 6 and discard 30+ unverified rounds. The only
    // prunable span is the 3 messages up to the checkpoint, which is below the
    // minimum worth collapsing - so nothing is pruned at all.
    expect(findVerifiedCut(messages)).toBe(-1);
  });

  it("cuts at the last checkpoint rather than at the tail budget", () => {
    // Two checkpoints: the second one is the ceiling.
    const messages: ModelMessage[] = [
      user("first task"),
      toolCall("c1", "git_checkpoint", { message: "one" }),
      toolResult("c1", "git_checkpoint", {
        message: "checkpoint: one",
        exit_code: 0,
      }),
      toolCall("r1", "read_file", { path: "src/a.ts" }),
      toolResult("r1", "read_file", { path: "src/a.ts" }),
      toolCall("c2", "git_commit", { message: "two" }),
      toolResult("c2", "git_commit", {
        message: "checkpoint: two",
        exit_code: 0,
      }),
      toolCall("r2", "read_file", { path: "src/b.ts" }),
      toolResult("r2", "read_file", { path: "src/b.ts" }),
      user("a later request"),
      assistant("working on it"),
      toolCall("r3", "read_file", { path: "src/c.ts" }),
      toolResult("r3", "read_file", { path: "src/c.ts" }),
      assistant("still working"),
    ];
    const cut = findVerifiedCut(messages);
    // The second checkpoint's result is index 6, so the ceiling is 7.
    expect(cut).toBe(7);
    // The unverified reads after it are kept.
    expect(messages.slice(cut)).toContain(messages[7]);
    expect(messages.slice(cut)).toContain(messages[9]);
  });
});

describe("summarizeSegment", () => {
  it("collects changed files, reads, commands, checks and checkpoints", () => {
    const messages = verifiedTranscript();
    // Add a run_checks call and a git_diff call inside the segment.
    const withChecks: ModelMessage[] = [
      ...messages.slice(0, 7),
      toolCall("v1", "run_checks", { kind: "test" }),
      toolResult("v1", "run_checks", {
        command: "pnpm test",
        kind: "test",
        exit_code: 0,
      }),
      ...messages.slice(7),
    ];
    const summary = summarizeSegment(withChecks);
    expect(summary.checkpoints).toContain("checkpoint: fix a");
    expect(
      summary.changed.some((f) => f.path === "src/a.ts" && f.edits === 1),
    ).toBe(true);
    expect(summary.read).toContain("src/a.ts");
    expect(
      summary.commands.some((c) => c.command === "pnpm test" && c.ok),
    ).toBe(true);
    expect(summary.checks.some((c) => c.command === "pnpm test" && c.ok)).toBe(
      true,
    );
  });

  it("records failing commands and checks", () => {
    const messages: ModelMessage[] = [
      user("run tests"),
      toolCall("b1", "bash_run", { command: "pnpm test" }),
      toolResult("b1", "bash_run", { command: "pnpm test", exit_code: 1 }),
    ];
    const summary = summarizeSegment(messages);
    expect(summary.commands[0]).toMatchObject({
      command: "pnpm test",
      ok: false,
    });
  });

  it("keeps a compact diff note from git_diff output", () => {
    const messages: ModelMessage[] = [
      user("show diff"),
      toolCall("d1", "git_diff", {}),
      toolResult("d1", "git_diff", {
        stdout: "diff --git a/src/a.ts b/src/a.ts\n@@ -1,3 +1,3 @@\n-old\n+new",
      }),
    ];
    const summary = summarizeSegment(messages);
    expect(summary.diffNotes.length).toBeGreaterThan(0);
    expect(summary.diffNotes[0]).toContain("src/a.ts");
  });
});

describe("formatPruneSummary", () => {
  it("formats a readable block under the size cap", () => {
    const summary = summarizeSegment(verifiedTranscript());
    const text = formatPruneSummary(summary);
    expect(text).toContain("checkpoint: fix a");
    expect(text).toContain("Files changed (2)");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("pnpm test");
    expect(text.length).toBeLessThanOrEqual(1800);
  });
});

describe("pruneVerifiedPrefix", () => {
  it("replaces the verified prefix with a single summary message", () => {
    const messages = verifiedTranscript();
    const result = pruneVerifiedPrefix(messages);
    expect(result.pruned).toBe(true);
    expect(result.cutAt).toBeGreaterThan(0);
    expect(result.summary).not.toBeNull();

    const head = result.messages[0];
    expect(head.role).toBe("user");
    expect(typeof head.content).toBe("string");
    expect((head.content as string).includes("checkpoint: fix a")).toBe(true);

    // The tail is preserved verbatim.
    expect(result.messages.slice(1)).toEqual(messages.slice(result.cutAt));

    // The remaining transcript is still balanced (no dangling calls/results).
    let balance = 0;
    for (const m of result.messages.slice(1)) {
      if (typeof m.content === "string") continue;
      for (const p of m.content as ToolPart[]) {
        if (p.type === "tool-call") balance += 1;
        else if (p.type === "tool-result") balance -= 1;
      }
    }
    expect(balance).toBe(0);
  });

  it("returns the input untouched when nothing is verified", () => {
    const messages = verifiedTranscript().filter(
      (m) =>
        !(
          Array.isArray(m.content) &&
          (m.content as ToolPart[]).some((p) => p.toolName === "git_checkpoint")
        ),
    );
    const result = pruneVerifiedPrefix(messages);
    expect(result.pruned).toBe(false);
    expect(result.messages).toEqual(messages);
  });

  it("never prunes away the user's latest request", () => {
    // The invariant that matters to the person using the app: whatever they
    // most recently asked for must survive into the request. The old ceiling
    // (`n - PRUNE_TAIL_KEEP`) held only when the transcript ended within six
    // messages of a checkpoint, which is not the common case.
    const messages: ModelMessage[] = [
      user("early task"),
      toolCall("c1", "git_checkpoint", { message: "one" }),
      toolResult("c1", "git_checkpoint", {
        message: "checkpoint: one",
        exit_code: 0,
      }),
    ];
    for (let i = 0; i < 40; i++) {
      messages.push(toolCall(`x${i}`, "read_file", { path: `src/f${i}.ts` }));
      messages.push(toolResult(`x${i}`, "read_file", { path: `src/f${i}.ts` }));
    }
    const request = "please fix the failing test in auth.spec.ts";
    messages.push(user(request));

    const result = pruneVerifiedPrefix(messages);
    expect(JSON.stringify(result.messages)).toContain(request);
  });

  it("is idempotent on the already-pruned result", () => {
    const once = pruneVerifiedPrefix(verifiedTranscript());
    expect(once.pruned).toBe(true);
    // A second prune finds no verified signal in the tail (the summary user
    // message contains no tool result), so it must not prune again.
    const twice = pruneVerifiedPrefix(once.messages);
    expect(twice.pruned).toBe(false);
  });

  it("recognizes checkpoints whose commit message contains the word error", () => {
    const transcript = verifiedTranscript();
    // Replace checkpoint message with one containing 'error'
    const idx = transcript.findIndex(
      (m) =>
        m.role === "tool" &&
        Array.isArray(m.content) &&
        (m.content as ToolPart[]).some((p) => p.toolName === "git_checkpoint"),
    );
    expect(idx).toBeGreaterThan(-1);
    transcript[idx] = toolResult("c1", "git_checkpoint", {
      command: "git commit -m 'checkpoint: fix error in auth'",
      message: "checkpoint: fix error in auth",
      exit_code: 0,
    });
    const result = pruneVerifiedPrefix(transcript);
    expect(result.pruned).toBe(true);
    expect(result.summary).toContain("checkpoint: fix error in auth");
  });
});
