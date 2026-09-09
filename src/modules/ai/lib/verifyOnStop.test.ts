import { describe, expect, it } from "vitest";
import {
  buildVerifyNudge,
  isNonCodePath,
  isVerifyNudgeParts,
  MAX_VERIFY_NUDGES,
  newVerifyLedger,
  recordToolResult,
  VERIFY_NUDGE_PREFIX,
} from "./verifyOnStop";

describe("isNonCodePath", () => {
  it("treats docs and data files as non-code", () => {
    expect(isNonCodePath("README.md")).toBe(true);
    expect(isNonCodePath("docs/guide.markdown")).toBe(true);
    expect(isNonCodePath("notes.txt")).toBe(true);
    expect(isNonCodePath("data/export.csv")).toBe(true);
    expect(isNonCodePath("a/b/c.rst")).toBe(true);
    expect(isNonCodePath("CHANGELOG.MD")).toBe(true);
  });

  it("treats well-known prose filenames as non-code", () => {
    expect(isNonCodePath("LICENSE")).toBe(true);
    expect(isNonCodePath("docs/Notice")).toBe(true);
    expect(isNonCodePath("CODEOWNERS")).toBe(true);
  });

  it("treats source files as code", () => {
    expect(isNonCodePath("src/app.ts")).toBe(false);
    expect(isNonCodePath("src/app.tsx")).toBe(false);
    expect(isNonCodePath("main.py")).toBe(false);
    expect(isNonCodePath("cli/cmd/termigo/main.go")).toBe(false);
    expect(isNonCodePath("Dockerfile")).toBe(false);
    expect(isNonCodePath("src-tauri/Cargo.toml")).toBe(false);
  });

  it("handles Windows backslash paths", () => {
    expect(isNonCodePath("src\\modules\\ai\\lib\\agent.ts")).toBe(false);
    expect(isNonCodePath("docs\\README.md")).toBe(true);
  });

  it("treats dotfiles as code (no extension to match)", () => {
    // ".gitignore" has no extension after the leading dot, and is not in the
    // prose filename set, so it falls through as code. Acceptable: a nudge
    // for a dotfile edit is harmless.
    expect(isNonCodePath(".gitignore")).toBe(false);
  });
});

describe("recordToolResult", () => {
  it("starts empty and unverified", () => {
    const l = newVerifyLedger();
    expect(l.changedCodePaths).toEqual([]);
    expect(l.verifiedAfterLastEdit).toBe(false);
  });

  it("records code paths from edit tools", () => {
    let l = newVerifyLedger();
    l = recordToolResult(l, "edit", { ok: true, path: "src/a.ts" });
    l = recordToolResult(l, "write_file", { ok: true, path: "src/b.tsx" });
    l = recordToolResult(l, "multi_edit", {
      ok: true,
      path: "src/c.py",
      replacements: 2,
    });
    expect(l.changedCodePaths).toEqual(["src/a.ts", "src/b.tsx", "src/c.py"]);
  });

  it("dedupes repeated edits to the same path", () => {
    let l = newVerifyLedger();
    l = recordToolResult(l, "edit", { ok: true, path: "src/a.ts" });
    l = recordToolResult(l, "edit", { ok: true, path: "src/a.ts" });
    expect(l.changedCodePaths).toEqual(["src/a.ts"]);
  });

  it("ignores non-code paths", () => {
    let l = newVerifyLedger();
    l = recordToolResult(l, "edit", { ok: true, path: "README.md" });
    l = recordToolResult(l, "write_file", { ok: true, path: "LICENSE" });
    expect(l.changedCodePaths).toEqual([]);
  });

  it("ignores failed and reverted results", () => {
    let l = newVerifyLedger();
    l = recordToolResult(l, "edit", { error: "no match", path: "src/a.ts" });
    l = recordToolResult(l, "write_file", {
      ok: true,
      path: "src/b.ts",
      reverted_by_user: true,
    });
    expect(l.changedCodePaths).toEqual([]);
  });

  it("ignores results without a path or non-object output", () => {
    let l = newVerifyLedger();
    l = recordToolResult(l, "edit", { ok: true });
    l = recordToolResult(l, "edit", null);
    l = recordToolResult(l, "edit", "oops");
    expect(l.changedCodePaths).toEqual([]);
  });

  it("an edit resets verification unless auto-verify lint passed on it", () => {
    let l = newVerifyLedger();
    l = recordToolResult(l, "edit", { ok: true, path: "src/a.ts" });
    l = recordToolResult(l, "run_checks", { exit_code: 0, timed_out: false });
    expect(l.verifiedAfterLastEdit).toBe(true);
    // A later edit invalidates the earlier evidence.
    l = recordToolResult(l, "edit", { ok: true, path: "src/b.ts" });
    expect(l.verifiedAfterLastEdit).toBe(false);
    // But an edit carrying a passing folded verification counts as fresh.
    l = recordToolResult(l, "edit", {
      ok: true,
      path: "src/c.ts",
      verification: { formatted: false, lint: { ran: true, passed: true } },
    });
    expect(l.verifiedAfterLastEdit).toBe(true);
    // A folded lint that ran but failed does not count.
    l = recordToolResult(l, "edit", {
      ok: true,
      path: "src/d.ts",
      verification: { formatted: false, lint: { ran: true, passed: false } },
    });
    expect(l.verifiedAfterLastEdit).toBe(false);
  });

  it("run_checks exit 0 marks verified; nonzero or timeout does not", () => {
    let l = newVerifyLedger();
    l = recordToolResult(l, "run_checks", { exit_code: 1, timed_out: false });
    expect(l.verifiedAfterLastEdit).toBe(false);
    l = recordToolResult(l, "run_checks", { exit_code: 0, timed_out: true });
    expect(l.verifiedAfterLastEdit).toBe(false);
    l = recordToolResult(l, "run_checks", { exit_code: 0, timed_out: false });
    expect(l.verifiedAfterLastEdit).toBe(true);
  });

  it("bash_run only counts check-like commands exiting 0", () => {
    let l = newVerifyLedger();
    l = recordToolResult(l, "bash_run", {
      command: "ls -la",
      exit_code: 0,
      timed_out: false,
    });
    expect(l.verifiedAfterLastEdit).toBe(false);
    l = recordToolResult(l, "bash_run", {
      command: "pnpm test",
      exit_code: 1,
      timed_out: false,
    });
    expect(l.verifiedAfterLastEdit).toBe(false);
    l = recordToolResult(l, "bash_run", {
      command: "pnpm vitest run",
      exit_code: 0,
      timed_out: true,
    });
    expect(l.verifiedAfterLastEdit).toBe(false);
    l = recordToolResult(l, "bash_run", {
      command: "pnpm vitest run",
      exit_code: 0,
      timed_out: false,
    });
    expect(l.verifiedAfterLastEdit).toBe(true);
  });

  it("bash_run recognises common check verbs", () => {
    const verbs = [
      "cargo clippy --all-targets",
      "npm run lint",
      "go vet ./...",
      "make build",
      "pytest -q",
      "ruff check .",
      "biome check src",
      "pnpm check-types",
      "gradle test",
    ];
    for (const command of verbs) {
      const l = recordToolResult(newVerifyLedger(), "bash_run", {
        command,
        exit_code: 0,
        timed_out: false,
      });
      expect(l.verifiedAfterLastEdit, command).toBe(true);
    }
  });

  it("bash_wait exited 0 marks verified", () => {
    let l = newVerifyLedger();
    l = recordToolResult(l, "bash_wait", {
      handle: "h1",
      exited: false,
      exit_code: null,
      timed_out: true,
    });
    expect(l.verifiedAfterLastEdit).toBe(false);
    l = recordToolResult(l, "bash_wait", {
      handle: "h1",
      exited: true,
      exit_code: 2,
      timed_out: false,
    });
    expect(l.verifiedAfterLastEdit).toBe(false);
    l = recordToolResult(l, "bash_wait", {
      handle: "h1",
      exited: true,
      exit_code: 0,
      timed_out: false,
    });
    expect(l.verifiedAfterLastEdit).toBe(true);
  });

  it("ignores unrelated tools", () => {
    let l = newVerifyLedger();
    l = recordToolResult(l, "read_file", { path: "src/a.ts", content: "x" });
    l = recordToolResult(l, "bash_background", {
      handle: "h1",
      command: "pnpm dev",
      ok: true,
    });
    expect(l.changedCodePaths).toEqual([]);
    expect(l.verifiedAfterLastEdit).toBe(false);
  });
});

