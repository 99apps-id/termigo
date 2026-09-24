// The loop breaker for the SDK's automatic approval resume.
//
// The failure this guards against is an endless cycle, not a crash: the model
// re-requests the same approval, the SDK re-sends automatically, the transcript
// never grows, and the run repeats forever. The distinguishing signal is
// progress, so the cases below are about which counts count as progress.

import { describe, expect, it } from "vitest";
import {
  autoSendAskIsDuplicate,
  autoSendGate,
  canonicalToolFingerprint,
  computeTranscriptProductiveProgress,
  extractRecentTranscriptToolCalls,
  hasFileRedirection,
  INITIAL_AUTO_SEND_STATE,
  isMutatingToolCall,
  isToolCallError,
  MAX_STALLED_AUTO_SENDS,
  MAX_TOTAL_AUTO_SENDS,
  summarizeInput,
  type AutoSendGateOptions,
} from "./autoSendGate";

/** Feed a sequence of transcript sizes through the gate. */
function run(counts: number[], maxStalled?: number | AutoSendGateOptions) {
  let state = INITIAL_AUTO_SEND_STATE;
  return counts.map((count) => {
    const decision = autoSendGate(state, count, maxStalled);
    state = decision.state;
    return decision;
  });
}

describe("autoSendGate", () => {
  it("allows a resume that added a tool result", () => {
    const [first] = run([14, 16]);
    expect(first.allow).toBe(true);
    expect(first.stoppedLoop).toBe(false);
  });

  it("keeps allowing while the transcript grows", () => {
    const decisions = run([14, 16, 18, 20, 22, 24]);
    expect(decisions.every((d) => d.allow)).toBe(true);
    expect(decisions.some((d) => d.stoppedLoop)).toBe(false);
  });

  it("stops a run that re-sends without making progress", () => {
    // THE regression: the same transcript size on every cycle. The field log
    // showed `run: start (14 messages)` repeating with `steps 1/25` and
    // `runRound` still 0, so nothing was accumulating.
    // The first call is progress (the transcript grew from empty), then
    // `maxStalled` unproductive sends are tolerated before the gate gives up.
    const flat = Array.from({ length: MAX_STALLED_AUTO_SENDS + 4 }, () => 14);
    const decisions = run(flat);
    const allowed = decisions.filter((d) => d.allow).length;
    expect(allowed).toBe(MAX_STALLED_AUTO_SENDS + 1);
    expect(decisions.at(-1)?.allow).toBe(false);
    expect(decisions.at(-1)?.stoppedLoop).toBe(true);
  });

  it("keeps refusing once it has given up", () => {
    const flat = Array.from({ length: MAX_STALLED_AUTO_SENDS + 5 }, () => 14);
    const decisions = run(flat);
    const refused = decisions.filter((d) => !d.allow);
    expect(refused).toHaveLength(4);
    // Every refusal reports the loop, so a caller that keeps asking cannot be
    // allowed back in by the same unproductive transcript.
    expect(refused.every((d) => d.stoppedLoop)).toBe(true);
  });

  it("recovers when real work arrives again", () => {
    const stalled = Array.from(
      { length: MAX_STALLED_AUTO_SENDS + 2 },
      () => 14,
    );
    const decisions = run([...stalled, 30, 32]);
    const afterGrowth = decisions.slice(-2);
    expect(afterGrowth.every((d) => d.allow)).toBe(true);
    expect(decisions.at(-1)?.state.stalled).toBe(0);
  });

  it("clears the streak on growth rather than carrying it forward", () => {
    // A burst of stalls, then progress, then a burst of stalls: the second burst
    // gets its own full budget instead of being cut short by the first.
    const first = Array.from({ length: MAX_STALLED_AUTO_SENDS + 1 }, () => 10);
    const second = Array.from({ length: MAX_STALLED_AUTO_SENDS + 1 }, () => 20);
    const decisions = run([...first, 20, ...second], { maxTotalAutoSends: 50 });
    const [growth, ...burst] = decisions.slice(first.length);
    expect(growth.allow).toBe(true);
    expect(growth.state.stalled).toBe(0);
    // One tolerated send plus the full stalled budget for the new size.
    expect(burst.filter((d) => d.allow)).toHaveLength(MAX_STALLED_AUTO_SENDS);
    expect(burst.at(-1)?.allow).toBe(false);
  });

  it("honours a caller-supplied bound", () => {
    // With a bound of 1: one tolerated unproductive send, then refusals.
    const decisions = run([5, 5, 5, 5], 1);
    expect(decisions.map((d) => d.allow)).toEqual([true, true, false, false]);
  });

  it("starts from the initial state without allowing anything twice for free", () => {
    expect(INITIAL_AUTO_SEND_STATE).toEqual({
      lastProgress: 0,
      stalled: 0,
      totalAutoSends: 0,
    });
    // The very first assessment is progress from an empty transcript.
    expect(autoSendGate(INITIAL_AUTO_SEND_STATE, 1).allow).toBe(true);
  });

  it("treats growth in parts as progress, not just growth in message count", () => {
    // Why the caller counts PARTS. A tool round appends its results to the same
    // assistant message, so real work can add many parts while the number of
    // messages stays constant. Measuring messages would call that a stall and
    // stop a run that was making progress - the field log showed exactly that
    // shape: 19 runs, `steps 1/25 | stop tool-calls`, message count pinned at 14
    // while the transcript was in fact changing.
    const decisions = run([10, 14, 18, 22, 26, 30, 34]);
    expect(decisions.every((d) => d.allow)).toBe(true);
    // Each growth step also clears the stall streak.
    expect(decisions.at(-1)?.state.stalled).toBe(0);
  });
});

