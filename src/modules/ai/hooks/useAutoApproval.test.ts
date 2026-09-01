import { describe, expect, it } from "vitest";
import { toolNameOf } from "./useAutoApproval";

describe("toolNameOf", () => {
  it("reads built-in tool names from their UI part type", () => {
    expect(toolNameOf({ type: "tool-bash_run" })).toBe("bash_run");
  });

  it("preserves the actual name of a dynamic extension or MCP tool", () => {
    expect(
      toolNameOf({
        type: "dynamic-tool",
        toolName: "ext__termigo-pentest-kit__recon",
      }),
    ).toBe("ext__termigo-pentest-kit__recon");
  });

  it("does not auto-approve an unnamed dynamic tool", () => {
    expect(toolNameOf({ type: "dynamic-tool" })).toBe("");
  });
});