describe("buildVerifyNudge", () => {
  it("returns null when there are no code paths", () => {
    expect(buildVerifyNudge([], 0)).toBeNull();
    expect(buildVerifyNudge(["README.md", "LICENSE"], 0)).toBeNull();
  });

  it("returns null when the attempt budget is spent", () => {
    expect(buildVerifyNudge(["src/a.ts"], MAX_VERIFY_NUDGES)).toBeNull();
    expect(buildVerifyNudge(["src/a.ts"], MAX_VERIFY_NUDGES + 1)).toBeNull();
  });

  it("builds a nudge for unverified code edits", () => {
    const nudge = buildVerifyNudge(["src/a.ts", "docs/README.md"], 0);
    expect(nudge).not.toBeNull();
    expect(nudge?.startsWith(VERIFY_NUDGE_PREFIX)).toBe(true);
    expect(nudge).toContain("src/a.ts");
    // Prose paths are filtered out of the listing.
    expect(nudge).not.toContain("README.md");
    expect(nudge).toContain("run_checks");
  });

  it("caps the listed paths and reports the remainder", () => {
    const paths = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
    const nudge = buildVerifyNudge(paths, 0);
    expect(nudge).toContain("src/f7.ts");
    expect(nudge).not.toContain("src/f8.ts");
    expect(nudge).toContain("... and 4 more");
  });
});

describe("isVerifyNudgeParts", () => {
  it("recognises a single nudge text part", () => {
    const nudge = buildVerifyNudge(["src/a.ts"], 0);
    expect(nudge).not.toBeNull();
    expect(isVerifyNudgeParts([{ type: "text", text: nudge }])).toBe(true);
  });

  it("rejects other parts", () => {
    expect(isVerifyNudgeParts([])).toBe(false);
    expect(isVerifyNudgeParts([{ type: "text", text: "hello" }])).toBe(false);
    const nudge = buildVerifyNudge(["src/a.ts"], 0) ?? "";
    expect(
      isVerifyNudgeParts([
        { type: "text", text: nudge },
        { type: "text", text: "more" },
      ]),
    ).toBe(false);
    expect(isVerifyNudgeParts([{ type: "file", text: nudge }])).toBe(false);
    expect(isVerifyNudgeParts([{ type: "text" }])).toBe(false);
  });
});
