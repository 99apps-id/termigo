import { describe, expect, it, vi } from "vitest";
import type { McpTool } from "@/modules/mcp/bridge";
import { toggleMcpTool } from "./McpSection";

/**
 * The probe merge in ServerRow: live tools marked enabled, plus entries for
 * disabled tools the backend filtered out, so they can be toggled back on.
 */
function mergeProbeTools(listed: McpTool[], disabled: string[]): McpTool[] {
  const disabledEntries: McpTool[] = disabled
    .filter((name) => !listed.some((t) => t.name === name))
    .map((name) => ({
      name,
      description: "",
      inputSchema: {},
      enabled: false,
    }));
  return [...listed.map((t) => ({ ...t, enabled: true })), ...disabledEntries];
}

describe("MCP probe merge", () => {
  it("marks live tools enabled and appends disabled ones", () => {
    const out = mergeProbeTools(
      [{ name: "a", description: "d", inputSchema: {} }],
      ["b"],
    );
    expect(out).toEqual([
      { name: "a", description: "d", inputSchema: {}, enabled: true },
      { name: "b", description: "", inputSchema: {}, enabled: false },
    ]);
  });

  it("does not duplicate a disabled tool that is still listed", () => {
    const out = mergeProbeTools(
      [{ name: "a", description: "d", inputSchema: {} }],
      ["a"],
    );
    expect(out).toEqual([
      { name: "a", description: "d", inputSchema: {}, enabled: true },
    ]);
  });

  it("returns only live tools when nothing is disabled", () => {
    const out = mergeProbeTools(
      [{ name: "a", description: "d", inputSchema: {} }],
      [],
    );
    expect(out).toEqual([
      { name: "a", description: "d", inputSchema: {}, enabled: true },
    ]);
  });
});

describe("toggleMcpTool", () => {
  it("persists the flipped flag, invalidates, then refreshes", async () => {
    const setToolEnabled = vi.fn().mockResolvedValue(undefined);
    const invalidate = vi.fn();
    const onChanged = vi.fn();
    await toggleMcpTool("github", "dangerous_tool", true, {
      setToolEnabled,
      invalidate,
      onChanged,
    });
    expect(setToolEnabled).toHaveBeenCalledWith(
      "github",
      "dangerous_tool",
      false,
    );
    expect(invalidate).toHaveBeenCalledOnce();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("propagates a persistence failure without invalidating", async () => {
    const setToolEnabled = vi.fn().mockRejectedValue(new Error("nope"));
    const invalidate = vi.fn();
    const onChanged = vi.fn();
    await expect(
      toggleMcpTool("github", "t", true, {
        setToolEnabled,
        invalidate,
        onChanged,
      }),
    ).rejects.toThrow("nope");
    expect(invalidate).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
