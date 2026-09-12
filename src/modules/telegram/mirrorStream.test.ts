// The mirror streaming rules. Two failures are being prevented here, and they
// pull in opposite directions:
//
//   - Holding an assistant message until the run settles piles every answer at
//     the end, out of order ("output chat ditumpuk di belakang").
//   - Sending it immediately and marking it seen TRUNCATES it: one assistant
//     message accumulates all the text of a run, and the dedup key is the
//     message id, so the first partial send wins and the rest never arrives.
//
// Editing in place is the way between them, and these tests pin the timing
// rules that make it safe - including that a quiet run is NOT treated as a
// finished one, because provider latency here is 5-70s per step.

import { describe, expect, it } from "vitest";
import {
  MIRROR_EDIT_MIN_INTERVAL_MS,
  type MirrorStreamState,
  planMirrorDelivery,
  shouldFinalizeStream,
  startedState,
} from "./mirrorStream";

const t0 = 1_000_000;

function streaming(over: Partial<MirrorStreamState> = {}): MirrorStreamState {
  return {
    messageId: 555,
    pushed: "Answer so far.",
    lastEditAt: t0,
    overflow: false,
    ...over,
  };
}

describe("planMirrorDelivery", () => {
  it("sends a partial answer once, as a start, without marking it seen", () => {
    const plan = planMirrorDelivery({
      text: "Reading the file...",
      settled: false,
      state: null,
      now: t0,
    });
    expect(plan.send).toEqual({ kind: "start", text: "Reading the file..." });
    // Not seen: the answer is not finished, and the id is the dedup key.
    expect(plan.markSeen).toBe(false);
    expect(plan.next?.pushed).toBe("Reading the file...");
    expect(plan.complete).toBe(false);
  });

  it("edits the same message when the text grows, instead of sending again", () => {
    const plan = planMirrorDelivery({
      text: "Answer so far. More.",
      settled: false,
      state: streaming({ lastEditAt: t0 - MIRROR_EDIT_MIN_INTERVAL_MS }),
      now: t0,
    });
    expect(plan.send).toEqual({ kind: "edit", text: "Answer so far. More." });
    expect(plan.markSeen).toBe(false);
    expect(plan.next?.pushed).toBe("Answer so far. More.");
  });

  it("does not edit more often than the throttle allows", () => {
    const plan = planMirrorDelivery({
      text: "Answer so far. More.",
      settled: false,
      state: streaming({ lastEditAt: t0 - 100 }),
      now: t0,
    });
    expect(plan.send).toBeNull();
    expect(plan.markSeen).toBe(false);
    // The pushed text is NOT advanced, or the next allowed tick would consider
    // this text already delivered and skip it.
    expect(plan.next?.pushed).toBe("Answer so far.");
  });

  it("sends nothing when the text has not changed", () => {
    const plan = planMirrorDelivery({
      text: "Answer so far.",
      settled: false,
      state: streaming({ lastEditAt: t0 - MIRROR_EDIT_MIN_INTERVAL_MS }),
      now: t0,
    });
    expect(plan.send).toBeNull();
    expect(plan.markSeen).toBe(false);
  });

  it("does NOT finalize a quiet run - provider latency is not the end of a run", () => {
    // A 60s gap between steps is normal on a real endpoint. Finalizing here
    // would mark the message seen mid-run and silently drop everything after.
    const plan = planMirrorDelivery({
      text: "Answer so far.",
      settled: false,
      state: streaming({ lastEditAt: t0 - 60_000 }),
      now: t0,
    });
    expect(plan.send).toBeNull();
    expect(plan.markSeen).toBe(false);
  });

  it("finalizes with the whole answer once the run settles", () => {
    const plan = planMirrorDelivery({
      text: "The complete answer.",
      settled: true,
      state: streaming(),
      now: t0,
    });
    expect(plan.send).toEqual({
      kind: "finalize",
      text: "The complete answer.",
    });
    expect(plan.markSeen).toBe(true);
    expect(plan.next).toBeNull();
    expect(plan.complete).toBe(true);
  });

  it("only marks seen when the finalize is actually delivered", () => {
    // Same text already pushed: nothing to send, but the message IS complete,
    // so it has to be marked seen or it is re-checked forever.
    const plan = planMirrorDelivery({
      text: "Answer so far.",
      settled: true,
      state: streaming(),
      now: t0,
    });
    expect(plan.send).toBeNull();
    expect(plan.markSeen).toBe(true);
  });

  it("sends a settled message whole, never as a partial start", () => {
    const plan = planMirrorDelivery({
      text: "A finished answer.",
      settled: true,
      state: null,
      now: t0,
    });
    expect(plan.send).toEqual({ kind: "send", text: "A finished answer." });
    expect(plan.markSeen).toBe(true);
  });

  it("does not mark an empty assistant message seen while the run is live", () => {
    // The message exists from its first reasoning part. Marking it seen here is
    // the latent bug that loses an answer that has not been written yet.
    const plan = planMirrorDelivery({
      text: "",
      settled: false,
      state: null,
      now: t0,
    });
    expect(plan.send).toBeNull();
    expect(plan.markSeen).toBe(false);
  });

  it("does mark an empty assistant message seen once the run is over", () => {
    const plan = planMirrorDelivery({
      text: "",
      settled: true,
      state: null,
      now: t0,
    });
    expect(plan.send).toBeNull();
    expect(plan.markSeen).toBe(true);
  });

  it("refuses to stream text that cannot fit one Telegram message", () => {
    const plan = planMirrorDelivery({
      text: "x".repeat(5000),
      settled: false,
      state: null,
      now: t0,
      limit: 4096,
    });
    // A partial send could never be completed in place, so wait for settle and
    // let the chunked path deliver all of it.
    expect(plan.send).toBeNull();
    expect(plan.markSeen).toBe(false);
    expect(plan.next?.overflow).toBe(true);
  });

  it("stops editing when the text outgrows one message mid-run", () => {
    const plan = planMirrorDelivery({
      text: "x".repeat(5000),
      settled: false,
      state: streaming(),
      now: t0,
      limit: 4096,
    });
    expect(plan.send).toBeNull();
    expect(plan.next?.overflow).toBe(true);
    expect(plan.markSeen).toBe(false);
  });

  it("delivers an overflowing answer by sending it when it settles", () => {
    const plan = planMirrorDelivery({
      text: "x".repeat(5000),
      settled: true,
      state: streaming({ overflow: true }),
      now: t0,
      limit: 4096,
    });
    expect(plan.send?.kind).toBe("finalize");
    expect(plan.markSeen).toBe(true);
  });

  it("sends rather than edits when the overflow happened before any message existed", () => {
    const plan = planMirrorDelivery({
      text: "x".repeat(5000),
      settled: true,
      state: streaming({ messageId: 0, pushed: "", overflow: true }),
      now: t0,
      limit: 4096,
    });
    // No Telegram message to edit, so this is a fresh chunked send.
    expect(plan.send?.kind).toBe("send");
    expect(plan.markSeen).toBe(true);
  });

  it("stays quiet on every tick between drain and settle while overflowing", () => {
    let state: MirrorStreamState | null = streaming({ overflow: true });
    for (let i = 0; i < 5; i++) {
      const plan = planMirrorDelivery({
        text: "x".repeat(5000),
        settled: false,
        state,
        now: t0 + i * 2000,
        limit: 4096,
      });
      expect(plan.send).toBeNull();
      state = plan.next;
    }
    expect(state?.overflow).toBe(true);
  });
});

