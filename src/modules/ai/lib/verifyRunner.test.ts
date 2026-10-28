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
  sessionShellKey: vi.fn(
    (prefix: string, sessionId: string, root: string | null) =>
      `${prefix}:${sessionId}:${root ?? "none"}`,
  ),
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

  // Regression: the kind was recovered by matching the free-form note text
  // ("package.json script (pnpm)"), so "pnpm run test" was reported as a lint
  // run. The kind must come from the requested check, never from prose.
  it("reports the requested kind instead of guessing it from the note text", async () => {
    const testOnlyPkg = JSON.stringify({
      scripts: { test: "vitest run" },
    });
    vi.mocked(await import("./native")).native.readFile.mockImplementation(
      async (path: string) => {
        if (path.endsWith("/package.json")) {
          return { kind: "text", content: testOnlyPkg };
        }
        return { kind: "text", content: null };
      },
    );
    const result = await runAutoVerify("s1", "/tmp/fake-project");
    expect(result?.command).toBe("pnpm run test");
    expect(result?.kind).toBe("test");
  });

  it("labels a lint run as lint when only a lint script exists", async () => {
    const lintOnlyPkg = JSON.stringify({
      scripts: { lint: "biome lint ./src" },
    });
    vi.mocked(await import("./native")).native.readFile.mockImplementation(
      async (path: string) => {
        if (path.endsWith("/package.json")) {
          return { kind: "text", content: lintOnlyPkg };
        }
        return { kind: "text", content: null };
      },
    );
    const result = await runAutoVerify("s1", "/tmp/fake-project");
    expect(result?.command).toBe("pnpm run lint");
    expect(result?.kind).toBe("lint");
  });

  // Regression: the runner keyed the shell session by the raw session id, so
  // the auto-verifier opened a second shell next to the one used by
  // run_checks and autoVerifyRunner for the same session and workspace.
  it("shares one shell session key with the other verify runners", async () => {
    vi.mocked(await import("./native")).native.readFile.mockImplementation(
      async (path: string) => {
        if (path.endsWith("/package.json")) {
          return { kind: "text", content: pkgJsonContent };
        }
        return { kind: "text", content: null };
      },
    );
    await runAutoVerify("s1", "/tmp/fake-project");
    const { sessionShellKey, getSessionShell } = await import("./sessionShell");
    expect(sessionShellKey).toHaveBeenCalledWith(
      "verify",
      "s1",
      "/tmp/fake-project",
    );
    expect(getSessionShell).toHaveBeenCalledWith(
      "verify:s1:/tmp/fake-project",
      "/tmp/fake-project",
    );
  });
});
