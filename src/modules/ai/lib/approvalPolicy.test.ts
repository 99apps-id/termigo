import { describe, expect, it } from "vitest";
import {
  APPROVAL_MODES,
  approvalTier,
  isAutoApproved,
  subagentWriteNeedsApproval,
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

  // The modes delegate routine work, not the power to destroy. Deleting is the
  // one thing none of them speaks for - including the most permissive, which
  // used to return before anything could hold it back.
  it("still asks in the mode that delegates everything else", () => {
    expect(isAutoApproved("delete_file", "all")).toBe(false);
  });

  it("keeps delegating everything recoverable in that mode", () => {
    for (const t of ["edit", "write_file", "move_file", "bash_run"]) {
      expect(isAutoApproved(t, "all")).toBe(true);
    }
  });

  it("asks in the default mode, like everything else", () => {
    expect(isAutoApproved("delete_file", "ask")).toBe(false);
  });
});

// The safety layer's shape is "inside this workspace", and every file tool
// refuses paths outside it. A command on a remote host has no equivalent
// boundary, so this is the one place an approval mode may not speak for the
// user.
describe("commands on a remote host", () => {
  // Gating every remote command meant dozens of prompts to set up one server,
  // most of them for `ls`. A prompt that always appears is a prompt nobody
  // reads, so the gate sits on risk rather than on being remote.
  it("lets inspection through once edits are delegated", () => {
    for (const command of ["ls -la", "docker ps", "git status", "cat /etc/hosts"]) {
      expect(isAutoApproved("bash_run", "edits", { onRemoteHost: true, command })).toBe(
        true,
      );
    }
  });

  it("still stops anything that could change the server", () => {
    for (const command of [
      "rm -rf /srv",
      "systemctl restart nginx",
      "apt install nginx",
      "ls && rm -rf /tmp/x",
    ]) {
      expect(isAutoApproved("bash_run", "edits", { onRemoteHost: true, command })).toBe(
        false,
      );
    }
  });

  // Fail-closed: an unrecognised command is treated as changing the server.
  it("stops a command it cannot classify", () => {
    expect(
      isAutoApproved("bash_run", "edits", { onRemoteHost: true, command: "./deploy.sh" }),
    ).toBe(false);
    expect(isAutoApproved("bash_run", "edits", { onRemoteHost: true })).toBe(false);
  });

  it("honours the permissive mode for a command that only changes things", () => {
    expect(
      isAutoApproved("bash_run", "all", {
        onRemoteHost: true,
        command: "systemctl restart nginx",
      }),
    ).toBe(true);
  });

  // A shell delete is as permanent as the tool named after it, and a remote
  // one has no workspace boundary to fall back on.
  it("still asks for a deleting command, even remotely, even in that mode", () => {
    expect(
      isAutoApproved("bash_run", "all", {
        onRemoteHost: true,
        command: "rm -rf /",
      }),
    ).toBe(false);
  });

  it("asks for everything in the default mode", () => {
    expect(
      isAutoApproved("bash_run", "ask", { onRemoteHost: true, command: "ls" }),
    ).toBe(false);
  });

  // Local behaviour is untouched: `Auto-approve edits` still says commands ask.
  it("leaves local commands under the mode the user chose", () => {
    expect(isAutoApproved("bash_run", "all")).toBe(true);
    expect(isAutoApproved("bash_run", "edits", { command: "ls" })).toBe(false);
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

// A custom tool runs a shell command, so it belongs with bash_run rather than
// with the file edits — whoever wrote the template.
describe("custom command tools", () => {
  it("does not ride along with auto-approve edits", () => {
    expect(isAutoApproved("cmd__deploy", "edits")).toBe(false);
  });

  it("follows the mode that says nothing waits", () => {
    expect(isAutoApproved("cmd__deploy", "all")).toBe(true);
  });

  // Defining one only writes a JSON file, so it sits with the other workspace
  // writes; running it is what carries the risk.
  it("lets defining one ride along with edits", () => {
    expect(isAutoApproved("create_tool", "edits")).toBe(true);
  });
});

// The floor: a small set of irreversible actions that no mode delegates. The
// modes exist to hand over routine work, and losing an untracked file is not
// routine work.
describe("the always-ask floor", () => {
  it("holds delete_file back in every mode", () => {
    for (const mode of APPROVAL_MODES) {
      expect(isAutoApproved("delete_file", mode)).toBe(false);
    }
  });

  it("holds a deleting shell command back in every mode", () => {
    for (const mode of APPROVAL_MODES) {
      expect(
        isAutoApproved("bash_run", mode, { command: "rm -rf src" }),
      ).toBe(false);
    }
  });

  // A custom tool is a shell command wearing another name, so the gate follows
  // the command rather than the tool it arrived under.
  it("follows the command, not the tool name", () => {
    expect(
      isAutoApproved("cmd__cleanup", "all", { command: "rm -rf build" }),
    ).toBe(false);
    expect(
      isAutoApproved("cmd__cleanup", "all", { command: "pnpm build" }),
    ).toBe(true);
  });

  it("does not widen into the ordinary work the modes are for", () => {
    expect(isAutoApproved("write_file", "edits")).toBe(true);
    expect(isAutoApproved("bash_run", "all", { command: "pnpm test" })).toBe(
      true,
    );
  });
});

// Sub-agents ask through the approval queue, not the SDK protocol, so none of
// the machinery that answers the main agent's questions reaches them. Both of
// these gaps were found by auditing that seam rather than by anything failing.
describe("a sub-agent write asks only when it should", () => {
  it("asks in ask-every-time, which is the whole point of that mode", () => {
    expect(
      subagentWriteNeedsApproval("write_file", "ask", { planActive: false }),
    ).toBe(true);
  });

  // The reported shape: mode set to Auto all, builders spawned, and every
  // write stopped anyway. A blocked sub-agent looks exactly like a slow one.
  it("does not ask under auto-approve all", () => {
    expect(
      subagentWriteNeedsApproval("write_file", "all", { planActive: false }),
    ).toBe(false);
  });

  it("does not ask under auto-approve edits, since a write is an edit", () => {
    for (const tool of ["write_file", "edit", "multi_edit", "create_directory"]) {
      expect(
        subagentWriteNeedsApproval(tool, "edits", { planActive: false }),
        tool,
      ).toBe(false);
    }
  });

  // Plan mode does not perform the write; it queues it for the review the user
  // is about to do. Asking would be the same edit approved twice.
  it("does not ask in plan mode, in any approval mode", () => {
    for (const mode of ["ask", "edits", "all"] as const) {
      expect(
        subagentWriteNeedsApproval("write_file", mode, { planActive: true }),
        mode,
      ).toBe(false);
    }
  });

  // The floor holds here too: no mode delegates a delete, so if a delete tool
  // were ever handed to a sub-agent it would still have to ask.
  it("still asks for a delete under auto-approve all", () => {
    expect(
      subagentWriteNeedsApproval("delete_file", "all", { planActive: false }),
    ).toBe(true);
  });
});
