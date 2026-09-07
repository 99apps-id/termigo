import { describe, expect, it } from "vitest";
import {
  extractToolSummaries,
  formatLiveProgress,
  summarizeToolInput,
  summarizeToolOutput,
  truncate,
} from "./progressFormat";

describe("progressFormat", () => {
  describe("truncate", () => {
    it("returns short string as-is", () => {
      expect(truncate("hello", 10)).toBe("hello");
    });

    it("truncates string with ellipsis when exceeding limit", () => {
      expect(truncate("hello world", 8)).toBe("hello...");
    });
  });

  describe("summarizeToolInput", () => {
    it("summarizes bash command and collapses whitespace", () => {
      const input = {
        command:
          "Get-ChildItem -Path C:/Downloads\n  | Where-Object { $_.Length -gt 100 }",
      };
      const res = summarizeToolInput("bash_run", input, 50);
      expect(res).toBe("Get-ChildItem -Path C:/Downloads | Where-Object...");
    });

    it("summarizes file path for file operations", () => {
      expect(
        summarizeToolInput("read_file", {
          path: "C:/Users/Iwan/Downloads/file.txt",
        }),
      ).toBe("C:/Users/Iwan/Downloads/file.txt");
      expect(
        summarizeToolInput("delete_file", { path: "C:/temp/junk.exe" }),
      ).toBe("C:/temp/junk.exe");
    });

    it("summarizes move_file with from and to", () => {
      const res = summarizeToolInput("move_file", {
        from: "src/a.ts",
        to: "dist/a.ts",
      });
      expect(res).toBe("src/a.ts -> dist/a.ts");
    });

    it("summarizes copy_file with source and dest_dir", () => {
      const res = summarizeToolInput("copy_file", {
        source: "src/a.ts",
        dest_dir: "backup",
      });
      expect(res).toBe("src/a.ts -> backup");
    });

    it("handles invalid or non-object input gracefully", () => {
      expect(summarizeToolInput("bash_run", null)).toBe("");
      expect(summarizeToolInput("bash_run", "not-an-object")).toBe("");
    });
  });

  describe("summarizeToolOutput", () => {
    it("summarizes successful bash_run with stdout", () => {
      const output = {
        exit_code: 0,
        stdout: "Found 16 duplicate files\nReady to clean",
      };
      const res = summarizeToolOutput("bash_run", output, 40);
      expect(res).toBe("Found 16 duplicate files Ready to clean");
    });

    it("summarizes failed bash_run with exit code and stderr", () => {
      const output = {
        exit_code: 1,
        stderr: "Cannot find path 'C:/test' because it does not exist.",
      };
      const res = summarizeToolOutput("bash_run", output);
      expect(res).toBe(
        "exit 1: Cannot find path 'C:/test' because it does not exist.",
      );
    });

    it("summarizes list_directory with entry count", () => {
      const output = {
        entries: [{ name: "a" }, { name: "b" }, { name: "c" }],
      };
      expect(summarizeToolOutput("list_directory", output)).toBe("3 entries");
    });

    it("summarizes write_file with bytes written", () => {
      const output = { bytesWritten: 1024, ok: true };
      expect(summarizeToolOutput("write_file", output)).toBe(
        "1024 bytes written",
      );
    });

    it("summarizes read_file with lines read or unchanged", () => {
      expect(
        summarizeToolOutput("read_file", {
          lines_returned: 85,
          total_lines: 120,
        }),
      ).toBe("85 lines read");
      expect(summarizeToolOutput("read_file", { unchanged: true })).toBe(
        "unchanged",
      );
    });

    it("summarizes error message when error property exists", () => {
      expect(
        summarizeToolOutput("read_file", { error: "file not found" }),
      ).toBe("error: file not found");
    });
  });

  describe("extractToolSummaries", () => {
    it("extracts tool calls from assistant message parts with correct states", () => {
      const parts = [
        {
          type: "tool-read_file",
          state: "output-available",
          input: { path: "C:/docs/report.pdf" },
          output: { lines_returned: 50 },
        },
        {
          type: "tool-bash_run",
          state: "output-available",
          input: { command: "Get-Process" },
          output: { exit_code: 0, stdout: "Process list..." },
        },
        {
          type: "tool-delete_file",
          state: "approval-requested",
          input: { path: "C:/temp/junk.exe" },
        },
      ];

      const summaries = extractToolSummaries(parts);
      expect(summaries).toHaveLength(3);

      expect(summaries[0]).toEqual({
        toolName: "read_file",
        state: "done",
        input: "C:/docs/report.pdf",
        output: "50 lines read",
      });

      expect(summaries[1]).toEqual({
        toolName: "bash_run",
        state: "done",
        input: "Get-Process",
        output: "Process list...",
      });

      expect(summaries[2]).toEqual({
        toolName: "delete_file",
        state: "awaiting-approval",
        input: "C:/temp/junk.exe",
      });
    });
  });

  describe("formatLiveProgress", () => {
    it("formats completed state cleanly", () => {
      const text = formatLiveProgress({ status: "idle", completed: true });
      expect(text).toBe("[Termigo Agent] Finished.");
    });

    it("formats in-progress status with active and recent tools", () => {
      const text = formatLiveProgress({
        status: "streaming",
        round: 0,
        step: "Organizing files",
        tools: [
          {
            toolName: "list_directory",
            state: "done",
            input: "C:/Users/Iwan/Downloads",
            output: "19 entries",
          },
          {
            toolName: "bash_run",
            state: "running",
            input: "Get-ChildItem ...",
          },
        ],
        todos: [{ title: "Clean duplicate files", status: "in_progress" }],
      });

      expect(text).toContain("[Termigo Agent] Status: Working... (round 1)");
      expect(text).toContain("Step: Organizing files");
      expect(text).toContain(
        "Active:\n* bash_run [running]\n  in: Get-ChildItem ...",
      );
      expect(text).toContain("Recent:\n- list_directory [done]");
      expect(text).toContain("Todo:\n- [in_progress] Clean duplicate files");
    });
  });
});
