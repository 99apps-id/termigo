import { describe, expect, it } from "vitest";
import {
  EMPTY_QUEUE,
  enqueue,
  flush,
  flushOne,
  flushShouldHold,
  isBusy,
  isResumeParts,
  prepend,
  previewOf,
  RESUME_PROMPT,
  remove,
  type SteerMessage,
  type SteerPart,
  submitAction,
} from "./steer";

function text(t: string): SteerPart {
  return { type: "text", text: t };
}
function image(name: string): SteerPart {
  return { type: "file", mediaType: "image/png", filename: name };
}
function msg(...parts: SteerPart[]): SteerMessage {
  return { preview: previewOf(parts), parts };
}

describe("isBusy", () => {
  // Two vocabularies reach this: the SDK's chat status and the app's own agent
  // status. Missing either would let a message race the run it meant to adjust.
  it("accepts both status vocabularies", () => {
    for (const s of [
      "submitted",
      "thinking",
      "streaming",
      "awaiting-approval",
    ]) {
      expect(isBusy(s)).toBe(true);
    }
  });

  it("is false once the run settles, however it ended", () => {
    for (const s of ["ready", "idle", "error"]) expect(isBusy(s)).toBe(false);
  });
});

describe("submitAction", () => {
  it("sends straight away when nothing is running", () => {
    expect(submitAction("ready", true)).toBe("send");
  });

  it("queues instead of racing an in-flight run", () => {
    expect(submitAction("streaming", true)).toBe("queue");
    expect(submitAction("thinking", true)).toBe("queue");
    expect(submitAction("awaiting-approval", true)).toBe("queue");
  });

  it("ignores an empty composer in either state", () => {
    expect(submitAction("ready", false)).toBe("ignore");
    expect(submitAction("streaming", false)).toBe("ignore");
  });
});

describe("flushShouldHold", () => {
  // The flush path must obey the same liveness rule as submitAction: sending a
  // queued task while the SDK's auto-continue round is in flight races it, and
  // two concurrent requests on one Chat double the transcript every cycle.
  it("holds while a round is in flight", () => {
    expect(flushShouldHold("submitted")).toBe(true);
    expect(flushShouldHold("streaming")).toBe(true);
  });

  it("lets the flush through once the run has settled", () => {
    expect(flushShouldHold("ready")).toBe(false);
    expect(flushShouldHold("idle")).toBe(false);
    expect(flushShouldHold("error")).toBe(false);
  });

  it("proceeds when there is no live chat for the session", () => {
    expect(flushShouldHold(null)).toBe(false);
  });
});

describe("queue", () => {
  it("keeps messages in the order they were typed", () => {
    const q = enqueue(
      enqueue(EMPTY_QUEUE, msg(text("first"))),
      msg(text("second")),
    );
    expect(q.pending.map((m) => m.preview)).toEqual(["first", "second"]);
  });

  it("restores a failed delivery before newer queued messages", () => {
    const q = enqueue(EMPTY_QUEUE, msg(text("newer")));
    expect(
      prepend(q, msg(text("failed"))).pending.map((m) => m.preview),
    ).toEqual(["failed", "newer"]);
  });

  it("refuses a message with no parts", () => {
    expect(enqueue(EMPTY_QUEUE, { preview: "", parts: [] })).toBe(EMPTY_QUEUE);
  });

  // The reason the queue holds parts rather than strings: an image attached
  // mid-run must survive the wait instead of being silently dropped.
  it("carries attachments through the wait", () => {
    const q = enqueue(
      EMPTY_QUEUE,
      msg(text("look at this"), image("shot.png")),
    );
    const out = flush(q);
    expect(out?.parts).toEqual([
      { type: "text", text: "look at this" },
      { type: "file", mediaType: "image/png", filename: "shot.png" },
    ]);
  });

  // Sending each queued message as its own run would have the agent answer the
  // first without ever seeing the rest.
  it("flushes everything pending as one turn, in order", () => {
    const q = enqueue(
      enqueue(EMPTY_QUEUE, msg(text("use pnpm"))),
      msg(text("skip tests")),
    );
    expect(flush(q)?.parts).toEqual([
      { type: "text", text: "use pnpm" },
      { type: "text", text: "skip tests" },
    ]);
  });

  it("empties itself on flush so nothing sends twice", () => {
    const q = enqueue(EMPTY_QUEUE, msg(text("once")));
    const out = flush(q);
    expect(out?.next).toEqual(EMPTY_QUEUE);
    expect(flush(out?.next ?? EMPTY_QUEUE)).toBeNull();
  });

  it("flushOne delivers only the oldest task, leaving the rest queued", () => {
    const q = enqueue(
      enqueue(EMPTY_QUEUE, msg(text("task one"))),
      msg(text("task two")),
    );
    const out = flushOne(q);
    expect(out?.parts).toEqual([{ type: "text", text: "task one" }]);
    // The second task stays queued for the next settle.
    expect(out?.next.pending.map((m) => m.preview)).toEqual(["task two"]);
    // Draining again yields the second, then empties.
    const out2 = flushOne(out?.next ?? EMPTY_QUEUE);
    expect(out2?.parts).toEqual([{ type: "text", text: "task two" }]);
    expect(out2?.next).toEqual(EMPTY_QUEUE);
    expect(flushOne(out2?.next ?? EMPTY_QUEUE)).toBeNull();
  });

  it("reports nothing to flush on an empty queue", () => {
    expect(flush(EMPTY_QUEUE)).toBeNull();
  });

  it("cancels one queued message without disturbing the others", () => {
    const q = [msg(text("a")), msg(text("b")), msg(text("c"))].reduce(
      enqueue,
      EMPTY_QUEUE,
    );
    expect(remove(q, 1).pending.map((m) => m.preview)).toEqual(["a", "c"]);
  });

  it("ignores a cancel for an index that is not there", () => {
    const q = enqueue(EMPTY_QUEUE, msg(text("a")));
    expect(remove(q, 5)).toBe(q);
    expect(remove(q, -1)).toBe(q);
  });
});

describe("isResumeParts", () => {
  it("recognises the continuation prompt the resume paths inject", () => {
    expect(isResumeParts([text(RESUME_PROMPT)])).toBe(true);
  });

  it("treats a fresh user task as not a resume", () => {
    expect(isResumeParts([text("fix the build")])).toBe(false);
  });

  it("treats a resume bundled with anything else as a new task", () => {
    expect(isResumeParts([text(RESUME_PROMPT), image("shot.png")])).toBe(false);
  });

  it("is false for an empty send", () => {
    expect(isResumeParts([])).toBe(false);
  });
});

describe("previewOf", () => {
  it("collapses whitespace so the chip stays one line", () => {
    expect(previewOf([text("two\n\nlines   here")])).toBe("two lines here");
  });

  it("truncates rather than overflowing the chip", () => {
    expect(previewOf([text("x".repeat(200))])).toHaveLength(80);
  });

  it("describes an attachment-only message instead of showing nothing", () => {
    expect(previewOf([image("a.png"), image("b.png")])).toBe("2 attachment(s)");
  });
});