/**
 * The gate is only as good as what the caller feeds it, and the first version
 * of that caller fed it nothing in the case that matters. These tests drive the
 * gate the way the runtime does, including the duplicate asks inside one cycle.
 */
describe("the caller's once-per-send rule", () => {
  /** Mirrors `sendAutomaticallyWhen`: asks are deduped, a round clears pending. */
  function simulate(progressPerCycle: number[]): boolean[] {
    let state = INITIAL_AUTO_SEND_STATE;
    let decidedAt = -1;
    let allowed = true;
    let pending = false;
    const perCycle: boolean[] = [];
    for (const progress of progressPerCycle) {
      let verdict = false;
      // The SDK may ask more than once before the round starts.
      for (let ask = 0; ask < 2; ask += 1) {
        if (autoSendAskIsDuplicate({ pending, decidedAt, progress })) {
          verdict = allowed;
          continue;
        }
        const decision = autoSendGate(state, progress);
        state = decision.state;
        decidedAt = progress;
        allowed = decision.allow;
        pending = decision.allow;
        verdict = allowed;
      }
      perCycle.push(verdict);
      // The authorised send became a round (`onRoundStart`).
      pending = false;
    }
    return perCycle;
  }

  it("counts one stalled resume per real send, not one per ask", () => {
    // THE regression, 2026-09-15. Fifteen resumes, ~3 minutes apart, all
    // aborted: the transcript stayed at the same part count because a killed
    // resume appends nothing. The old rule returned the cached verdict for an
    // unchanged progress value, so `stalled` never incremented and the bound
    // never engaged - the run repeated for half an hour with the app looking
    // frozen. The first cycle is progress (from an empty transcript), then
    // `MAX_STALLED_AUTO_SENDS` unproductive resumes are tolerated.
    const cycles = MAX_STALLED_AUTO_SENDS + 3;
    const verdicts = simulate(Array.from({ length: cycles }, () => 170));
    expect(verdicts.filter(Boolean)).toHaveLength(MAX_STALLED_AUTO_SENDS + 1);
    expect(verdicts.at(-1)).toBe(false);
  });

  it("still allows every cycle that grows the transcript", () => {
    const verdicts = simulate([10, 14, 18, 22, 26, 30, 34]);
    expect(verdicts.every(Boolean)).toBe(true);
  });

  it("only treats a repeated ask as duplicate once a send is pending", () => {
    // Without the pending flag the same progress would be free forever, which is
    // the bug this replaced; with it, the second ask of the SAME cycle is free
    // and the next cycle is counted.
    expect(
      autoSendAskIsDuplicate({ pending: true, decidedAt: 170, progress: 170 }),
    ).toBe(true);
    expect(
      autoSendAskIsDuplicate({ pending: false, decidedAt: 170, progress: 170 }),
    ).toBe(false);
    expect(
      autoSendAskIsDuplicate({ pending: true, decidedAt: 170, progress: 174 }),
    ).toBe(false);
  });
});

