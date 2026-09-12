// The relay's log lines are the only evidence an operator has on a headless
// install, so the wording is asserted here rather than eyeballed. Each test
// encodes a question the log has to answer:
//
//   - updateLine      -> "did my message arrive, and what kind was it?"
//   - runOutcomeLine  -> "did the chat get an answer, or did the run produce
//                        nothing?" (the reported hang)
//   - approvalWaitLine -> "is it stuck waiting for me?"
//   - relayErrorLine  -> "what failed, and where?"

import { describe, expect, it } from "vitest";
import {
  approvalWaitLine,
  formatDuration,
  relayErrorLine,
  runOutcomeLine,
  updateLine,
} from "./telegramLog";

describe("formatDuration", () => {
  it.each([
    [0, "0s"],
    [999, "1s"],
    [4_000, "4s"],
    [59_400, "59s"],
    [60_000, "1m"],
    [90_000, "1m30s"],
    [3_600_000, "1h"],
    [7_500_000, "2h5m"],
  ] as const)("renders %dms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it("does not render a negative duration as a negative", () => {
    expect(formatDuration(-5_000)).toBe("0s");
  });
});

describe("updateLine", () => {
  it("logs a command by name, not by body", () => {
    const line = updateLine({
      update_id: 12,
      message: { chat: { id: 450913223 }, text: "/model deepseek-v4-pro" },
    });
    expect(line).toBe("update 12 command /model chat=450913223 (22ch)");
    // The argument is reduced to a length: the log is pasted into bug reports.
    expect(line).not.toContain("deepseek");
  });

  it("logs a prompt as a length only", () => {
    const line = updateLine({
      update_id: 13,
      message: { chat: { id: 7 }, text: "audit client-acme.example" },
    });
    expect(line).toBe("update 13 message chat=7 (25ch)");
    expect(line).not.toContain("acme");
  });

  it("names a callback, because a button press drives approval", () => {
    expect(
      updateLine({
        update_id: 14,
        callback_query: {
          data: "approve:aitxt-1",
          message: { chat: { id: 7 } },
        },
      }),
    ).toBe('update 14 callback "approve:aitxt-1" chat=7');
  });

  it("still produces a line when there is no text or no chat id", () => {
    expect(updateLine({ update_id: 15, message: { chat: { id: 7 } } })).toBe(
      "update 15 message chat=7 (no text)",
    );
    expect(updateLine({ update_id: 16 })).toContain(
      "update 16 (unsupported type)",
    );
  });
});

describe("runOutcomeLine", () => {
  const base = {
    sessionId: "s-abc",
    chatId: 7,
    elapsedMs: 12_000,
    replies: 1,
    sentChars: 480,
    fallback: false,
    stopReason: null,
    status: "settled",
    pendingApprovals: 0,
  };

  it("reports an answered run", () => {
    expect(runOutcomeLine(base)).toBe(
      "run s-abc chat=7 12s | 1 answer(s), 480ch sent | stop done | status settled",
    );
  });

  it("makes a run that sent nothing obvious", () => {
    // The reported hang: the agent log said a request happened, and nothing
    // said whether the chat ever received anything.
    const line = runOutcomeLine({
      ...base,
      replies: 0,
      sentChars: 0,
      status: "aborted",
    });
    expect(line).toContain("0 answer(s), 0ch sent");
    expect(line).toContain("status aborted");
  });

  it("distinguishes a canned status line from a real answer", () => {
    expect(runOutcomeLine({ ...base, fallback: true })).toContain(
      "1 fallback(s)",
    );
  });

  it("names an unanswered approval as the reason the run cannot finish", () => {
    const line = runOutcomeLine({ ...base, pendingApprovals: 2 });
    expect(line).toContain("BLOCKED on 2 unanswered approval(s)");
  });

  it("reports the step cap instead of claiming the run was done", () => {
    expect(runOutcomeLine({ ...base, stopReason: "step-cap" })).toContain(
      "stop step-cap",
    );
  });
});

describe("approvalWaitLine", () => {
  it("says the run cannot proceed and names the tools", () => {
    const line = approvalWaitLine(2, ["edit", "bash_run"]);
    expect(line).toContain("waiting on 2 unanswered approval(s)");
    expect(line).toContain("edit, bash_run");
    expect(line).toContain("cannot proceed");
  });

  it("deduplicates tool names and caps the list", () => {
    const line = approvalWaitLine(9, [
      "edit",
      "edit",
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    expect(line).toContain("edit, a, b, c, d");
    expect(line).not.toContain("edit, edit");
    expect(line).not.toContain(", f");
  });

  it("reads correctly with no tool names available", () => {
    expect(approvalWaitLine(1, [])).toContain("waiting on 1 unanswered");
  });
});

describe("relayErrorLine", () => {
  it("names the place and the message", () => {
    expect(relayErrorLine("getUpdates", new Error("socket hang up"))).toBe(
      "getUpdates failed: socket hang up",
    );
  });

  it("handles a non-Error throw", () => {
    expect(relayErrorLine("update 4", "bad payload")).toBe(
      "update 4 failed: bad payload",
    );
  });
});
