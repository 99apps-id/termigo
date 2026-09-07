import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn().mockResolvedValue("/mock/home"),
}));

import {
  forgetFact,
  formatMemory,
  isDuplicate,
  MAX_FACT_CHARS,
  MAX_FACTS,
  MAX_MEMORY_BYTES,
  memoryBlock,
  normalizeFact,
  parseMemory,
  prune,
  rememberFact,
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

describe("gotchas, global memory, and relevance in memoryBlock", () => {
  it("partitions gotchas into their own section", () => {
    const block = memoryBlock([
      entry("Database runs on port 5432."),
      entry("[GOTCHA] Never run drop database on staging."),
      entry("Always avoid modifying generated types."),
    ]);
    expect(block).toContain("AVOIDED MISTAKES & TRAPS (GOTCHAS)");
    expect(block).toContain("[GOTCHA] Never run drop database on staging.");
    expect(block).toContain("Always avoid modifying generated types.");
    expect(block).toContain("PROJECT CONVENTIONS & FACTS");
    expect(block).toContain("Database runs on port 5432.");
  });

  it("includes global conventions when globalEntries are present", () => {
    const block = memoryBlock(
      [entry("Project fact.")],
      [
        entry("[GOTCHA] Global trap to avoid."),
        entry("User prefers tabs over spaces."),
      ],
    );
    expect(block).toContain("GLOBAL CONVENTIONS (~/.termigo/memory.md)");
    expect(block).toContain("Global gotchas and avoided traps:");
    expect(block).toContain("[GOTCHA] Global trap to avoid.");
    expect(block).toContain("Global preferences:");
    expect(block).toContain("User prefers tabs over spaces.");
  });

  it("ranks general facts by keyword match against query while keeping gotchas", () => {
    const facts = [
      entry("Fact about auth token verification."),
      entry("Fact about payment stripe webhook."),
      entry("Fact about database postgres migrations."),
      entry("[GOTCHA] Do not restart redis without backup."),
    ];

    const block = memoryBlock(facts, [], "How does stripe webhook auth work?");
    // Gotchas are always kept
    expect(block).toContain("[GOTCHA] Do not restart redis without backup.");
    // High relevance facts appear
    expect(block).toContain("Fact about auth token verification.");
    expect(block).toContain("Fact about payment stripe webhook.");
  });
});

describe("rememberFact and forgetFact with scopes", () => {
  it("remembers facts into project memory", async () => {
    const { native } = await import("./native");
    const writtenFiles = new Map<string, string>();
    vi.spyOn(native, "readFile").mockImplementation(async (p) => {
      const c = writtenFiles.get(p);
      if (c) return { kind: "text", content: c, size: c.length };
      return { kind: "text", content: "", size: 0 };
    });
    vi.spyOn(native, "writeFile").mockImplementation(async (p, content) => {
      writtenFiles.set(p, content);
    });
    vi.spyOn(native, "createDir").mockResolvedValue(undefined as unknown as void);

    const outcome = await rememberFact(
      "/workspace",
      "Internal imports must use @/ alias.",
      "2026-08-15",
      "project",
    );
    expect(outcome).toEqual({
      stored: true,
      total: 1,
      scope: "project",
    });
    expect(writtenFiles.get("/workspace/.termigo/memory.md")).toContain(
      "Internal imports must use @/ alias.",
    );

    // Duplicate check
    const dup = await rememberFact(
      "/workspace",
      "Internal imports must use @/ alias.",
      "2026-08-15",
      "project",
    );
    expect(dup).toEqual({ stored: false, reason: "already remembered" });

    // Forget fact
    const forgot = await forgetFact(
      "/workspace",
      "Internal imports must use @/ alias.",
      "project",
    );
    expect(forgot.removed).toBe(true);
    expect(forgot.total).toBe(0);
  });

  it("remembers and forgets facts in global memory", async () => {
    const { native } = await import("./native");
    const writtenFiles = new Map<string, string>();
    vi.spyOn(native, "readFile").mockImplementation(async (p) => {
      const c = writtenFiles.get(p);
      if (c) return { kind: "text", content: c, size: c.length };
      return { kind: "text", content: "", size: 0 };
    });
    vi.spyOn(native, "writeFile").mockImplementation(async (p, content) => {
      writtenFiles.set(p, content);
    });
    vi.spyOn(native, "createDir").mockResolvedValue(undefined as unknown as void);

    const outcome = await rememberFact(
      null,
      "Always use TypeScript strict mode across all projects.",
      "2026-08-15",
      "global",
    );
    expect(outcome.stored).toBe(true);
    if (outcome.stored) {
      expect(outcome.scope).toBe("global");
      expect(outcome.total).toBe(1);
    }

    const dup = await rememberFact(
      null,
      "Always use TypeScript strict mode across all projects.",
      "2026-08-15",
      "global",
    );
    expect(dup).toEqual({
      stored: false,
      reason: "already remembered globally",
    });

    const forgot = await forgetFact(
      null,
      "Always use TypeScript strict mode across all projects.",
      "global",
    );
    expect(forgot.removed).toBe(true);
    expect(forgot.total).toBe(0);
  });
});

