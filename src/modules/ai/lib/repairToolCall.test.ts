import { describe, expect, it } from "vitest";
import { buildAgentTools } from "../agents/agentFactory";
import { repairJsonText, repairToolCall } from "./repairToolCall";

describe("repairJsonText", () => {
  it("leaves already-valid JSON untouched", () => {
    const input = '{"tasks":[{"type":"read","prompt":"hi"}]}';
    expect(repairJsonText(input)).toBe(input);
  });

  it("escapes an unescaped double quote inside a string value", () => {
    const input = '{"prompt":"audit "route.ts" file"}';
    const repaired = repairJsonText(input);
    expect(() => JSON.parse(repaired)).not.toThrow();
    expect(JSON.parse(repaired).prompt).toBe('audit "route.ts" file');
  });

  it("escapes a literal newline inside a string value", () => {
    const input = '{"prompt":"line1\nline2"}';
    const repaired = repairJsonText(input);
    expect(() => JSON.parse(repaired)).not.toThrow();
    expect(JSON.parse(repaired).prompt).toBe("line1\nline2");
  });

  it("removes a trailing comma before a closing brace", () => {
    const input = '{"tasks":[1,2,]}';
    const repaired = repairJsonText(input);
    expect(() => JSON.parse(repaired)).not.toThrow();
    expect(JSON.parse(repaired).tasks).toEqual([1, 2]);
  });

  it("handles a batch with nested task objects and an unescaped quote", () => {
    const input =
      '{"tasks":[{"type":"security","prompt":"audit "route.ts""}],"max_concurrency":"2"}';
    const repaired = repairJsonText(input);
    expect(() => JSON.parse(repaired)).not.toThrow();
  });

  it("recovers from a markdown code fence", () => {
    const input = '```json\n{"tasks":[1,2]}\n```';
    const repaired = repairJsonText(input);
    expect(() => JSON.parse(repaired)).not.toThrow();
    expect(JSON.parse(repaired).tasks).toEqual([1, 2]);
  });

  // The bash_run failure from the field: a PowerShell command carrying raw
  // Windows paths (`C:\project`, `C:\Program Files`) and a regex (`\d`) inside
  // the JSON string. Strict parse rejects \p, \P, \d; doubling them keeps the
  // literal path the model meant.
  it("doubles invalid backslash escapes so Windows paths parse", () => {
    const input =
      '{"command":"Set-Location C:\\project\\star; $p = @(1..3 | % { C:\\Program Files\\x.exe -d $_ })"}';
    const repaired = repairJsonText(input);
    expect(() => JSON.parse(repaired)).not.toThrow();
    expect(JSON.parse(repaired).command).toBe(
      "Set-Location C:\\project\\star; $p = @(1..3 | % { C:\\Program Files\\x.exe -d $_ })",
    );
  });

  it("leaves valid JSON escapes untouched", () => {
    const input = '{"text":"line\\nquote \\" slash \\/ done"}';
    expect(repairJsonText(input)).toBe(input);
    expect(() => JSON.parse(input)).not.toThrow();
  });
});

