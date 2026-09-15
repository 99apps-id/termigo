import { describe, it, expect } from "vitest";
import { PtyOutputReceiver } from "./PtyOutputReceiver";

const BUFFER_BUDGET = 2 * 1024 * 1024;

describe("PtyOutputReceiver", () => {
  it("cumulative acknowledgements are idempotent and order-independent", () => {
    const credit = new PtyOutputReceiver();
    credit.recordSent(64 * 1024);
    credit.recordSent(32 * 1024);
    expect(credit.canSend).toBe(false);
    expect(credit.inFlightBytes).toBe(96 * 1024);
    expect(credit.inFlightChunks).toBe(2);
    credit.acknowledge(64 * 1024);
    expect(credit.inFlightBytes).toBe(32 * 1024);
    expect(credit.inFlightChunks).toBe(1);
    credit.recordSent(10);
    expect(credit.inFlightBytes).toBe(32 * 1024 + 10);
    credit.acknowledge(64 * 1024);
    expect(credit.inFlightChunks).toBe(2);
    credit.acknowledge(96 * 1024 + 10);
    expect(credit.inFlightBytes).toBe(0);
    expect(credit.inFlightChunks).toBe(0);
  });

  it("invalid credit cannot release bytes or messages", () => {
    const credit = new PtyOutputReceiver();
    credit.recordSent(100);
    credit.recordSent(200);
    for (const bytes of [1, 101, 299, 301, Number.MAX_SAFE_INTEGER]) {
      expect(() => credit.acknowledge(bytes)).toThrow();
      expect(credit.inFlightBytes).toBe(300);
      expect(credit.inFlightChunks).toBe(2);
    }
    credit.acknowledge(300);
    expect(credit.inFlightBytes).toBe(0);
    expect(credit.inFlightChunks).toBe(0);
  });

  it("credit remains bounded over long streams and lost replies", () => {
    const credit = new PtyOutputReceiver();
    let parsed = 0;
    for (let i = 0; i < 1_000; i++) {
      credit.recordSent(BUFFER_BUDGET / 2);
      credit.recordSent(BUFFER_BUDGET / 2);
      expect(credit.inFlightBytes).toBe(BUFFER_BUDGET);
      parsed += BUFFER_BUDGET;
      credit.acknowledge(parsed);
      expect(credit.inFlightBytes).toBe(0);
      expect(credit.inFlightChunks).toBe(0);
      credit.acknowledge(parsed);
      expect(credit.inFlightBytes).toBe(0);
      expect(credit.inFlightChunks).toBe(0);
    }
  });
});
