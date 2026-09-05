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

  it("returns cost-cap copy", () => {
    const copy = stopCopy("cost-cap", 1);
    expect(copy.text).toContain("reached the maximum cost budget");
    expect(copy.action).toBe("Continue anyway");
  });
});
