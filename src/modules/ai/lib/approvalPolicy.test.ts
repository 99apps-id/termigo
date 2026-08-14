import { describe, expect, it } from "vitest";
import {
  APPROVAL_MODES,
  approvalTier,
  isAutoApproved,
  type ApprovalMode,
} from "./approvalPolicy";

const EDITS = ["write_file", "create_directory", "edit", "multi_edit"];
const EXEC = [
  "bash_run",
  "bash_background",
  "spawn_coding_agent",
  "send_to_agent",
];

describe("isAutoApproved", () => {
  it("asks for everything in the default mode", () => {
    for (const tool of [...EDITS, ...EXEC]) {
      expect(isAutoApproved(tool, "ask")).toBe(false);
    }
  });

  it("auto-approves edits but never commands in 'edits' mode", () => {
    for (const tool of EDITS) expect(isAutoApproved(tool, "edits")).toBe(true);
    for (const tool of EXEC) expect(isAutoApproved(tool, "edits")).toBe(false);
  });

  it("auto-approves everything in 'all' mode", () => {
    for (const tool of [...EDITS, ...EXEC]) {
      expect(isAutoApproved(tool, "all")).toBe(true);
    }
  });

  // A tool added later must not inherit a blanket allowance from a mode that
  // was reasoned about without it.
  it("treats an unknown tool as command-tier", () => {
    expect(isAutoApproved("some_future_tool", "edits")).toBe(false);
    expect(approvalTier("some_future_tool")).toBe("exec");
  });

  it("classifies the known tools", () => {
    for (const tool of EDITS) expect(approvalTier(tool)).toBe("edit");
    for (const tool of EXEC) expect(approvalTier(tool)).toBe("exec");
  });

  it("exposes exactly the three modes", () => {
    expect([...APPROVAL_MODES]).toEqual<ApprovalMode[]>(["ask", "edits", "all"]);
  });
});

// Deleting is the one file operation that does not ride along with
// "auto-approve edits": an edit changes bytes that can be read back, a delete
// of something untracked leaves nothing to read.
describe("delete is held back from the edit tier", () => {
  it("still asks when ordinary edits are delegated", () => {
    expect(isAutoApproved("delete_file", "edits")).toBe(false);
    expect(approvalTier("delete_file")).toBe("exec");
  });

  it("does not hold back the file operations that are recoverable", () => {
    for (const t of ["move_file", "copy_file", "replace_in_files"]) {
      expect(isAutoApproved(t, "edits")).toBe(true);
    }
  });

  // "Auto-approve all" says nothing waits, and it has to keep meaning that.
  it("obeys the mode that says nothing waits", () => {
    expect(isAutoApproved("delete_file", "all")).toBe(true);
  });

  it("asks in the default mode, like everything else", () => {
    expect(isAutoApproved("delete_file", "ask")).toBe(false);
  });
});
