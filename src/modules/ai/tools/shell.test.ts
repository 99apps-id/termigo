import { describe, expect, it } from "vitest";
import {
  normalizeShellCommand,
  screenCommand,
  truncateCommandOutput,
  UNCLOSED_QUOTE_SENTINEL,
  unwrapPowershellCommand,
  workspaceSessionKey,
} from "./shell";

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
      "/workspace/repo/.termigo/worktrees/subagent-1",
    );
    expect(rootKey).not.toBe(worktreeKey);
    expect(worktreeKey).toContain(".termigo/worktrees/subagent-1");
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
