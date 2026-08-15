import { describe, expect, it } from "vitest";
import {
  EMPTY_QUEUE,
  enqueue,
  flush,
  isBusy,
  previewOf,
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
    for (const s of ["submitted", "thinking", "streaming"]) {
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
  });

  it("ignores an empty composer in either state", () => {
    expect(submitAction("ready", false)).toBe("ignore");
    expect(submitAction("streaming", false)).toBe("ignore");
  });
});

describe("queue", () => {
  it("keeps messages in the order they were typed", () => {
    const q = enqueue(enqueue(EMPTY_QUEUE, msg(text("first"))), msg(text("second")));
    expect(q.pending.map((m) => m.preview)).toEqual(["first", "second"]);
  });

  it("refuses a message with no parts", () => {
    expect(enqueue(EMPTY_QUEUE, { preview: "", parts: [] })).toBe(EMPTY_QUEUE);
  });

  // The reason the queue holds parts rather than strings: an image attached
  // mid-run must survive the wait instead of being silently dropped.
  it("carries attachments through the wait", () => {
    const q = enqueue(EMPTY_QUEUE, msg(text("look at this"), image("shot.png")));
    const out = flush(q);
    expect(out?.parts).toEqual([
      { type: "text", text: "look at this" },
      { type: "file", mediaType: "image/png", filename: "shot.png" },
    ]);
  });

  // Sending each queued message as its own run would have the agent answer the
  // first without ever seeing the rest.
  it("flushes everything pending as one turn, in order", () => {
    const q = enqueue(enqueue(EMPTY_QUEUE, msg(text("use pnpm"))), msg(text("skip tests")));
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

  it("reports nothing to flush on an empty queue", () => {
    expect(flush(EMPTY_QUEUE)).toBeNull();
  });

  it("cancels one queued message without disturbing the others", () => {
    const q = [msg(text("a")), msg(text("b")), msg(text("c"))].reduce(enqueue, EMPTY_QUEUE);
    expect(remove(q, 1).pending.map((m) => m.preview)).toEqual(["a", "c"]);
  });

  it("ignores a cancel for an index that is not there", () => {
    const q = enqueue(EMPTY_QUEUE, msg(text("a")));
    expect(remove(q, 5)).toBe(q);
    expect(remove(q, -1)).toBe(q);
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
