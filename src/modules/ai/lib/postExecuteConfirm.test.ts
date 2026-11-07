import { usePreferencesStore } from "@/modules/settings/preferences";
import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../tools/context";
import { useConfirmationStore } from "../store/confirmationStore";
import {
  makeSummary,
  POST_EXECUTE_CONFIRM_TOOLS,
  withPostExecuteConfirm,
} from "./postExecuteConfirm";

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

  it("bypasses confirmation when agent approval mode is all", async () => {
    usePreferencesStore.setState({
      confirmAfterMutations: true,
      agentApprovalMode: "all",
    });
    const fakeTool = {
      execute: async () => ({ ok: true, path: "/p/a.ts" }),
    };
    const ctx = {
      getSessionId: () => "s1",
      getWorkspaceRoot: () => "/p",
      getCwd: () => "/p",
    } as unknown as ToolContext;
    const wrapped = withPostExecuteConfirm("write_file", fakeTool, ctx);
    const result = await wrapped.execute({ path: "/p/a.ts" }, {});
    expect(result).toEqual({ ok: true, path: "/p/a.ts" });
    expect(useConfirmationStore.getState().pending).toHaveLength(0);
  });

  it("bypasses confirmation for edit tools when agent approval mode is edits", async () => {
    usePreferencesStore.setState({
      confirmAfterMutations: true,
      agentApprovalMode: "edits",
    });
    const fakeTool = {
      execute: async () => ({ ok: true, path: "/p/b.ts" }),
    };
    const ctx = {
      getSessionId: () => "s1",
      getWorkspaceRoot: () => "/p",
      getCwd: () => "/p",
    } as unknown as ToolContext;
    const wrapped = withPostExecuteConfirm("edit", fakeTool, ctx);
    const result = await wrapped.execute({ path: "/p/b.ts" }, {});
    expect(result).toEqual({ ok: true, path: "/p/b.ts" });
    expect(useConfirmationStore.getState().pending).toHaveLength(0);
  });

  // "Revert" on a `bash_run` used to fall through to `revertCommand(undefined)`,
  // which is `git restore .` -- that discards EVERY tracked change in the
  // repository, including the user's and other agents' uncommitted work.
  it("refuses to revert a change it cannot attribute to a single path", async () => {
    usePreferencesStore.setState({
      confirmAfterMutations: true,
      agentApprovalMode: "ask",
      agentAlwaysAllowedTools: [],
    });
    const fakeTool = {
      execute: async () => ({ ok: true, stdout: "done", exit_code: 0 }),
    };
    const ctx = {
      getSessionId: () => "s1",
      getWorkspaceRoot: () => "/p",
      getCwd: () => "/p",
    } as unknown as ToolContext;
    const wrapped = withPostExecuteConfirm("bash_run", fakeTool, ctx);

    // The wrapper parks on the confirmation card, so answer it: Revert.
    const run = wrapped.execute({ command: "rm -rf build" }, {});
    await vi.waitFor(() => {
      expect(useConfirmationStore.getState().pending).toHaveLength(1);
    });
    const pending = useConfirmationStore.getState().pending[0];
    useConfirmationStore.getState().resolve(pending.id, false);

    const result = (await run) as Record<string, unknown>;
    expect(result.reverted_by_user).toBe(true);
    expect(result.revert_command).toBeNull();
    expect(String(result.note)).toContain("nothing was reverted");
  });
});
