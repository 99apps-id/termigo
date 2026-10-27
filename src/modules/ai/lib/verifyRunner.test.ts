import { describe, expect, it, vi } from "vitest";
import { runAutoVerify } from "./verifyRunner";

const pkgJsonContent = JSON.stringify({
  scripts: { test: "vitest run", lint: "pnpm run lint" },
});

vi.mock("./native", () => {
  const readFile = vi.fn().mockImplementation(async (path: string) => {
    if (path.endsWith("/package.json")) {
      return { kind: "text" as const, content: pkgJsonContent };
    }
    return { kind: "text" as const, content: null };
  });
  return {
    native: {
      shellSessionOpen: vi.fn().mockResolvedValue("shell-1"),
      shellSessionRun: vi.fn().mockResolvedValue({
        stdout: "ok",
        stderr: "",
        exit_code: 0,
        timed_out: false,
        truncated: false,
      }),
      shellSessionClose: vi.fn().mockResolvedValue(undefined),
      readFile,
    },
  };
});

vi.mock("./sessionShell", () => ({
  getSessionShell: vi.fn().mockResolvedValue("shell-1"),
  sessionShellKey: vi.fn(),
}));

describe("verifyRunner", () => {
  it("returns null when no checker matches the workspace", async () => {
    vi.mocked(await import("./native")).native.readFile.mockResolvedValue({
      kind: "text",
      content: null,
    });
    const result = await runAutoVerify("s1", "/tmp/fake-project");
    expect(result).toBeNull();
  });

  it("runs discovered checkers and returns the first passing result", async () => {
    vi.mocked(await import("./native")).native.readFile.mockImplementation(
      async (path: string) => {
        if (path.endsWith("/package.json")) {
          return { kind: "text", content: pkgJsonContent };
        }
        return { kind: "text", content: null };
      },
    );
    const result = await runAutoVerify("s1", "/tmp/fake-project");
    expect(result?.command).toBe("pnpm run lint");
    expect(result?.exit_code).toBe(0);
    expect(result?.timed_out).toBe(false);
  });

  it("caps attempts at AUTO_VERIFY_MAX_ATTEMPTS", async () => {
    vi.mocked(await import("./native")).native.readFile.mockImplementation(
      async (path: string) => {
        if (path.endsWith("/package.json")) {
          return { kind: "text", content: pkgJsonContent };
        }
        return { kind: "text", content: null };
      },
    );
    const result = await runAutoVerify("s1", "/tmp/fake-project");
    expect(result?.command).toBe("pnpm run lint");
    expect(result?.exit_code).toBe(0);
  });
});
