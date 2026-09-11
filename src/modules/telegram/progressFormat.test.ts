import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  extractToolSummaries,
  formatLiveProgress,
  formatMarkdownTable,
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
    it("formats completed state cleanly", () => {
      const text = formatLiveProgress({ status: "idle", completed: true });
      expect(text).toBe("**[Termigo Agent]** Completed.");
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

