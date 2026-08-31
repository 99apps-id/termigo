import { describe, expect, it } from "vitest";
import { makeSummary, POST_EXECUTE_CONFIRM_TOOLS } from "./postExecuteConfirm";

describe("postExecuteConfirm (BatikCode PendingResultConfirmation parity)", () => {
  it("marks the mutating tools that pause for confirmation", () => {
    expect(POST_EXECUTE_CONFIRM_TOOLS.has("write_file")).toBe(true);
    expect(POST_EXECUTE_CONFIRM_TOOLS.has("edit")).toBe(true);
    expect(POST_EXECUTE_CONFIRM_TOOLS.has("multi_edit")).toBe(true);
    expect(POST_EXECUTE_CONFIRM_TOOLS.has("bash_run")).toBe(true);
    // Read-only tools must never pause.
    expect(POST_EXECUTE_CONFIRM_TOOLS.has("read_file")).toBe(false);
    expect(POST_EXECUTE_CONFIRM_TOOLS.has("grep")).toBe(false);
  });

  it("builds a path summary for file tools", () => {
    expect(makeSummary("write_file", { path: "/p/a.ts" }, ["/p/a.ts"])).toBe(
      "Wrote /p/a.ts",
    );
    expect(makeSummary("edit", {}, ["/p/b.ts"])).toBe("Edited /p/b.ts");
    expect(makeSummary("multi_edit", { path: "/p/c.ts" }, ["/p/c.ts"])).toBe(
      "Edited /p/c.ts",
    );
  });

  it("falls back to the raw path arg when the result has none", () => {
    expect(makeSummary("write_file", { path: "src/x.ts" }, [])).toBe(
      "Wrote src/x.ts",
    );
    expect(makeSummary("edit", { path: "src/x.ts" }, [])).toBe(
      "Edited src/x.ts",
    );
  });

  it("summarizes bash_run by its command", () => {
    expect(makeSummary("bash_run", { command: "npm run build" }, [])).toBe(
      "Ran command: npm run build",
    );
  });
});
