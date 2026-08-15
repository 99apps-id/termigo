import { describe, expect, it } from "vitest";
import {
  formatMemory,
  isDuplicate,
  MAX_FACT_CHARS,
  MAX_FACTS,
  MAX_MEMORY_BYTES,
  memoryBlock,
  normalizeFact,
  parseMemory,
  prune,
  type MemoryEntry,
} from "./memory";

function entry(text: string, date = "2026-08-14"): MemoryEntry {
  return { date, text };
}

describe("parse and format", () => {
  it("round-trips entries through the file format", () => {
    const entries = [entry("Tests run with pnpm test."), entry("No npm here.")];
    expect(parseMemory(formatMemory(entries))).toEqual(entries);
  });

  // The file is meant to be hand-editable, so prose a user adds around the
  // list must not be mistaken for entries.
  it("ignores prose and headings that are not entries", () => {
    const parsed = parseMemory(
      [
        "# Termigo agent memory",
        "",
        "Some explanation the user wrote.",
        "- 2026-08-14 A real fact.",
        "- a bullet without a date",
        "",
      ].join("\n"),
    );
    expect(parsed).toEqual([entry("A real fact.")]);
  });

  it("keeps a fact on one line so it cannot corrupt the list", () => {
    expect(normalizeFact("multi\nline   fact")).toBe("multi line fact");
  });

  it("clips an overlong fact rather than storing an essay", () => {
    expect(normalizeFact("x".repeat(MAX_FACT_CHARS + 200))).toHaveLength(
      MAX_FACT_CHARS,
    );
  });
});

describe("duplicates", () => {
  it("matches regardless of case, since the agent restates facts", () => {
    const entries = [entry("Deploy uses pnpm tauri build.")];
    expect(isDuplicate(entries, "deploy uses PNPM tauri build.")).toBe(true);
    expect(isDuplicate(entries, "Deploy uses cargo.")).toBe(false);
  });
});

describe("prune", () => {
  it("keeps the newest entries once the count ceiling is passed", () => {
    const many = Array.from({ length: MAX_FACTS + 20 }, (_, i) =>
      entry(`fact ${i}`),
    );
    const kept = prune(many);
    expect(kept).toHaveLength(MAX_FACTS);
    expect(kept[kept.length - 1].text).toBe(`fact ${MAX_FACTS + 19}`);
    expect(kept[0].text).toBe("fact 20");
  });

  // Every entry is spent context on every request, so the byte ceiling has to
  // hold even when the count is legal.
  it("keeps the file under the byte ceiling even with few long entries", () => {
    const fat = Array.from({ length: 60 }, () => entry("y".repeat(400)));
    expect(formatMemory(fat).length).toBeGreaterThan(MAX_MEMORY_BYTES);
    expect(formatMemory(prune(fat)).length).toBeLessThanOrEqual(
      MAX_MEMORY_BYTES,
    );
  });

  it("never prunes down to nothing", () => {
    expect(prune([entry("z".repeat(MAX_FACT_CHARS))])).toHaveLength(1);
  });
});

describe("prompt block", () => {
  it("contributes nothing when no facts have been learned", () => {
    expect(memoryBlock([])).toBe("");
  });

  it("labels the source and marks the facts as context, not orders", () => {
    const block = memoryBlock([entry("Deploy uses pnpm tauri build.")]);
    expect(block).toContain(".termigo/memory.md");
    expect(block).toContain("Deploy uses pnpm tauri build.");
    // A stale memory must never outrank what the user is saying right now.
    expect(block.toLowerCase()).toContain("prefer what the user says now");
  });

  it("omits dates, which cost tokens without helping the model", () => {
    expect(memoryBlock([entry("A fact.", "2026-01-02")])).not.toContain(
      "2026-01-02",
    );
  });
});
