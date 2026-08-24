import { describe, expect, it } from "vitest";
import { detectCheckCommand, formatCommand } from "./verify";

describe("detectCheckCommand", () => {
  it("prefers a package.json script and records the package manager", () => {
    const pkgJson = JSON.stringify({
      packageManager: "pnpm@11.9.0",
      scripts: { test: "vitest run", lint: "biome lint ./src" },
    });
    expect(detectCheckCommand("test", { pkgJson, cargo: null, goMod: null, pyproject: null })).toEqual({
      command: "vitest run",
      note: "package.json script (pnpm)",
    });
    expect(detectCheckCommand("lint", { pkgJson, cargo: null, goMod: null, pyproject: null })).toEqual({
      command: "biome lint ./src",
      note: "package.json script (pnpm)",
    });
  });

  it("falls back to cargo for a Rust project without package.json", () => {
    const cargo = "[package]\nname = 'x'\n";
    expect(detectCheckCommand("test", { pkgJson: null, cargo, goMod: null, pyproject: null })).toEqual({
      command: "cargo test",
      note: "Cargo.toml",
    });
    expect(detectCheckCommand("lint", { pkgJson: null, cargo, goMod: null, pyproject: null })).toEqual({
      command: "cargo clippy --all-targets -- -D warnings",
      note: "Cargo.toml (clippy)",
    });
  });

  it("falls back to go for a Go project", () => {
    const goMod = "module example.com/x\n";
    expect(detectCheckCommand("test", { pkgJson: null, cargo: null, goMod, pyproject: null })).toEqual({
      command: "go test ./...",
      note: "go.mod",
    });
  });

  it("falls back to python for a Python project", () => {
    const pyproject = "[tool.pytest.ini_options]\n";
    expect(detectCheckCommand("test", { pkgJson: null, cargo: null, goMod: null, pyproject })).toEqual({
      command: "python -m pytest",
      note: "pyproject.toml (pytest)",
    });
  });

  it("returns a helpful error when nothing is detected", () => {
    const result = detectCheckCommand("test", {
      pkgJson: null,
      cargo: null,
      goMod: null,
      pyproject: null,
    });
    expect(result.command).toBeNull();
    expect(result.note).toContain("pass `command` explicitly");
  });
});

describe("formatCommand", () => {
  it("picks the formatter per language", () => {
    expect(formatCommand(["src/main.rs"]).note).toBe("rustfmt");
    expect(formatCommand(["main.go"]).note).toBe("gofmt");
    expect(formatCommand(["app.py"]).note).toBe("ruff format");
    expect(formatCommand(["src/App.tsx"]).note).toBe("biome format (pnpm)");
  });

  it("shell-quotes paths with spaces", () => {
    const { command } = formatCommand(["src/my file.ts", "x.tsx"]);
    expect(command).toContain("'src/my file.ts'");
  });
});
