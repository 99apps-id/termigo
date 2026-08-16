import { describe, expect, it } from "vitest";
import {
  formatQueue,
  parseApprovalTarget,
  resolveTarget,
  summarizeInput,
  type PendingApproval,
} from "./approvalQueue";

const entry = (id: string, requester = "agent"): PendingApproval => ({
  id,
  requester,
  toolName: "bash_run",
  summary: "which openclaw",
  requestedAt: 0,
});

describe("parseApprovalTarget", () => {
  it("reads a bare command as the only one waiting", () => {
    expect(parseApprovalTarget("")).toEqual({ kind: "only" });
    expect(parseApprovalTarget("   ")).toEqual({ kind: "only" });
  });

  it("reads a number as a position", () => {
    expect(parseApprovalTarget("2")).toEqual({ kind: "index", index: 2 });
  });

  it("reads all, in either language", () => {
    expect(parseApprovalTarget("all")).toEqual({ kind: "all" });
    expect(parseApprovalTarget("semua")).toEqual({ kind: "all" });
    expect(parseApprovalTarget("ALL")).toEqual({ kind: "all" });
  });

  it("rejects what it cannot read rather than guessing", () => {
    expect(parseApprovalTarget("first")).toBeNull();
    expect(parseApprovalTarget("0")).toBeNull();
    expect(parseApprovalTarget("-1")).toBeNull();
  });
});

describe("resolveTarget", () => {
  it("selects every entry for all", () => {
    const q = [entry("a"), entry("b")];
    expect(resolveTarget(q, { kind: "all" })).toEqual({ ids: ["a", "b"] });
  });

  it("counts from one, the way the listing is printed", () => {
    const q = [entry("a"), entry("b")];
    expect(resolveTarget(q, { kind: "index", index: 2 })).toEqual({ ids: ["b"] });
  });

  it("says how many there are when the position does not exist", () => {
    const out = resolveTarget([entry("a")], { kind: "index", index: 4 });
    expect(out).toHaveProperty("error");
    expect((out as { error: string }).error).toMatch(/no #4.*1 waiting/);
  });

  // The point of the whole design: answering the wrong agent is not something
  // the user can take back, so a bare command must not pick for them.
  it("refuses a bare command while several are waiting", () => {
    const out = resolveTarget([entry("a"), entry("b")], { kind: "only" });
    expect(out).toHaveProperty("error");
    expect((out as { error: string }).error).toMatch(/say which/);
  });

  it("accepts a bare command when only one is waiting", () => {
    expect(resolveTarget([entry("a")], { kind: "only" })).toEqual({ ids: ["a"] });
  });

  it("says so when nothing is waiting at all", () => {
    expect(resolveTarget([], { kind: "all" })).toEqual({
      error: "nothing is waiting for approval",
    });
  });
});

describe("formatQueue", () => {
  it("numbers entries the way the command addresses them", () => {
    const lines = formatQueue([entry("a", "agent"), entry("b", "builder #1")]);
    expect(lines.split("\n")[0]).toMatch(/^1\. agent - bash_run/);
    expect(lines.split("\n")[1]).toMatch(/^2\. builder #1 - bash_run/);
  });

  it("says plainly when there is nothing", () => {
    expect(formatQueue([])).toBe("nothing is waiting for approval");
  });
});

describe("summarizeInput", () => {
  it("prefers the field that identifies the action", () => {
    expect(summarizeInput({ command: "rm -rf dist", cwd: "/w" })).toBe("rm -rf dist");
    expect(summarizeInput({ content: "x", path: "src/a.ts" })).toBe("src/a.ts");
  });

  it("collapses whitespace so one entry stays one line", () => {
    expect(summarizeInput({ command: "a\n  b\tc" })).toBe("a b c");
  });

  it("truncates rather than flooding the listing", () => {
    const out = summarizeInput({ command: "x".repeat(200) });
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back to the field names when nothing identifies it", () => {
    expect(summarizeInput({ alpha: 1, beta: 2 })).toBe("alpha, beta");
  });

  it("handles what a tool might actually pass", () => {
    expect(summarizeInput(null)).toBe("");
    expect(summarizeInput(42)).toBe("");
    expect(summarizeInput("plain")).toBe("plain");
  });
});
