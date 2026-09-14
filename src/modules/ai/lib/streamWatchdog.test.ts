import { describe, expect, it } from "vitest";
import { watchdogDirective } from "./streamWatchdog";

describe("watchdogDirective", () => {
  // The regression that caused a real 20-minute hang. A reasoning model streams
  // `reasoning-delta` chunks before it answers; treating one as "the response
  // arrived" cleared the only watchdog, so when the provider then went silent
  // nothing was left to abort the run.
  it("treats a reasoning delta as the model still producing", () => {
    expect(watchdogDirective("reasoning-delta")).toBe("rearm");
  });

  it("restarts the clock on real content", () => {
    expect(watchdogDirective("text-delta")).toBe("rearm");
    expect(watchdogDirective("source")).toBe("rearm");
  });

  it("keeps watching while the model assembles a tool call", () => {
    expect(watchdogDirective("tool-input-start")).toBe("rearm");
    expect(watchdogDirective("tool-input-delta")).toBe("rearm");
  });

  // A tool runs without sending anything, and a long one is normal, so silence
  // during execution must not be mistaken for a stalled provider.
  it("stops watching once a tool is about to execute", () => {
    expect(watchdogDirective("tool-call")).toBe("disarm");
  });

  it("resumes watching once the tool result is back", () => {
    expect(watchdogDirective("tool-result")).toBe("rearm");
  });

  it("has no opinion on chunks it does not recognise", () => {
    expect(watchdogDirective("start")).toBe("ignore");
    expect(watchdogDirective("finish")).toBe("ignore");
    expect(watchdogDirective("error")).toBe("ignore");
    expect(watchdogDirective("something-new")).toBe("ignore");
  });
});
