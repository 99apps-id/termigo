import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bodyToPayload,
  bytesToBase64,
  fetchFailure,
} from "./proxyFetch";

const bytes = (...n: number[]) => new Uint8Array(n);

describe("base64 round trip", () => {
  it("survives every byte value", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(base64ToBytes(bytesToBase64(all))).toEqual(all);
  });

  it("handles the empty case", () => {
    expect(bytesToBase64(bytes())).toBe("");
    expect(base64ToBytes("")).toEqual(bytes());
  });

  it("handles each padding length", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const b = new Uint8Array(n).fill(0xff);
      expect(base64ToBytes(bytesToBase64(b))).toEqual(b);
    }
  });

  // The encoder walks the array in 0x8000 windows to stay under the argument
  // limit; a payload spanning several windows is what proves the seam.
  it("survives a payload larger than the chunking window", () => {
    const big = new Uint8Array(0x8000 * 3 + 12345);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 256;
    const round = base64ToBytes(bytesToBase64(big));
    expect(round.length).toBe(big.length);
    expect(round).toEqual(big);
  });

  it("agrees with the platform decoder", () => {
    const b = bytes(0xde, 0xad, 0xbe, 0xef);
    expect(bytesToBase64(b)).toBe("3q2+7w==");
    expect(base64ToBytes("3q2+7w==")).toEqual(b);
  });
});

describe("bodyToPayload", () => {
  it("sends a string as text, with no encoding step", async () => {
    const json = JSON.stringify({ messages: [{ role: "user", text: "hi" }] });
    expect(await bodyToPayload(json)).toEqual({ kind: "text", text: json });
  });

  it("keeps non-ASCII text intact", async () => {
    const text = "hasil pencarian: berhasil — 日本語 🎉";
    const payload = await bodyToPayload(text);
    expect(payload).toEqual({ kind: "text", text });
  });

  it("treats a missing body as nothing to send", async () => {
    expect(await bodyToPayload(null)).toBeUndefined();
    expect(await bodyToPayload(undefined)).toBeUndefined();
  });

  it("sends an empty string as text, not as nothing", async () => {
    expect(await bodyToPayload("")).toEqual({ kind: "text", text: "" });
  });

  it("base64s an ArrayBuffer", async () => {
    const buf = bytes(1, 2, 3, 250).buffer;
    const payload = await bodyToPayload(buf);
    expect(payload?.kind).toBe("base64");
    if (payload?.kind !== "base64") throw new Error("unreachable");
    expect(base64ToBytes(payload.data)).toEqual(bytes(1, 2, 3, 250));
  });

  it("base64s a typed-array view without dragging in the whole buffer", async () => {
    const backing = bytes(9, 9, 1, 2, 3, 9, 9);
    const view = backing.subarray(2, 5);
    const payload = await bodyToPayload(view);
    if (payload?.kind !== "base64") throw new Error("expected base64");
    expect(base64ToBytes(payload.data)).toEqual(bytes(1, 2, 3));
  });

  it("base64s a Blob", async () => {
    const payload = await bodyToPayload(new Blob([bytes(7, 8, 9)]));
    if (payload?.kind !== "base64") throw new Error("expected base64");
    expect(base64ToBytes(payload.data)).toEqual(bytes(7, 8, 9));
  });

  it("reads URLSearchParams back as text", async () => {
    const payload = await bodyToPayload(new URLSearchParams({ a: "1", b: "2" }));
    expect(payload).toEqual({ kind: "text", text: "a=1&b=2" });
  });
});

// The point of the change: what actually crosses the IPC boundary.
describe("transport cost", () => {
  it("sends a JSON body at its own size rather than tripling it", async () => {
    const json = JSON.stringify({ pad: "x".repeat(200_000) });
    const payload = await bodyToPayload(json);
    const wire = JSON.stringify(payload);
    const asNumberArray = JSON.stringify(
      Array.from(new TextEncoder().encode(json)),
    );

    // Text costs the payload plus the JSON envelope; the old shape cost about
    // three bytes per byte.
    expect(wire.length).toBeLessThan(json.length * 1.1);
    expect(asNumberArray.length).toBeGreaterThan(json.length * 2.5);
  });
});

// The AI SDK retries a network failure twice, but only after provider-utils
// rewrites it as a retryable APICallError — and that rewrite fires only for a
// TypeError named like a fetch failure that carries a cause. Reject any other
// way and the SDK's own resilience silently does not apply.
describe("fetchFailure", () => {
  const FETCH_FAILED_ERROR_MESSAGES = ["fetch failed", "failed to fetch"];
  // `Error.cause` is ES2022; this project's lib is ES2020.
  const causeOf = (e: TypeError) => (e as TypeError & { cause?: unknown }).cause;

  it("is a TypeError, which is the first thing the SDK checks", () => {
    expect(fetchFailure("boom")).toBeInstanceOf(TypeError);
  });

  it("is named the way the SDK matches on", () => {
    const err = fetchFailure("boom");
    expect(FETCH_FAILED_ERROR_MESSAGES).toContain(err.message.toLowerCase());
  });

  it("carries a cause, without which the SDK gives up on the rewrite", () => {
    const err = fetchFailure("error sending request for url (https://x/y)");
    expect(causeOf(err)).toBeInstanceOf(Error);
    expect((causeOf(err) as Error).message).toContain("error sending request");
  });

  it("keeps the detail rather than trading it for retryability", () => {
    const detail = "tcp connect error: connection reset (os error 10054)";
    expect((causeOf(fetchFailure(detail)) as Error).message).toBe(detail);
  });
});
