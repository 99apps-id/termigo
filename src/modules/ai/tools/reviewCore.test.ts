import { describe, expect, it, vi } from "vitest";
import { buildReviewPrompt, reviewDiffWithRetry } from "./reviewCore";

describe("buildReviewPrompt", () => {
  it("embeds the diff and asks the reviewer to open files anyway", () => {
    const p = buildReviewPrompt("hello diff", false);
    expect(p).toContain("```diff\nhello diff\n```");
    expect(p).toContain("read_file");
    expect(p).not.toContain("previous pass");
  });

  it("mandates inspection on the hard retry pass", () => {
    const p = buildReviewPrompt("d", true);
    expect(p).toContain("previous pass made no tool calls");
    expect(p).toContain("MUST open the changed files");
  });
});

describe("reviewDiffWithRetry", () => {
  it("accepts the first pass when it actually inspected", async () => {
    const run = vi.fn(async () => ({ summary: "LGTM" }));
    const r = await reviewDiffWithRetry("diff", run);
    expect(r).toEqual({ summary: "LGTM" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries once when the first pass inspected nothing", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ summary: "Looks good.", inconclusive: true })
      .mockResolvedValueOnce({ summary: "[MUST] - real finding" });
    const r = await reviewDiffWithRetry("diff", run);
    expect(r).toEqual({ summary: "[MUST] - real finding", retried: true });
    expect(run).toHaveBeenCalledTimes(2);
    // The retry carries the harder instruction.
    expect(run.mock.calls[1][0]).toContain("MUST open the changed files");
  });

  it("reports an error, not a fake verdict, after two empty passes", async () => {
    const run = vi.fn(async () => ({
      summary: "Looks good.",
      inconclusive: true,
    }));
    const r = await reviewDiffWithRetry("diff", run);
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.error).toContain("inconclusive");
  });

  it("gives the inspection retry a longer budget than the first pass", async () => {
    const timeouts: number[] = [];
    const run = vi.fn(async (_p: string, t: number) => {
      timeouts.push(t);
      return { summary: "", inconclusive: true };
    });
    await reviewDiffWithRetry("diff", run);
    expect(timeouts[1]).toBeGreaterThan(timeouts[0]);
  });
});
