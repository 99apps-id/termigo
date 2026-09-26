import { describe, expect, it } from "vitest";
import {
  APPROVAL_MODES,
  approvalTier,
  isAutoApproved,
  subagentWriteNeedsApproval,
  type ApprovalMode,
} from "./approvalPolicy";

const ALL_TOOLS = [
  "write_file",
  "create_directory",
  "edit",
  "multi_edit",
  "bash_run",
  "bash_background",
  "spawn_coding_agent",
  "send_to_agent",
  "delete_file",
  "fetch",
  "some_future_tool",
  "ext__my_ext__do_thing",
  "cmd__deploy",
  "create_tool",
  "update_skill",
  "process",
];

// termigo-neo: no approval gates. Every tool is auto-approved in every mode,
// including deletes and destructive shell commands, and sub-agent writes never
// ask. These tests pin that contract so a reintroduced gate fails loudly.
describe("termigo-neo allow-all approval contract", () => {
  it("auto-approves every tool in every mode", () => {
    for (const mode of APPROVAL_MODES) {
      for (const tool of ALL_TOOLS) {
        expect(isAutoApproved(tool, mode), `${tool} ${mode}`).toBe(true);
      }
    }
  });

  it("auto-approves destructive commands and deletes in every mode", () => {
    for (const mode of APPROVAL_MODES) {
      expect(isAutoApproved("delete_file", mode)).toBe(true);
      expect(
        isAutoApproved("bash_run", mode, { command: "rm -rf src" }),
      ).toBe(true);
      expect(
        isAutoApproved("bash_run", mode, {
          onRemoteHost: true,
          command: "rm -rf /",
        }),
      ).toBe(true);
      expect(
        isAutoApproved("cmd__cleanup", mode, { command: "rm -rf build" }),
      ).toBe(true);
    }
  });

  it("keeps the mode and tier vocabulary intact for the UI", () => {
    expect([...APPROVAL_MODES]).toEqual<ApprovalMode[]>(["ask", "edits", "all"]);
    expect(approvalTier("update_skill")).toBe("edit");
    expect(approvalTier("process")).toBe("exec");
    expect(approvalTier("some_future_tool")).toBe("exec");
  });

  it("never asks for a sub-agent write, in any mode", () => {
    for (const mode of APPROVAL_MODES) {
      for (const tool of [
        "write_file",
        "edit",
        "multi_edit",
        "create_directory",
        "delete_file",
        "bash_run",
      ]) {
        expect(
          subagentWriteNeedsApproval(tool, mode, { planActive: false }),
          `${tool} ${mode}`,
        ).toBe(false);
        expect(
          subagentWriteNeedsApproval(tool, mode, { planActive: true }),
          `${tool} ${mode} plan`,
        ).toBe(false);
      }
    }
  });
});
