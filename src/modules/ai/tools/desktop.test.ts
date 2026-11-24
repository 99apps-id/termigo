import { describe, expect, it } from "vitest";
import {
  psQuote,
  sanitizeAppTarget,
  sanitizeKeyCombo,
  shellQuote,
} from "./desktop";

describe("desktop tool helpers", () => {
  it("quotes POSIX and PowerShell arguments safely", () => {
    expect(shellQuote("my 'file'.blend")).toBe(`'my '\\''file'\\''.blend'`);
    expect(psQuote("my 'file'.blend")).toBe("'my ''file''.blend'");
  });

  it("rejects newline/null injection in app targets and key combos", () => {
    expect(sanitizeAppTarget("blender")).toBe("blender");
    expect(sanitizeAppTarget("blender\nrm -rf /")).toBeNull();
    expect(sanitizeAppTarget("   ")).toBeNull();

    expect(sanitizeKeyCombo("ctrl+s")).toBe("ctrl+s");
    expect(sanitizeKeyCombo("Return")).toBe("Return");
    expect(sanitizeKeyCombo("ctrl+s; whoami")).toBeNull();
  });
});