describe("helpers", () => {
  it("detects tool call errors", () => {
    expect(isToolCallError({ error: "failed" })).toBe(true);
    expect(isToolCallError({ exit_code: 1 })).toBe(true);
    expect(isToolCallError({ exit_code: 0 })).toBe(false);
    expect(isToolCallError({ content: "ok" })).toBe(false);
  });

  it("produces deterministic canonical fingerprints regardless of key ordering", () => {
    const fp1 = canonicalToolFingerprint("edit", { a: 1, b: 2 });
    const fp2 = canonicalToolFingerprint("edit", { b: 2, a: 1 });
    expect(fp1).toBe(fp2);
  });

  it("summarizes input cleanly for UI diagnostics", () => {
    expect(summarizeInput("edit", { path: "src/core/flow.ts" })).toBe("flow.ts");
    expect(summarizeInput("bash_run", { command: "cargo test" })).toBe('"cargo test"');
  });
});

describe("computeTranscriptProductiveProgress", () => {
  it("rewards non-empty assistant text parts", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        parts: [{ type: "text", text: "Here is the plan for refactoring." }],
      },
    ];
    const progress = computeTranscriptProductiveProgress(messages);
    expect(progress).toBeGreaterThan(0);
  });

  it("does not count errored tool calls or approval metadata", () => {
    const messages = [
      {
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "reasoning", text: "Trying edit..." },
          {
            type: "tool-edit",
            state: "output-available",
            input: { path: "flow.ts", old_string: "a", new_string: "b" },
            output: { error: "old_string not found" },
          },
          { type: "tool-approval-request" },
          { type: "tool-approval-response" },
        ],
      },
    ];
    const progress = computeTranscriptProductiveProgress(messages);
    expect(progress).toBe(0);
  });

  it("rewards successful tool executions", () => {
    const messages = [
      {
        role: "assistant",
        parts: [
          {
            type: "tool-edit",
            state: "output-available",
            input: { path: "flow.ts", old_string: "a", new_string: "b" },
            output: { success: true },
          },
        ],
      },
    ];
    const progress = computeTranscriptProductiveProgress(messages);
    expect(progress).toBe(10);
  });

  it("deduplicates identical read operations when no mutation occurs", () => {
    const messages = [
      {
        role: "assistant",
        parts: [
          {
            type: "tool-read_file",
            state: "output-available",
            input: { path: "flow.ts", offset: 100, limit: 30 },
            output: { content: "line 100..." },
          },
          {
            type: "tool-read_file",
            state: "output-available",
            input: { path: "flow.ts", offset: 100, limit: 30 },
            output: { content: "line 100..." },
          },
        ],
      },
    ];
    const progress = computeTranscriptProductiveProgress(messages);
    // Only the first read adds progress; duplicate read does not
    expect(progress).toBe(10);
  });

  it("resets read deduplication after a successful mutating tool", () => {
    const messages = [
      {
        role: "assistant",
        parts: [
          {
            type: "tool-read_file",
            state: "output-available",
            input: { path: "flow.ts", offset: 100, limit: 30 },
            output: { content: "old content" },
          },
          {
            type: "tool-edit",
            state: "output-available",
            input: { path: "flow.ts", old_string: "old", new_string: "new" },
            output: { success: true },
          },
          {
            type: "tool-read_file",
            state: "output-available",
            input: { path: "flow.ts", offset: 100, limit: 30 },
            output: { content: "new content" },
          },
        ],
      },
    ];
    const progress = computeTranscriptProductiveProgress(messages);
    // read (10) + edit (10) + re-read after edit (10) = 30
    expect(progress).toBe(30);
  });
});

