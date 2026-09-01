import { describe, expect, it } from "vitest";
import {
  candidateUrls,
  defaultDevPort,
  detectDevCommand,
  devPort,
  devScriptCommand,
  portFromCommand,
  sameDevCommand,
} from "./devServer";

describe("devScriptCommand", () => {
  it("picks dev, then start/serve/develop/dev:web", () => {
    const pkg = JSON.stringify({
      scripts: { build: "tsc", dev: "vite", start: "node ." },
    });
    expect(devScriptCommand(pkg)).toEqual({ command: "vite", name: "dev" });
    expect(
      devScriptCommand(JSON.stringify({ scripts: { start: "next start" } })),
    ).toEqual({ command: "next start", name: "start" });
  });

  it("returns null for no manifest or no dev script", () => {
    expect(devScriptCommand(null)).toBeNull();
    expect(devScriptCommand("not json")).toBeNull();
    expect(
      devScriptCommand(JSON.stringify({ scripts: { build: "tsc" } })),
    ).toBeNull();
  });
});

describe("portFromCommand", () => {
  it("parses --port / -p / --port= / PORT= / :port forms", () => {
    expect(portFromCommand("vite --port 5173")).toBe(5173);
    expect(portFromCommand("vite -p 3001")).toBe(3001);
    expect(portFromCommand("vite --port=8080")).toBe(8080);
    expect(portFromCommand("PORT=4000 next dev")).toBe(4000);
    expect(portFromCommand("ng serve --port 4200")).toBe(4200);
    expect(portFromCommand("mix run --port 4000")).toBe(4000);
  });

  it("returns null when the command names no port", () => {
    expect(portFromCommand("vite")).toBeNull();
    expect(portFromCommand("pnpm dev")).toBeNull();
  });
});

describe("defaultDevPort / devPort", () => {
  it("defaults per framework", () => {
    expect(defaultDevPort("vite")).toBe(5173);
    expect(defaultDevPort("next dev")).toBe(3000);
    expect(defaultDevPort("webpack serve")).toBe(8080);
    expect(defaultDevPort("cargo run")).toBe(8000);
    expect(defaultDevPort("go run main.go")).toBe(8080);
    expect(defaultDevPort("something-unknown")).toBe(3000);
  });

  it("an explicit port wins over the framework default", () => {
    expect(devPort("vite --port 9000")).toBe(9000);
    expect(devPort("vite")).toBe(5173);
  });
});

describe("candidateUrls", () => {
  it("probes localhost, 127.0.0.1 and [::1]", () => {
    expect(candidateUrls(5173)).toEqual([
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://[::1]:5173",
    ]);
  });
});

describe("detectDevCommand", () => {
  it("resolves command + script + port hint", () => {
    const d = detectDevCommand({
      pkgJson: JSON.stringify({ scripts: { dev: "vite --port 5173" } }),
    });
    expect(d).toEqual({
      command: "vite --port 5173",
      script: "dev",
      portHint: 5173,
    });
  });

  it("uses the framework default port when the command has none", () => {
    const d = detectDevCommand({
      pkgJson: JSON.stringify({ scripts: { dev: "next dev" } }),
    });
    expect(d?.portHint).toBe(3000);
  });

  it("returns null when nothing declares a dev script", () => {
    expect(detectDevCommand({ pkgJson: null })).toBeNull();
  });
});

describe("sameDevCommand", () => {
  it("matches identical and substring commands, ignoring case/space", () => {
    expect(sameDevCommand("pnpm dev", "pnpm dev")).toBe(true);
    expect(sameDevCommand("pnpm  dev", "pnpm dev")).toBe(true);
    expect(sameDevCommand("vite --port 5173", "vite --port 5173")).toBe(true);
    expect(sameDevCommand("vite", "vite --port 5173")).toBe(true);
    expect(sameDevCommand("pnpm dev", "cargo run")).toBe(false);
  });
});