describe("startedState", () => {
  it("records the real Telegram message id for later edits", () => {
    const plan = planMirrorDelivery({
      text: "partial",
      settled: false,
      state: null,
      now: t0,
    });
    const state = startedState(9876, plan);
    expect(state?.messageId).toBe(9876);
    expect(state?.pushed).toBe("partial");
  });

  it("returns null when there is nothing to keep", () => {
    const plan = planMirrorDelivery({
      text: "done",
      settled: true,
      state: null,
      now: t0,
    });
    expect(startedState(1, plan)).toBeNull();
  });
});

describe("shouldFinalizeStream", () => {
  it("completes the message in place when the answer is already on screen", () => {
    // Posting it again is what a user sees as the same answer twice.
    expect(shouldFinalizeStream(streaming(), false)).toBe(true);
  });

  it("never finalizes a fallback status line into the streamed answer", () => {
    // "Run produced no text output" is not the streamed text; editing it in
    // would replace the answer with an unrelated notice.
    expect(shouldFinalizeStream(streaming(), true)).toBe(false);
  });

  it("sends fresh when no Telegram message was ever created", () => {
    // The over-the-limit case: streaming was skipped on purpose.
    expect(
      shouldFinalizeStream(streaming({ messageId: 0, pushed: "" }), false),
    ).toBe(false);
  });

  it("sends fresh when nothing was streamed at all", () => {
    expect(shouldFinalizeStream(null, false)).toBe(false);
  });
});