describe("extractRecentTranscriptToolCalls", () => {
  it("extracts tool calls from the latest user message onward", () => {
    const messages = [
      {
        role: "user",
        parts: [{ type: "text", text: "first question" }],
      },
      {
        role: "assistant",
        parts: [
          {
            type: "tool-read_file",
            input: { path: "old.ts" },
            state: "output-available",
          },
        ],
      },
      {
        role: "user",
        parts: [{ type: "text", text: "second question" }],
      },
      {
        role: "assistant",
        parts: [
          {
            type: "tool-edit",
            input: { path: "new.ts" },
            output: { error: "failed" },
            state: "output-available",
          },
        ],
      },
    ];

    const calls = extractRecentTranscriptToolCalls(messages);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("edit");
    expect(calls[0].isError).toBe(true);
  });
});

describe("autoSendGate tool repetition and failure breakers", () => {
  it("stops a run when the exact same tool call repeats 3 times", () => {
    const repeatingCall = {
      toolName: "edit",
      input: { path: "provider.ts", old_string: "x", new_string: "y" },
      output: { error: "old_string not found" },
      isError: true,
      hasResult: true,
    };

    const recentToolCalls = [repeatingCall, repeatingCall, repeatingCall];
    const decision = autoSendGate(INITIAL_AUTO_SEND_STATE, 10, {
      recentToolCalls,
    });

    expect(decision.allow).toBe(false);
    expect(decision.stoppedLoop).toBe(true);
    expect(decision.reason).toContain("provider.ts");
    expect(decision.reason).toContain("failed repeatedly");
  });

  it("stops when the same tool call fails 2 times with identical arguments", () => {
    const failedCall = {
      toolName: "edit",
      input: { path: "auth.ts", old_string: "bad", new_string: "fixed" },
      output: { error: "old_string not found" },
      isError: true,
      hasResult: true,
    };

    const recentToolCalls = [failedCall, failedCall];
    const decision = autoSendGate(INITIAL_AUTO_SEND_STATE, 10, {
      recentToolCalls,
    });

    expect(decision.allow).toBe(false);
    expect(decision.stoppedLoop).toBe(true);
    expect(decision.reason).toContain("failed repeatedly with identical arguments");
  });

  it("catches alternating read and failed edit loops", () => {
    const readFileCall = {
      toolName: "read_file",
      input: { path: "auth.ts", offset: 100, limit: 30 },
      output: { content: "verbatim" },
      isError: false,
      hasResult: true,
    };
    const failedEditCall = {
      toolName: "edit",
      input: { path: "auth.ts", old_string: "bad", new_string: "fixed" },
      output: { error: "old_string not found" },
      isError: true,
      hasResult: true,
    };

    const recentToolCalls = [
      readFileCall,
      failedEditCall,
      readFileCall,
      failedEditCall,
    ];

    const decision = autoSendGate(INITIAL_AUTO_SEND_STATE, 10, {
      recentToolCalls,
    });

    expect(decision.allow).toBe(false);
    expect(decision.stoppedLoop).toBe(true);
  });

  it("stops after 3 consecutive failures across different tools", () => {
    const recentToolCalls = [
      {
        toolName: "edit",
        input: { path: "a.ts" },
        output: { error: "not found" },
        isError: true,
        hasResult: true,
      },
      {
        toolName: "edit",
        input: { path: "b.ts" },
        output: { error: "not found" },
        isError: true,
        hasResult: true,
      },
      {
        toolName: "bash_run",
        input: { command: "npm test" },
        output: { exit_code: 1 },
        isError: true,
        hasResult: true,
      },
    ];

    const decision = autoSendGate(INITIAL_AUTO_SEND_STATE, 10, {
      recentToolCalls,
    });

    expect(decision.allow).toBe(false);
    expect(decision.stoppedLoop).toBe(true);
    expect(decision.reason).toContain("consecutive tool calls failed");
  });

  it("allows diverse successful operations to continue", () => {
    const recentToolCalls = [
      {
        toolName: "read_file",
        input: { path: "a.ts" },
        output: { content: "..." },
        isError: false,
        hasResult: true,
      },
      {
        toolName: "edit",
        input: { path: "a.ts", old_string: "1", new_string: "2" },
        output: { success: true },
        isError: false,
        hasResult: true,
      },
      {
        toolName: "read_file",
        input: { path: "b.ts" },
        output: { content: "..." },
        isError: false,
        hasResult: true,
      },
      {
        toolName: "edit",
        input: { path: "b.ts", old_string: "3", new_string: "4" },
        output: { success: true },
        isError: false,
        hasResult: true,
      },
    ];

    const decision = autoSendGate(INITIAL_AUTO_SEND_STATE, 40, {
      recentToolCalls,
    });

    expect(decision.allow).toBe(true);
    expect(decision.stoppedLoop).toBe(false);
  });

  it("allows repeated reads of the same file when intervened by successful mutations", () => {
    const readFileCall = {
      toolName: "read_file",
      input: { path: "main.ts" },
      output: { content: "code" },
      isError: false,
      hasResult: true,
    };
    const successfulEdit1 = {
      toolName: "edit",
      input: { path: "main.ts", old_string: "a", new_string: "b" },
      output: { success: true },
      isError: false,
      hasResult: true,
    };
    const successfulEdit2 = {
      toolName: "edit",
      input: { path: "main.ts", old_string: "b", new_string: "c" },
      output: { success: true },
      isError: false,
      hasResult: true,
    };

    const recentToolCalls = [
      readFileCall,
      successfulEdit1,
      readFileCall,
      successfulEdit2,
      readFileCall,
    ];

    const decision = autoSendGate(INITIAL_AUTO_SEND_STATE, 50, {
      recentToolCalls,
    });

    expect(decision.allow).toBe(true);
    expect(decision.stoppedLoop).toBe(false);
  });

  it("resolves standalone tool-result messages for productive progress calculation", () => {
    const messages = [
      {
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            toolCallId: "call_abc",
            toolName: "edit",
            input: { path: "auth.ts" },
          },
        ],
      },
      {
        role: "tool",
        parts: [
          {
            type: "tool-result",
            toolCallId: "call_abc",
            output: { success: true },
          },
        ],
      },
    ];

    const progress = computeTranscriptProductiveProgress(messages);
    expect(progress).toBe(10);
  });

  it("stops a runaway loop when reaching MAX_TOTAL_AUTO_SENDS even if progress grows each cycle", () => {
    let state = INITIAL_AUTO_SEND_STATE;
    const decisions = [];
    for (let i = 1; i <= MAX_TOTAL_AUTO_SENDS + 2; i++) {
      const decision = autoSendGate(state, i * 10);
      state = decision.state;
      decisions.push(decision);
    }
    const allowed = decisions.filter((d) => d.allow);
    expect(allowed).toHaveLength(MAX_TOTAL_AUTO_SENDS);
    expect(decisions.at(-1)?.allow).toBe(false);
    expect(decisions.at(-1)?.stoppedLoop).toBe(true);
    expect(decisions.at(-1)?.reason).toContain("maximum limit of 10 automatic sends");
  });
});

