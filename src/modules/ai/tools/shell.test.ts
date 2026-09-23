import { describe, expect, it, vi } from "vitest";
import {
  buildShellTools,
  normalizeShellCommand,
  resolveCommandTimeout,
  screenCommand,
  truncateCommandOutput,
  UNCLOSED_QUOTE_SENTINEL,
  unwrapPowershellCommand,
  workspaceSessionKey,
} from "./shell";
import type { ToolContext } from "./context";

vi.mock("@/modules/ssh/bridge", () => ({
  sshExec: vi.fn(),
}));

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({
      enforcePentestScope: false,
      pentestScope: [],
      autoApproveInScopeScans: false,
    }),
  },
}));

function sshCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    getSessionId: () => "session",
    getRemoteSession: () => ({ sessionId: 7, cwd: "/srv/app" }),
    clearRemoteSession: () => {},
    ...overrides,
  } as unknown as ToolContext;
}

describe("truncateCommandOutput", () => {
  it("keeps output untouched when within maxChars", () => {
    const text = "hello world\nline 2";
    const res = truncateCommandOutput(text, 100);
    expect(res.truncated).toBe(false);
    expect(res.text).toBe(text);
  });

  it("truncates long multi-line output preserving head and tail", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}: detailed output log entry here`);
    const fullText = lines.join("\n");
    const res = truncateCommandOutput(fullText, 500, 5, 5);

    expect(res.truncated).toBe(true);
    expect(res.text).toContain("Line 1:");
    expect(res.text).toContain("Line 5:");
    expect(res.text).toContain("Line 100:");
    expect(res.text).toContain("... [Output truncated:");
    expect(res.text.length).toBeLessThan(fullText.length);
  });

  it("truncates long single-line output cleanly", () => {
    const singleLine = "A".repeat(1000);
    const res = truncateCommandOutput(singleLine, 200);

    expect(res.truncated).toBe(true);
    expect(res.text).toContain("... [Output truncated: 800 characters omitted] ...");
    expect(res.text.startsWith("AAAAA")).toBe(true);
    expect(res.text.endsWith("AAAAA")).toBe(true);
  });
});

describe("unwrapPowershellCommand", () => {
  it("unwraps powershell -NoProfile -Command with double quotes", () => {
    const input =
      'powershell -NoProfile -Command "$c = Get-Content C:/project/filmov/src/store/useEditorStore.ts; $c[500..720] -join [Environment]::NewLine"';
    expect(unwrapPowershellCommand(input)).toBe(
      "$c = Get-Content C:/project/filmov/src/store/useEditorStore.ts; $c[500..720] -join [Environment]::NewLine",
    );
  });

  it("unwraps pwsh -Command with single quotes", () => {
    const input = "pwsh -Command 'Get-Process | Select-Object -First 5'";
    expect(unwrapPowershellCommand(input)).toBe("Get-Process | Select-Object -First 5");
  });

  it("unwraps script blocks in curly braces", () => {
    const input = "powershell.exe -NoProfile -Command { Get-Service wuauserv }";
    expect(unwrapPowershellCommand(input)).toBe("Get-Service wuauserv");
  });

  it("unescapes double quotes inside double-quoted commands", () => {
    const input = 'powershell -Command "Write-Host \\"termigo\\""';
    expect(unwrapPowershellCommand(input)).toBe('Write-Host "termigo"');
  });

  it("leaves standard commands untouched", () => {
    expect(unwrapPowershellCommand("pnpm test")).toBe("pnpm test");
    expect(unwrapPowershellCommand("git status")).toBe("git status");
    expect(unwrapPowershellCommand("Get-Content file.txt")).toBe("Get-Content file.txt");
  });
});

describe("workspaceSessionKey", () => {
  it("isolates shells for different working directories within the same session", () => {
    const rootKey = workspaceSessionKey("sess-1", "/workspace/repo");
    const worktreeKey = workspaceSessionKey(
      "sess-1",
      "/workspace/repo/.wt/subagent-1",
    );
    expect(rootKey).not.toBe(worktreeKey);
    expect(worktreeKey).toContain(".wt/subagent-1");
  });

  it("reuses shell key for matching working directory", () => {
    const key1 = workspaceSessionKey("sess-1", "/workspace/repo");
    const key2 = workspaceSessionKey("sess-1", "/workspace/repo");
    expect(key1).toBe(key2);
  });
});

describe("normalizeShellCommand", () => {
  it("converts newlines to semicolons outside quotes", () => {
    const input = "cd /project/dir\npnpm test";
    expect(normalizeShellCommand(input)).toBe("cd /project/dir ; pnpm test");
  });

  it("handles CRLF newlines", () => {
    const input = "git add .\r\ngit commit -m 'feat: something'\r\ngit push";
    expect(normalizeShellCommand(input)).toBe(
      "git add . ; git commit -m 'feat: something' ; git push",
    );
  });

  it("converts tabs to spaces outside quotes", () => {
    const input = "echo\thello\tworld";
    expect(normalizeShellCommand(input)).toBe("echo hello world");
  });

  it("does not insert extra semicolons when lines end with && or ;", () => {
    const input = "cd /dir &&\npnpm build";
    expect(normalizeShellCommand(input)).toBe("cd /dir && pnpm build");
  });

  it("marks an unclosed quote with the sentinel", () => {
    expect(normalizeShellCommand('echo "hello')).toContain(
      UNCLOSED_QUOTE_SENTINEL,
    );
    expect(normalizeShellCommand("echo 'hello")).toContain(
      UNCLOSED_QUOTE_SENTINEL,
    );
  });

  it("leaves balanced quotes alone", () => {
    expect(normalizeShellCommand('echo "hello"')).toBe('echo "hello"');
  });
});

describe("screenCommand", () => {
  it("refuses a command carrying the unclosed-quote sentinel", () => {
    const res = screenCommand(normalizeShellCommand('echo "hello'));
    expect(res.ok).toBe(false);
  });

  it("does not refuse a balanced command that merely mentions the sentinel", () => {
    const res = screenCommand('echo "[termigo: unclosed quote in command]"');
    expect(res.ok).toBe(true);
  });
});

describe("bash_run ssh fallback", () => {
  it("does not run a mutating command locally when ssh drops", async () => {
    const { sshExec } = await import("@/modules/ssh/bridge");
    vi.mocked(sshExec).mockRejectedValueOnce(new Error("no ssh session"));
    const { native } = await import("../lib/native");
    const run = vi
      .spyOn(native, "shellSessionRun")
      .mockResolvedValue({ stdout: "", stderr: "", exit_code: 0 });
    try {
      let cleared = false;
      const tools = buildShellTools(
        sshCtx({ clearRemoteSession: () => { cleared = true; } }),
      );
      const exec = tools.bash_run.execute;
      if (!exec) throw new Error("bash_run execute missing");
      // biome-ignore lint/suspicious/noExplicitAny: empty exec ctx is enough for the harness
      const emptyOpts = {} as any;
      const res = (await exec(
        { command: "rm -rf build", timeout_secs: 5 },
        emptyOpts,
      )) as { error?: string };
      expect(cleared).toBe(true);
      expect(res.error).toMatch(/not run locally/);
      expect(run).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });

  it("still falls through for inspect-only commands", async () => {
    const { sshExec } = await import("@/modules/ssh/bridge");
    vi.mocked(sshExec).mockRejectedValueOnce(new Error("no ssh session"));
    const { native } = await import("../lib/native");
    const open = vi
      .spyOn(native, "shellSessionOpen")
      .mockResolvedValue(41);
    const run = vi.spyOn(native, "shellSessionRun").mockResolvedValue({
      stdout: "a\n",
      stderr: "",
      exit_code: 0,
    });
    try {
      const tools = buildShellTools(sshCtx());
      const exec = tools.bash_run.execute;
      if (!exec) throw new Error("bash_run execute missing");
      // biome-ignore lint/suspicious/noExplicitAny: empty exec ctx is enough for the harness
      const emptyOpts = {} as any;
      const res = (await exec(
        { command: "ls", timeout_secs: 5 },
        emptyOpts,
      )) as { stdout?: string };
      expect(run).toHaveBeenCalled();
      expect(res.stdout).toBe("a\n");
    } finally {
      open.mockRestore();
      run.mockRestore();
    }
  });
});

describe("checkShellCommand root wipes", () => {
  it.each(["/", "/*", "//", "///", "/*/*", "///*"])(
    "refuses rm -rf %s",
    (target) => {
      expect(screenCommand(`rm -rf ${target}`).ok).toBe(false);
    },
  );

  it("still allows rm -rf on an ordinary path", () => {
    expect(screenCommand("rm -rf /tmp/scratch").ok).toBe(true);
  });
});

describe("resolveCommandTimeout", () => {
  // The field failure: a model-chosen `timeout_secs: 10` on `pnpm install`
  // killed pnpm mid-mutation and left node_modules half-removed — after which
  // every "is biome installed?" check answered no, truthfully, until a full
  // reinstall. An install cannot finish in 10s, so the request is always a
  // mistake; the floor makes the mistake impossible.
  it("floors package-manager mutations at 300s regardless of the request", () => {
    expect(resolveCommandTimeout("pnpm install", 10)).toBe(300);
    expect(resolveCommandTimeout("pnpm i", 5)).toBe(300);
    expect(resolveCommandTimeout("npm install", 10)).toBe(300);
    expect(resolveCommandTimeout("npm ci", 60)).toBe(300);
    expect(resolveCommandTimeout("yarn add lodash", 15)).toBe(300);
    expect(resolveCommandTimeout("bun install", 1)).toBe(300);
    expect(resolveCommandTimeout("pip install requests", 20)).toBe(300);
    expect(resolveCommandTimeout("uv sync", 30)).toBe(300);
    expect(resolveCommandTimeout("poetry install", 30)).toBe(300);
    // A bare `pnpm`/`yarn` IS an install.
    expect(resolveCommandTimeout("pnpm", 10)).toBe(300);
    expect(resolveCommandTimeout("yarn", 10)).toBe(300);
  });

  it("keeps a longer explicit request for installs", () => {
    expect(resolveCommandTimeout("pnpm install", 600)).toBe(600);
  });

  it("defaults installs to 300s when nothing is requested", () => {
    expect(resolveCommandTimeout("pnpm install")).toBe(300);
    expect(resolveCommandTimeout("pnpm add -D vitest")).toBe(300);
  });

  it("leaves ordinary commands on the requested or default timeout", () => {
    expect(resolveCommandTimeout("git status", 10)).toBe(10);
    expect(resolveCommandTimeout("vitest run", 45)).toBe(45);
    expect(resolveCommandTimeout("biome lint src")).toBe(120);
    expect(resolveCommandTimeout("ls -la")).toBe(120);
  });

  it("keeps the slow-start defaults for cargo/clone/rustc", () => {
    expect(resolveCommandTimeout("cargo build")).toBe(300);
    expect(resolveCommandTimeout("git clone https://x/y")).toBe(300);
    expect(resolveCommandTimeout("rustc main.rs")).toBe(300);
    // Explicit requests still win for these - killing a build is harmless.
    expect(resolveCommandTimeout("cargo build", 60)).toBe(60);
  });

  it("does not mistake read-only pnpm subcommands for mutations", () => {
    expect(resolveCommandTimeout("pnpm list", 10)).toBe(10);
    expect(resolveCommandTimeout("pnpm exec biome lint", 20)).toBe(20);
    expect(resolveCommandTimeout("pnpm run test", 60)).toBe(60);
    expect(resolveCommandTimeout("npm ls", 15)).toBe(15);
  });
});