describe("repairToolCall", () => {
  it("returns null for already-valid input", async () => {
    const result = await repairToolCall({
      toolCall: {
        toolCallId: "1",
        toolName: "run_subagents",
        input: '{"tasks":[]}',
      },
    });
    expect(result).toBeNull();
  });

  it("repairs a malformed input string", async () => {
    const malformed =
      '{"tasks":[{"type":"security","prompt":"audit "route.ts" file"}]}';
    const result = await repairToolCall({
      toolCall: {
        toolCallId: "1",
        toolName: "run_subagents",
        input: malformed,
      },
    });
    expect(result).not.toBeNull();
    expect(result?.toolName).toBe("run_subagents");
    // The SDK re-parses `input`, so it must be valid JSON text.
    if (!result) return;
    expect(() => JSON.parse(result.input)).not.toThrow();
  });

  it("returns null on an empty input", async () => {
    const result = await repairToolCall({
      toolCall: { toolCallId: "1", toolName: "run_subagents", input: "" },
    });
    expect(result).toBeNull();
  });

  it("falls back to the args field when input is absent", async () => {
    const result = await repairToolCall({
      toolCall: {
        toolCallId: "1",
        toolName: "run_subagents",
        args: '{"tasks":[]}',
      },
    });
    // Valid -> no repair -> null.
    expect(result).toBeNull();
  });

  it("rewrites a near-miss tool name to the real tool", async () => {
    const tools = {
      "ext_termigo-pentest-kit_run_pentest_tool": {},
      "ext_termigo-pentest-kit_recon": {},
      "ext_termigo-pentest-kit_scan": {},
    };
    const result = await repairToolCall({
      tools,
      toolCall: {
        toolCallId: "1",
        toolName: "ext_termigo-pentest-kool_run_pentest_tool",
        input: '{"target":"example.test"}',
      },
    });
    expect(result?.toolName).toBe("ext_termigo-pentest-kit_run_pentest_tool");
    expect(result?.input).toBe('{"target":"example.test"}');
  });

  // The near-miss branch rewrote the name but handed the model's raw args
  // straight back, so a typo'd name paired with near-JSON arguments still died
  // in the SDK's strict parse - the one case this hook exists to fix.
  it("repairs the arguments when it rewrites a near-miss tool name", async () => {
    const tools = {
      "ext_termigo-pentest-kit_run_pentest_tool": {},
      "ext_termigo-pentest-kit_recon": {},
    };
    const result = await repairToolCall({
      tools,
      toolCall: {
        toolCallId: "1",
        toolName: "ext_termigo-pentest-kool_run_pentest_tool",
        input: '{"target":"example.test", "note":"audit "route.ts""}',
      },
    });
    expect(result?.toolName).toBe("ext_termigo-pentest-kit_run_pentest_tool");
    if (!result) return;
    // The SDK re-parses `input`, so it must be valid JSON text.
    expect(() => JSON.parse(result.input)).not.toThrow();
    expect(JSON.parse(result.input).target).toBe("example.test");
    expect(JSON.parse(result.input).note).toContain("route.ts");
  });

  it("does not rewrite one real tool into a different one", async () => {
    const tools = {
      read_file: {},
      write_file: {},
      read_dir: {},
    };
    const result = await repairToolCall({
      tools,
      toolCall: { toolCallId: "1", toolName: "read_file", input: "{}" },
    });
    // `read_file` is a real tool, so this is not a NoSuchTool - no rewrite.
    expect(result).toBeNull();
  });

  it("rewrites cross-ecosystem aliases to canonical Termigo tools", async () => {
    const tools = {
      read_file: {},
      write_file: {},
      edit: {},
      bash_run: {},
      grep: {},
      fetch: {},
    };

    // view_file -> read_file
    const r1 = await repairToolCall({
      tools,
      toolCall: {
        toolCallId: "c1",
        toolName: "view_file",
        input: '{"AbsolutePath":"/home/user/test.txt"}',
      },
    });
    expect(r1?.toolName).toBe("read_file");
    expect(JSON.parse(r1?.input ?? "{}").path).toBe("/home/user/test.txt");

    // run_command -> bash_run
    const r2 = await repairToolCall({
      tools,
      toolCall: {
        toolCallId: "c2",
        toolName: "run_command",
        input: '{"CommandLine":"pnpm test"}',
      },
    });
    expect(r2?.toolName).toBe("bash_run");
    expect(JSON.parse(r2?.input ?? "{}").command).toBe("pnpm test");

    // replace_file_content -> edit
    const r3 = await repairToolCall({
      tools,
      toolCall: {
        toolCallId: "c3",
        toolName: "replace_file_content",
        input:
          '{"TargetFile":"a.ts","TargetContent":"old","ReplacementContent":"new"}',
      },
    });
    expect(r3?.toolName).toBe("edit");
    expect(JSON.parse(r3?.input ?? "{}").old_string).toBe("old");
    expect(JSON.parse(r3?.input ?? "{}").new_string).toBe("new");
    expect(JSON.parse(r3?.input ?? "{}").path).toBe("a.ts");
  });

  it("redirects unmapped tools to unknown_tool_fallback when registered", async () => {
    const tools = { unknown_tool_fallback: {} };
    const result = await repairToolCall({
      tools,
      toolCall: {
        toolCallId: "c4",
        toolName: "unrecognized_fancy_tool",
        input: '{"arg":"val"}',
      },
    });
    expect(result?.toolName).toBe("unknown_tool_fallback");
    expect(JSON.parse(result!.input).requested_tool).toBe(
      "unrecognized_fancy_tool",
    );
  });

  it("returns null when the misspelled name has no close match and no fallback tool", async () => {
    const tools = { run_subagents: {}, run_subagent: {} };
    const result = await repairToolCall({
      tools,
      toolCall: {
        toolCallId: "1",
        toolName: "totally_unrelated_tool",
        input: "{}",
      },
    });
    expect(result).toBeNull();
  });

  // The failure from the field: a DeepSeek endpoint running as a compact-tier
  // model was handed 27 pruned tools, reached for `git_push` - a real tool the
  // prune had dropped - and the run died with the fatal
  //   "Model tried to call unavailable tool 'git_push'."
  // Nothing could recover it, because the prune had dropped
  // `unknown_tool_fallback` in the same pass. The fix is upstream (the recovery
  // tools survive every prune), and this asserts the whole chain end to end.
  it("recovers a pruned tool name on a compact-tier toolset", async () => {
    const full = {
      read_file: {},
      git_commit: {},
      git_push: {},
      unknown_tool_fallback: {},
    };
    const compact = buildAgentTools(full, { compactToolTier: true });
    expect(compact.git_push).toBeUndefined();
    expect(compact.unknown_tool_fallback).toBeDefined();

    const result = await repairToolCall({
      tools: compact,
      toolCall: {
        toolCallId: "c5",
        toolName: "git_push",
        input: '{"branch":"main"}',
      },
    });
    expect(result?.toolName).toBe("unknown_tool_fallback");
    expect(JSON.parse(result!.input).requested_tool).toBe("git_push");
  });

  it("repairs run_subagents when tasks are passed as todos", async () => {
    const tools = { run_subagents: {} };
    const result = await repairToolCall({
      tools,
      toolCall: {
        toolCallId: "sub-1",
        toolName: "run_subagents",
        input: JSON.stringify({
          max_concurrency: 4,
          todos:
            '[{"id": "map", "status": "completed", "title": "Petakan struktur kode Rust + TypeScript"}]',
        }),
      },
    });
    expect(result).not.toBeNull();
    expect(result?.toolName).toBe("run_subagents");
    const parsed = JSON.parse(result!.input);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].prompt).toBe(
      "Petakan struktur kode Rust + TypeScript",
    );
    expect(parsed.max_concurrency).toBe(4);
  });

  it("repairs grep arguments when query or path are used", async () => {
    const tools = { grep: {} };
    const result = await repairToolCall({
      tools,
      toolCall: {
        toolCallId: "grep-1",
        toolName: "grep",
        input: JSON.stringify({
          query: "setActiveId",
          path: "C:/project/termigo/src/modules/tabs/lib/useTabs.ts",
        }),
      },
    });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.input);
    expect(parsed.pattern).toBe("setActiveId");
    expect(parsed.root).toBe("C:/project/termigo/src/modules/tabs/lib/useTabs.ts");
  });

  it("repairs code_search arguments when max_results exceeds 20", async () => {
    const tools = { code_search: {} };
    const result = await repairToolCall({
      tools,
      toolCall: {
        toolCallId: "cs-1",
        toolName: "code_search",
        input: JSON.stringify({
          query: "setActiveId",
          max_results: 30,
        }),
      },
    });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.input);
    expect(parsed.max_results).toBe(30);
  });

  it("repairs replace_in_files when glob is a string", async () => {
    const tools = { replace_in_files: {} };
    const result = await repairToolCall({
      tools,
      toolCall: {
        toolCallId: "rif-1",
        toolName: "replace_in_files",
        input: JSON.stringify({
          path: "C:/project/termigo",
          glob: "src-tauri/src/modules/pty/mod.rs",
          search: "AtomicU32",
          replace: "AtomicU64",
        }),
      },
    });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.input);
    expect(parsed.glob).toEqual(["src-tauri/src/modules/pty/mod.rs"]);
  });

  it("repairs code_search arguments when pattern or path are used", async () => {
    const tools = { code_search: {} };
    const result = await repairToolCall({
      tools,
      toolCall: {
        toolCallId: "cs-2",
        toolName: "code_search",
        input: JSON.stringify({
          pattern: "setActiveId",
          path: "src/modules/ai",
        }),
      },
    });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.input);
    expect(parsed.query).toBe("setActiveId");
    expect(parsed.root).toBe("src/modules/ai");
  });

  it("applies semantic repairs on malformed near-JSON tool inputs", async () => {
    const tools = { replace_in_files: {} };
    const malformed =
      '{"path":"C:/project","glob":"*.ts","search":"fn \\"hello\\"()","replace":"fn \\"world\\"()",}';
    const result = await repairToolCall({
      tools,
      toolCall: {
        toolCallId: "rif-2",
        toolName: "replace_in_files",
        input: malformed,
      },
    });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.input);
    expect(parsed.glob).toEqual(["*.ts"]);
  });
});