describe("isMutatingToolCall", () => {
  it("treats file editing tools as mutating", () => {
    expect(isMutatingToolCall("edit", { path: "a.ts" })).toBe(true);
    expect(isMutatingToolCall("write_file", { path: "a.ts" })).toBe(true);
    expect(isMutatingToolCall("multi_edit", { path: "a.ts" })).toBe(true);
    expect(isMutatingToolCall("replace_file_content", { path: "a.ts" })).toBe(true);
  });

  it("treats read-only shell commands and probes as non-mutating", () => {
    expect(isMutatingToolCall("bash_run", { command: "cat file.txt" })).toBe(false);
    expect(isMutatingToolCall("bash_run", { command: "git status" })).toBe(false);
    expect(isMutatingToolCall("bash_run", { command: "git diff HEAD~1" })).toBe(false);
    expect(isMutatingToolCall("bash_run", { command: "npx tsc --noEmit" })).toBe(false);
    expect(isMutatingToolCall("bash_run", { command: "node -e 'console.log(process.version)'" })).toBe(false);
    expect(isMutatingToolCall("bash_run", { command: "Get-Content -Path file.txt" })).toBe(false);
    expect(isMutatingToolCall("bash_run", { command: "ls -la" })).toBe(false);
    expect(isMutatingToolCall("bash_run", { command: "grep -rn 'foo' src/" })).toBe(false);
  });

  it("treats mutating shell commands as mutating", () => {
    expect(isMutatingToolCall("bash_run", { command: "pnpm install" })).toBe(true);
    expect(isMutatingToolCall("bash_run", { command: "npm i -D vitest" })).toBe(true);
    expect(isMutatingToolCall("bash_run", { command: "rm -rf dist/" })).toBe(true);
    expect(isMutatingToolCall("bash_run", { command: "mkdir -p newdir" })).toBe(true);
    expect(isMutatingToolCall("bash_run", { command: "touch newfile.ts" })).toBe(true);
    expect(isMutatingToolCall("bash_run", { command: "git commit -m 'feat: update'" })).toBe(true);
    expect(isMutatingToolCall("bash_run", { command: "git checkout -b feature" })).toBe(true);
    expect(isMutatingToolCall("bash_run", { command: "echo 'line' > file.txt" })).toBe(true);
    expect(isMutatingToolCall("bash_run", { command: "echo 'line' >> file.txt" })).toBe(true);
    expect(isMutatingToolCall("bash_run", { command: "cargo build --release" })).toBe(true);
  });

  it("treats null device redirection as non-mutating", () => {
    expect(isMutatingToolCall("bash_run", { command: "node -e 'console.log(1)' > /dev/null 2>&1" })).toBe(false);
    expect(isMutatingToolCall("bash_run", { command: "git status > nul 2>&1" })).toBe(false);
  });

  it("prevents read-only bash probes from resetting tool repeat counters", () => {
    const probeCall = {
      toolName: "bash_run",
      input: { command: "node -e 'console.log(1)'" },
      output: { stdout: "1", exit_code: 0 },
      isError: false,
      hasResult: true,
    };
    const readFileCall = {
      toolName: "read_file",
      input: { path: "main.ts" },
      output: { content: "code" },
      isError: false,
      hasResult: true,
    };

    // 3 identical reads separated by read-only bash probes must still trigger repeat breaker
    const recentToolCalls = [
      readFileCall,
      probeCall,
      readFileCall,
      probeCall,
      readFileCall,
    ];

    const decision = autoSendGate(INITIAL_AUTO_SEND_STATE, 50, {
      recentToolCalls,
    });

    expect(decision.allow).toBe(false);
    expect(decision.stoppedLoop).toBe(true);
    expect(decision.reason).toContain("repeated 3 times");
  });
});

describe("hasFileRedirection", () => {
  it("detects output file redirection while ignoring null devices and stderr merges", () => {
    expect(hasFileRedirection("echo hi > file.txt")).toBe(true);
    expect(hasFileRedirection("echo hi >> file.txt")).toBe(true);
    expect(hasFileRedirection("echo hi > /dev/null")).toBe(false);
    expect(hasFileRedirection("echo hi > nul")).toBe(false);
    expect(hasFileRedirection("node -e '...' 2>&1")).toBe(false);
    expect(hasFileRedirection("node -e '...' > /dev/null 2>&1")).toBe(false);
  });
});

