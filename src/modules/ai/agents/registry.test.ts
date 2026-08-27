import { describe, expect, it } from "vitest";
import { SUBAGENTS } from "./registry";
import { subagentToolNeedsGate } from "./runSubagent";
import { extToolName } from "../lib/extensionToolNames";
import { mcpToolName } from "../lib/mcpToolNames";
import { customToolName } from "../lib/customToolNames";

describe("SUBAGENTS registry", () => {
  it("keys match each def's id and every def carries a prompt", () => {
    for (const [key, def] of Object.entries(SUBAGENTS)) {
      expect(def.id).toBe(key);
      expect(def.systemPrompt.length).toBeGreaterThan(0);
    }
  });
});

describe("subagentToolNeedsGate", () => {
  const mutating = { needsApproval: true, execute: () => undefined };
  const readOnly = { execute: () => undefined };

  it("gates any built-in tool that declares needsApproval", () => {
    for (const name of ["write_file", "edit", "bash_run", "delete_file", "git_commit"]) {
      expect(subagentToolNeedsGate(name, mutating)).toBe(true);
    }
  });

  it("gates every third-party tool by name, regardless of flag", () => {
    for (const name of [
      extToolName("termigo-pentest-kit", "recon"),
      mcpToolName("server", "do_thing"),
      customToolName("my_tool"),
    ]) {
      expect(subagentToolNeedsGate(name, readOnly)).toBe(true);
    }
  });

  it("lets read-only tools auto-run (no needsApproval, not third-party)", () => {
    for (const name of ["read_file", "list_directory", "grep", "glob", "bash_logs"]) {
      expect(subagentToolNeedsGate(name, readOnly)).toBe(false);
    }
  });
});
