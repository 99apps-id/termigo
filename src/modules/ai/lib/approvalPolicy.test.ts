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

// The safety layer's shape is "inside this workspace", and every file tool
// refuses paths outside it. A command on a remote host has no equivalent
// boundary, so this is the one place an approval mode may not speak for the
// user.
describe("commands on a remote host always ask", () => {
  it("asks even under the mode that says nothing waits", () => {
    expect(isAutoApproved("bash_run", "all", { onRemoteHost: true })).toBe(false);
    expect(isAutoApproved("bash_background", "all", { onRemoteHost: true })).toBe(
      false,
    );
  });

  it("leaves local commands under the mode the user chose", () => {
    expect(isAutoApproved("bash_run", "all")).toBe(true);
    expect(isAutoApproved("bash_run", "all", { onRemoteHost: false })).toBe(true);
    expect(isAutoApproved("bash_run", "edits")).toBe(false);
  });

  // Only command execution is held back. File edits on the remote host are
  // still bounded by the deny-list, so they keep their normal tier.
  it("does not hold back remote file edits", () => {
    expect(isAutoApproved("write_file", "edits", { onRemoteHost: true })).toBe(true);
    expect(isAutoApproved("edit", "all", { onRemoteHost: true })).toBe(true);
  });

  it("still asks for delete on a remote host, as it does locally", () => {
    expect(isAutoApproved("delete_file", "edits", { onRemoteHost: true })).toBe(
      false,
    );
  });
});

// An extension declaring `auto` is asking for its tool to run unattended.
// That is honoured, but it is the tool's preference, not a statement that
// "auto-approve edits" — a claim about files in this workspace — covers
// third-party code doing something this app cannot inspect.
describe("extension tools", () => {
  it("does not ride along with auto-approve edits", () => {
    expect(isAutoApproved("ext__my_ext__do_thing", "edits")).toBe(false);
  });

  it("follows the mode that says nothing waits", () => {
    expect(isAutoApproved("ext__my_ext__do_thing", "all")).toBe(true);
  });

  it("asks in the default mode", () => {
    expect(isAutoApproved("ext__my_ext__do_thing", "ask")).toBe(false);
  });
});
