// An approval the user never answers must not hold a run open forever.
//
// The timer bookkeeping is the part that can go wrong, because the effect that
// drives it re-runs on every streamed token: a countdown restarted on each
// token never fires, and a timer left on an answered approval later responds to
// an id the run has already moved past.

import { describe, expect, it } from "vitest";
import {
  APPROVAL_EXPIRED_REASON,
  APPROVAL_TTL_MS,
  pendingApprovalIds,
  reconcileApprovalTimers,
} from "./approvalExpiry";

describe("reconcileApprovalTimers", () => {
  it("arms a timer for a newly waiting approval", () => {
    const { arm, clear } = reconcileApprovalTimers(new Set(), ["a"]);
    expect(arm).toEqual(["a"]);
    expect(clear).toEqual([]);
  });

  it("does not restart a timer that is already running", () => {
    // The whole point: this runs per streamed token, so re-arming would reset
    // the countdown forever and it would never fire.
    const { arm, clear } = reconcileApprovalTimers(new Set(["a"]), ["a"]);
    expect(arm).toEqual([]);
    expect(clear).toEqual([]);
  });

  it("clears a timer whose approval is no longer waiting", () => {
    const { arm, clear } = reconcileApprovalTimers(new Set(["a", "b"]), ["a"]);
    expect(arm).toEqual([]);
    expect(clear).toEqual(["b"]);
  });

  it("clears every timer when nothing is waiting", () => {
    const { arm, clear } = reconcileApprovalTimers(
      new Set(["a", "b"]),
      [],
    );
    expect(arm).toEqual([]);
    expect(clear).toEqual(["a", "b"]);
  });

  it("arms only the new ones when others are already running", () => {
    const { arm, clear } = reconcileApprovalTimers(
      new Set(["a"]),
      ["a", "b", "c"],
    );
    expect(arm).toEqual(["b", "c"]);
    expect(clear).toEqual([]);
  });

  it("is idempotent: reconciling the same state changes nothing", () => {
    const first = reconcileApprovalTimers(new Set(), ["a", "b"]);
    const armed = new Set(first.arm);
    const second = reconcileApprovalTimers(armed, ["a", "b"]);
    expect(second).toEqual({ arm: [], clear: [] });
  });
});

describe("pendingApprovalIds", () => {
  const assistant = (parts: unknown[]) => [
    { role: "user", parts: [{ type: "text", text: "go" }] },
    { role: "assistant", parts },
  ];

  it("collects the ids awaiting an answer", () => {
    const ids = pendingApprovalIds(
      assistant([
        { type: "tool-bash_run", state: "approval-requested", approval: { id: "q1" } },
        { type: "tool-edit", state: "approval-requested", approval: { id: "q2" } },
      ]),
    );
    expect(ids).toEqual(["q1", "q2"]);
  });

  it("ignores parts that are already answered or running", () => {
    const ids = pendingApprovalIds(
      assistant([
        { type: "tool-bash_run", state: "approval-responded", approval: { id: "q1" } },
        { type: "tool-edit", state: "output-available", approval: { id: "q2" } },
        { type: "tool-grep", state: "output-available" },
      ]),
    );
    expect(ids).toEqual([]);
  });

  it("ignores a requested part with no id", () => {
    expect(
      pendingApprovalIds(assistant([{ type: "tool-x", state: "approval-requested" }])),
    ).toEqual([]);
  });

  it("looks only at the last message", () => {
    // An old turn's approval belongs to a run that is over.
    const messages = [
      { role: "assistant", parts: [{ state: "approval-requested", approval: { id: "old" } }] },
      { role: "user", parts: [{ type: "text", text: "next" }] },
    ];
    expect(pendingApprovalIds(messages)).toEqual([]);
  });

  it("returns nothing when the last message is not from the assistant", () => {
    expect(pendingApprovalIds([{ role: "user", parts: [] }])).toEqual([]);
  });

  it("survives an empty or malformed transcript", () => {
    expect(pendingApprovalIds([])).toEqual([]);
    expect(pendingApprovalIds([{ role: "assistant" }])).toEqual([]);
    expect(pendingApprovalIds([{ role: "assistant", parts: "nope" }])).toEqual(
      [],
    );
  });

  it("clears an armed timer once the turn moves on", () => {
    // The leak this pair exists to prevent. A timer is armed for an approval
    // awaiting an answer; the user then answers it in the app or resumes past
    // it, so the transcript's last message is no longer that assistant turn.
    // The driver effect originally returned early on exactly that shape, so the
    // timer stayed armed and fired minutes later against an id the run had left
    // behind - answering a question nobody asked.
    const armed = new Set(["q1"]);
    const conversationMovedOn = [
      {
        role: "assistant",
        parts: [{ state: "approval-requested", approval: { id: "q1" } }],
      },
      { role: "user", parts: [{ type: "text", text: "actually, do this" }] },
    ];
    const awaiting = pendingApprovalIds(conversationMovedOn);
    expect(awaiting).toEqual([]);
    expect(reconcileApprovalTimers(armed, awaiting)).toEqual({
      arm: [],
      clear: ["q1"],
    });
  });
});

describe("the deadline", () => {
  it("is bounded, so an ignored approval cannot hang a run", () => {
    expect(APPROVAL_TTL_MS).toBeGreaterThan(0);
    expect(APPROVAL_TTL_MS).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it("matches the approval queue's window", () => {
    // One rule for both paths; two different timeouts is how a user learns to
    // distrust the one they cannot see.
    expect(APPROVAL_TTL_MS).toBe(5 * 60 * 1000);
  });

  it("explains itself, since a silent denial reads as a bug", () => {
    expect(APPROVAL_EXPIRED_REASON).toContain("5 minutes");
    expect(APPROVAL_EXPIRED_REASON).toContain("not run");
  });
});
