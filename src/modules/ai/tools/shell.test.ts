import { describe, expect, it } from "vitest";
import { truncateCommandOutput, unwrapPowershellCommand } from "./shell";

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
