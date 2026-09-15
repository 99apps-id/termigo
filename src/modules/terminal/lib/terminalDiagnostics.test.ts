import { describe, expect, it } from "vitest";
import { TerminalDiagnostics } from "./terminalDiagnostics";

describe("TerminalDiagnostics", () => {
  it("logs entries and caps at max", () => {
    const diag = new TerminalDiagnostics();
    for (let i = 0; i < 500; i++) {
      diag.error(`err ${i}`);
    }
    expect(diag.getEntries().length).toBe(500);
    expect(diag.getEntries()[0].message).toBe("err 0");
    expect(diag.getEntries()[diag.getEntries().length - 1].message).toBe(
      "err 499",
    );
  });

  it("clears entries", () => {
    const diag = new TerminalDiagnostics();
    diag.info("hello");
    diag.clear();
    expect(diag.getEntries().length).toBe(0);
  });
});
