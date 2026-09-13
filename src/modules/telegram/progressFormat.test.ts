import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  extractToolSummaries,
  formatCompletionCard,
  formatDuration,
  formatLiveProgress,
  formatMarkdownTable,
  formatTodoProgress,
  markdownToTelegramHtml,
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
    it("closes with the outcome, not a bare 'Completed.'", () => {
      // The card used to be replaced by "Completed." whatever had happened, so
      // a stopped or failed run closed with the same word as a clean finish and
      // the record of status, tools and step was thrown away.
      const text = formatLiveProgress({ status: "idle", completed: true });
      expect(text).toBe("**[Termigo Agent]** ✓ Done");
    });

    it("names each way a run can end", () => {
      const card = (outcome: "done" | "stopped" | "step-cap" | "error") =>
        formatCompletionCard({ status: "idle", completed: true, outcome });
      expect(card("done")).toContain("✓ Done");
      expect(card("stopped")).toContain("⏹ Stopped");
      expect(card("step-cap")).toContain("⏸ Step limit reached");
      expect(card("error")).toContain("✗ Ended with error");
    });

    it("states how much was finished and how long it took", () => {
      const text = formatCompletionCard({
        status: "idle",
        completed: true,
        elapsedMs: 252_000,
        todos: [
          { title: "a", status: "completed" },
          { title: "b", status: "completed" },
          { title: "c", status: "in_progress" },
        ],
      });
      expect(text).toBe("**[Termigo Agent]** ✓ Done · 4m 12s\n2/3 steps done");
    });

    it("omits the progress line when the run kept no list", () => {
      const text = formatCompletionCard({ status: "idle", completed: true });
      expect(text).not.toContain("steps done");
      expect(text.split("\n")).toHaveLength(1);
    });

    it("omits the duration when it is unknown", () => {
      expect(formatCompletionCard({ status: "idle", completed: true })).toBe(
        "**[Termigo Agent]** ✓ Done",
      );
    });

    it("displays Step, active task, and lively tool activity trail (Ran, Listed, etc.)", () => {
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
        todos: [
          { title: "Scan folder", status: "completed" },
          { title: "Clean duplicate files", status: "in_progress" },
          { title: "Report results", status: "pending" },
        ],
      });

      expect(text).toContain("**[Termigo Agent]** *Writing response...* (step 1)");
      expect(text).toContain("*Organizing files*");
      expect(text).toContain("🔹 Clean duplicate files");
      expect(text).toContain("✓ Listed `C:/Users/Iwan/Downloads` → _19 entries_");
      expect(text).toContain("⚡ Running `Get-ChildItem ...`");
      expect(text).not.toContain("Scan folder");
      expect(text).not.toContain("Report results");
    });
  });

  describe("formatDuration", () => {
    it("pads the seconds so the width does not jump", () => {
      expect(formatDuration(8_000)).toBe("0m 08s");
      expect(formatDuration(59_000)).toBe("0m 59s");
      expect(formatDuration(60_000)).toBe("1m 00s");
      expect(formatDuration(3_599_000)).toBe("59m 59s");
    });

    it("returns nothing for a missing or impossible duration", () => {
      expect(formatDuration(undefined)).toBe("");
      expect(formatDuration(-1)).toBe("");
      expect(formatDuration(Number.NaN)).toBe("");
    });
  });

  describe("formatTodoProgress", () => {
    it("counts only the items the agent marked done", () => {
      expect(
        formatTodoProgress([
          { status: "completed" },
          { status: "completed" },
          { status: "pending" },
        ]),
      ).toBe("2/3 steps done");
    });

    it("reports a fully finished list", () => {
      expect(
        formatTodoProgress([{ status: "completed" }, { status: "completed" }]),
      ).toBe("2/2 steps done");
    });

    it("has nothing to say without a list", () => {
      expect(formatTodoProgress(undefined)).toBe("");
      expect(formatTodoProgress([])).toBe("");
    });
  });

  describe("markdownToTelegramHtml", () => {
    it("converts bold syntax without leaving asterisks", () => {
      expect(markdownToTelegramHtml("Teks **tebal** dan kuat")).toBe(
        "Teks <b>tebal</b> dan kuat",
      );
    });

    it("converts italic syntax with asterisks and underscores", () => {
      expect(markdownToTelegramHtml("Teks *miring* dan _miring juga_")).toBe(
        "Teks <i>miring</i> dan <i>miring juga</i>",
      );
      // Preserves snake_case variables outside code
      expect(markdownToTelegramHtml("variable_name_test")).toBe(
        "variable_name_test",
      );
    });

    it("converts underline syntax", () => {
      expect(markdownToTelegramHtml("Teks __bergaris bawah__")).toBe(
        "Teks <u>bergaris bawah</u>",
      );
      expect(markdownToTelegramHtml("Teks <u>html underline</u>")).toBe(
        "Teks <u>html underline</u>",
      );
    });

    it("converts strikethrough syntax", () => {
      expect(markdownToTelegramHtml("Teks ~~dicoret~~")).toBe(
        "Teks <s>dicoret</s>",
      );
    });

    it("converts inline code and code blocks with HTML escaping", () => {
      expect(markdownToTelegramHtml("Perintah `Get-ChildItem <path> & test`")).toBe(
        "Perintah <code>Get-ChildItem &lt;path&gt; &amp; test</code>",
      );

      const codeBlock = "```bash\necho 'hello <world> & all'\n```";
      expect(markdownToTelegramHtml(codeBlock)).toBe(
        '<pre><code class="language-bash">echo \'hello &lt;world&gt; &amp; all\'</code></pre>',
      );
    });

    it("preserves emojis and converts links and headings", () => {
      const input = "### Hasil Task 🚀\nSilakan cek [website](https://example.com) ✨";
      const result = markdownToTelegramHtml(input);
      expect(result).toContain("<b>Hasil Task 🚀</b>");
      expect(result).toContain('<a href="https://example.com">website</a>');
      expect(result).toContain("✨");
    });

    it("converts markdown tables to monospace preformatted box tables", () => {
      const input = [
        "Berikut hasil pemeriksaan:",
        "| Service | Status | Port |",
        "| --- | --- | --- |",
        "| Postgres | Active | 5432 |",
        "| Redis | Inactive | 6379 |",
        "Semua layanan terdeteksi.",
      ].join("\n");

      const result = markdownToTelegramHtml(input);
      expect(result).toContain("Berikut hasil pemeriksaan:");
      expect(result).toContain("<pre><code>┌─");
      expect(result).toContain("│ Service");
      expect(result).toContain("│ Postgres");
      expect(result).toContain("└─");
      expect(result).toContain("Semua layanan terdeteksi.");
    });

    it("does not emit unsupported <blockquote> tags", () => {
      const input = "> quote block\n> another line";
      const result = markdownToTelegramHtml(input);
      expect(result).not.toContain("<blockquote>");
      expect(result).toContain("&gt; quote block");
      expect(result).toContain("&gt; another line");
    });

    it("strips unsupported control characters and zero-width chars", () => {
      const input = "normal\x00\x01\x02\x7f\u200btext";
      const result = markdownToTelegramHtml(input);
      expect(result).toBe("normaltext");
    });
  });

  describe("formatMarkdownTable", () => {
    it("converts standard markdown table to box-drawing monospace table", () => {
      const md = [
        "| Name | Age | City |",
        "| --- | :---: | ---: |",
        "| Alice | 30 | Jakarta |",
        "| Bob | 25 | Bandung |",
      ].join("\n");

      const table = formatMarkdownTable(md);
      const lines = table.split("\n");
      expect(lines).toHaveLength(6);
      expect(lines[0]).toMatch(/^┌─.+─┐$/);
      expect(lines[1]).toContain("Name");
      expect(lines[2]).toMatch(/^├─.+─┤$/);
      expect(lines[3]).toContain("Alice");
      expect(lines[4]).toContain("Bob");
      expect(lines[5]).toMatch(/^└─.+─┘$/);
    });

    it("handles escaped pipes inside cells correctly", () => {
      const md = [
        "| Pattern | Meaning |",
        "| --- | --- |",
        "| a \\| b | OR condition |",
      ].join("\n");

      const table = formatMarkdownTable(md);
      expect(table).toContain("a | b");
      expect(table).toContain("OR condition");
    });

    it("returns original text if separator row is missing", () => {
      const invalid = "| Col1 | Col2 |\n| Val1 | Val2 |";
      expect(formatMarkdownTable(invalid)).toBe(invalid);
    });

    it("returns original text for non-table strings", () => {
      expect(formatMarkdownTable("just plain text")).toBe("just plain text");
    });
  });
});

