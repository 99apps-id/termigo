import { describe, expect, it } from "vitest";
import { matchingHooks, parseHooksFile } from "./hooks";

describe("parseHooksFile", () => {
  it("returns empty config for blank input", () => {
    expect(parseHooksFile("")).toEqual({ ok: true, config: {} });
    expect(parseHooksFile("   ")).toEqual({ ok: true, config: {} });
  });

  it("rejects non-object JSON", () => {
    expect(parseHooksFile("[]")).toEqual({
      ok: false,
      reason: "hooks.json must be a JSON object",
    });
    expect(parseHooksFile('"string"')).toEqual({
      ok: false,
      reason: "hooks.json must be a JSON object",
    });
  });

  it("rejects invalid JSON", () => {
    expect(parseHooksFile("{")).toEqual({
      ok: false,
      reason: "hooks.json is not valid JSON",
    });
  });

  it("parses a valid config", () => {
    const r = parseHooksFile(
      JSON.stringify({
        PreToolUse: [{ command: "echo pre" }],
        PostToolUse: [{ command: "echo post", tool: "bash_run" }],
        Stop: [{ command: "echo done" }],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.PreToolUse).toHaveLength(1);
      expect(r.config.PostToolUse?.[0]?.tool).toBe("bash_run");
      expect(r.config.Stop).toHaveLength(1);
    }
  });

  it("rejects unknown events", () => {
    expect(
      parseHooksFile(JSON.stringify({ Foo: [{ command: "echo" }] })),
    ).toEqual({
      ok: false,
      reason: 'unknown hook event "Foo". Allowed: PreToolUse, PostToolUse, Stop',
    });
  });

  it("rejects empty command", () => {
    expect(parseHooksFile(JSON.stringify({ PreToolUse: [{ command: "" }] }))).toEqual({
      ok: false,
      reason: "hook command must not be empty",
    });
  });

  it("rejects multi-line command", () => {
    expect(
      parseHooksFile(JSON.stringify({ PreToolUse: [{ command: "echo\nrm -rf /" }] })),
    ).toEqual({
      ok: false,
      reason: "hook command must be single-line (no CR/LF or control characters)",
    });
  });

  it("rejects empty tool filter", () => {
    expect(
      parseHooksFile(JSON.stringify({ PreToolUse: [{ command: "echo", tool: "" }] })),
    ).toEqual({
      ok: false,
      reason: "hook tool filter must not be empty when set",
    });
  });
});

describe("matchingHooks", () => {
  const config = {
    PreToolUse: [
      { command: "echo all-pre" },
      { command: "echo bash-pre", tool: "bash_run" },
    ],
    PostToolUse: [{ command: "echo post", tool: "bash_run" }],
    Stop: [{ command: "echo stop" }],
  };

  it("returns all PreToolUse hooks when no tool filter", () => {
    expect(matchingHooks(config, "PreToolUse", "bash_run")).toHaveLength(2);
  });

  it("filters PostToolUse by tool name", () => {
    expect(matchingHooks(config, "PostToolUse", "bash_run")).toHaveLength(1);
    expect(matchingHooks(config, "PostToolUse", "read_file")).toHaveLength(0);
  });

  it("returns Stop hooks regardless of tool name", () => {
    expect(matchingHooks(config, "Stop", null)).toHaveLength(1);
    expect(matchingHooks(config, "Stop", "anything")).toHaveLength(1);
  });

  it("returns empty for events with no rules", () => {
    expect(matchingHooks({}, "PreToolUse", "bash_run")).toHaveLength(0);
  });
});
