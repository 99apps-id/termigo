import type { Chat, UIMessage } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import { chatStreamOptions, STREAM_UI_THROTTLE_MS } from "./streamUiThrottle";

describe("STREAM_UI_THROTTLE_MS", () => {
  it("keeps the transcript off the per-token path without looking frozen", () => {
    // Zero is the failure this constant exists to prevent: the SDK disables
    // throttling when the wait is falsy, which is the per-token render that
    // starved the main thread for minutes at a time. A quarter second is the
    // other end - text that updates four times a second reads as stuttering.
    expect(STREAM_UI_THROTTLE_MS).toBeGreaterThan(0);
    expect(STREAM_UI_THROTTLE_MS).toBeLessThanOrEqual(250);
  });
});

describe("chatStreamOptions", () => {
  it("passes the chat through and applies the throttle", () => {
    const chat = { id: "session-1" } as unknown as Chat<UIMessage>;
    expect(chatStreamOptions(chat)).toEqual({
      chat,
      experimental_throttle: STREAM_UI_THROTTLE_MS,
    });
  });
});
