import { describe, expect, it } from "vitest";
import { stopCopy } from "./ChatNotices";

describe("stopCopy", () => {
  it("returns step-cap copy with next round budget", () => {
    const copy = stopCopy("step-cap", 1);
    expect(copy.text).toContain("Paused after");
    expect(copy.text).toContain("steps");
    expect(copy.action).toContain("Continue");
  });

  it("returns tool-repetition copy", () => {
    const copy = stopCopy("tool-repetition", 1);
    expect(copy.text).toContain("same tool ran three times");
    expect(copy.action).toBe("Continue anyway");
    expect(copy.hint).toBeDefined();
  });

  it("returns idle-read-loop copy", () => {
    const copy = stopCopy("idle-read-loop", 1);
    expect(copy.text).toContain("reading the same file sections");
    expect(copy.action).toBe("Continue anyway");
    expect(copy.hint).toBeDefined();
  });


  it("returns user stopped copy for stopped, steered, and aborted", () => {
    expect(stopCopy("stopped", 1).text).toBe("You stopped this run.");
    expect(stopCopy("steered", 1).text).toBe("You stopped this run.");
    expect(stopCopy("aborted", 1).text).toBe("You stopped this run.");
  });

  it("returns interrupted copy", () => {
    const copy = stopCopy("interrupted", 1);
    expect(copy.text).toContain("interrupted");
    expect(copy.action).toBe("Resume");
  });

  it("returns tool-only-loop and tool-error copy", () => {
    const loopCopy = stopCopy("tool-only-loop", 1);
    expect(loopCopy.text).toContain("asked for tools repeatedly");
    expect(loopCopy.action).toBe("Continue anyway");

    const errCopy = stopCopy("tool-error", 1);
    expect(errCopy.text).toContain("every tool call failed");
    expect(errCopy.action).toBe("Continue anyway");
  });

  it("returns text-repetition and no-progress copy", () => {
    const textCopy = stopCopy("text-repetition", 1);
    expect(textCopy.text).toContain("repeating the same text");
    expect(textCopy.action).toBe("Continue anyway");

    const noProgCopy = stopCopy("no-progress", 1);
    expect(noProgCopy.text).toContain("made no tool call");
    expect(noProgCopy.action).toBe("Continue anyway");
  });
});
