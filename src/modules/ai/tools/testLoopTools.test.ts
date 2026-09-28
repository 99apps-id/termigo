import { describe, expect, it } from "vitest";
import { focusTestFile } from "./testLoopTools";

describe("focusTestFile", () => {
  it("scopes vitest to the file", () => {
    const r = focusTestFile("pnpm exec vitest run", "src/modules/ai/tools/a.test.ts");
    expect(r.command).toContain("src/modules/ai/tools/a.test.ts");
    expect(r.note).toContain("focused");
  });

  it("adds --watchAll=false and --passWithNoTests for jest so an unmatched file is not a failure", () => {
    const r = focusTestFile("jest", "/repo/src/a.test.ts");
    expect(r.command).toBe("jest /repo/src/a.test.ts --watchAll=false --passWithNoTests");
  });

  it("adds --run for vitest when not already running in single-run mode", () => {
    const r1 = focusTestFile("vitest", "src/foo.test.ts");
    expect(r1.command).toBe("vitest src/foo.test.ts --run");

    const r2 = focusTestFile("npx vitest", "src/foo.test.ts");
    expect(r2.command).toBe("npx vitest src/foo.test.ts --run");
  });

  it("passes the file straight to pytest", () => {
    const r = focusTestFile("python -m pytest", "tests/test_a.py");
    expect(r.command).toBe("python -m pytest tests/test_a.py");
  });

  it("scopes go test to the file's package directory", () => {
    const r = focusTestFile("go test ./...", "/repo/internal/worker/util_test.go");
    expect(r.command).toBe("go test /repo/internal/worker");
    expect(r.note).toContain("package");
  });

  it("leaves cargo test untouched and explains why", () => {
    const r = focusTestFile("cargo test", "src/lib.rs");
    expect(r.command).toBe("cargo test");
    expect(r.note).toContain("cargo");
  });

  it("leaves an unknown runner untouched with an honest note", () => {
    const r = focusTestFile("make test", "tests/a.rb");
    expect(r.command).toBe("make test");
    expect(r.note).toContain("could not focus");
  });

  it("scopes pnpm run test and pnpm test to the file", () => {
    const r1 = focusTestFile("pnpm run test", "src/modules/terminal/lib/unparkRepaint.test.ts");
    expect(r1.command).toBe("pnpm run test src/modules/terminal/lib/unparkRepaint.test.ts");
    expect(r1.note).toContain("focused");

    const r2 = focusTestFile("pnpm test", "src/a.test.ts");
    expect(r2.command).toBe("pnpm test src/a.test.ts");
  });

  it("scopes npm test with double dash separator", () => {
    const r = focusTestFile("npm test", "src/a.test.ts");
    expect(r.command).toBe("npm test -- src/a.test.ts");
  });

  it("normalizes Windows backslashes in test file paths", () => {
    const r = focusTestFile("pnpm test", "src\\modules\\terminal\\test.ts");
    expect(r.command).toBe("pnpm test src/modules/terminal/test.ts");
  });

  it("returns the empty base unchanged", () => {
    const r = focusTestFile("   ", "a.test.ts");
    expect(r.command).toBe("");
  });
});