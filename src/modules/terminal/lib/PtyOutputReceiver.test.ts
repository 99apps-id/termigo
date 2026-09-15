import { describe, expect, it } from "vitest";
import { PtyOutputReceiver } from "./PtyOutputReceiver";

describe("PtyOutputReceiver", () => {
  it("reports the cumulative bytes consumed", () => {
    const receiver = new PtyOutputReceiver();
    expect(receiver.bytesConsumed).toBe(0);
    receiver.consume(64 * 1024);
    receiver.consume(32 * 1024);
    expect(receiver.bytesConsumed).toBe(96 * 1024);
  });

  it("ignores non-positive counts so a bad chunk cannot rewind the mark", () => {
    const receiver = new PtyOutputReceiver();
    receiver.consume(10);
    receiver.consume(0);
    receiver.consume(-5);
    expect(receiver.bytesConsumed).toBe(10);
  });
});
