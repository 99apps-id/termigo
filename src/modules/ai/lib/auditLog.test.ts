import { describe, expect, it, vi } from "vitest";
import {
  auditToolEvent,
  buildAuditEntry,
  detailOfResult,
  isoDate,
  isRefusal,
  statusOfResult,
  summarize,
} from "./auditLog";

vi.mock("./native", () => ({
  native: {
    auditAppend: vi.fn().mockRejectedValue(new Error("disk full")),
  },
}));

describe("summarize", () => {
  it("redacts credential-shaped values", () => {
    const out = summarize({
      command:
        'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrst" https://x',
    });
    expect(out).toContain("<REDACTED");
    expect(out).not.toContain("sk-abcdefghijklmnopqrst");
  });

  it("bounds a long argument blob", () => {
    const out = summarize({ content: "x".repeat(5000) });
    expect(out.length).toBeLessThanOrEqual(2003);
    expect(out.endsWith("...")).toBe(true);
  });

  it("survives a value it cannot serialize", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(summarize(cyclic)).toBe("[unserializable]");
  });
});

describe("status of a tool result", () => {
  it("treats a returned error field as an error", () => {
    expect(statusOfResult({ error: "ENOENT" })).toBe("error");
    expect(detailOfResult({ error: "ENOENT" })).toBe("ENOENT");
  });

  it("tells a wall refusal apart from a failure", () => {
    const refused = {
      error: 'Refused: "/proj/.termigo/hooks.json" decides what runs later',
    };
    expect(statusOfResult(refused)).toBe("refused");
    expect(isRefusal(new Error("Refused: nope"))).toBe(true);
  });

  it("does not invent an error for a normal result", () => {
    expect(statusOfResult({ stdout: "ok" })).toBe("ok");
    expect(statusOfResult("done")).toBe("ok");
    expect(detailOfResult({ stdout: "ok" })).toBeUndefined();
  });
});

describe("buildAuditEntry", () => {
  it("keeps the pinned timestamp and defaults the status", () => {
    const entry = buildAuditEntry({
      tool: "bash_run",
      args: { command: "ls" },
      at: 123,
    });
    expect(entry).toEqual({
      at: 123,
      tool: "bash_run",
      status: "ok",
      args: '{"command":"ls"}',
    });
  });

  it("adds a detail field only when there is one", () => {
    expect(buildAuditEntry({ tool: "x", at: 1 })).not.toHaveProperty("detail");
    expect(buildAuditEntry({ tool: "x", detail: "boom", at: 1 }).detail).toBe(
      "boom",
    );
  });
});

describe("isoDate", () => {
  it("names the file by the event's own day", () => {
    expect(isoDate(Date.UTC(2026, 8, 27, 23, 30))).toBe("2026-09-27");
  });
});

describe("auditToolEvent", () => {
  it("never throws when the host cannot write", async () => {
    expect(() => auditToolEvent({ tool: "bash_run" })).not.toThrow();
    await Promise.resolve();
  });
});
