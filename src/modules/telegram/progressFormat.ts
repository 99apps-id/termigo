/**
 * Utilities for formatting compact, anti-spam progress updates and tool execution
 * summaries for Telegram bot relay messages.
 */

export type ToolCallState = "running" | "done" | "error" | "awaiting-approval";

export type ToolCallSummary = {
  toolName: string;
  state: ToolCallState;
  input: string;
  output?: string;
};

export type FormatLiveProgressOptions = {
  status: string;
  round?: number;
  step?: string | null;
  tools?: ToolCallSummary[];
  todos?: { title: string; status: string }[];
  /** Elapsed time in ms since the run started. Rendered as a ticking "· Xs"
   *  counter so the progress text always changes even when no new tool/step
   *  has appeared — this keeps the Telegram message visibly alive during long
   *  waits instead of freezing. */
  elapsedMs?: number;
  completed?: boolean;
  mode?: "question" | "task";
  modelLabel?: string;
};

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function resolveModelLabel(modelId?: string): string {
  if (!modelId) return "";
  try {
    const { MODELS, isCompatModelId, compatModelIdForEndpoint } = require("../ai/config");
    if (MODELS.some((m: any) => m.id === modelId)) {
      const m = MODELS.find((m: any) => m.id === modelId);
      return [m.provider, m.id].filter(Boolean).join(" ");
    }
    if (isCompatModelId(modelId)) {
      const eid = compatModelIdForEndpoint(modelId);
      const custom = (require("../settings/preferences").usePreferencesStore?.getState?.()?.customEndpoints ?? []).find((ep: any) => ep.id === eid);
      const name = custom?.name || custom?.provider || "";
      const mid = custom?.modelId || "";
      return [name, mid].filter(Boolean).join(" ") || modelId;
    }
  } catch {
    // fallback: return raw id
  }
  return modelId;
}

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

export function summarizeToolInput(
  toolName: string,
  input: unknown,
  maxLen = 80,
): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;

  if (
    toolName === "bash_run" ||
    toolName === "bash_background" ||
    toolName === "run_checks"
  ) {
    const cmd = typeof obj.command === "string" ? obj.command : "";
    return truncate(collapseWhitespace(cmd), maxLen);
  }

  if (
    toolName === "read_file" ||
    toolName === "write_file" ||
    toolName === "delete_file" ||
    toolName === "list_directory" ||
    toolName === "edit" ||
    toolName === "multi_edit"
  ) {
    const path = typeof obj.path === "string" ? obj.path : "";
    return truncate(collapseWhitespace(path), maxLen);
  }

  if (toolName === "move_file") {
    const from = typeof obj.from === "string" ? obj.from : "";
    const to = typeof obj.to === "string" ? obj.to : "";
    return truncate(collapseWhitespace(`${from} -> ${to}`), maxLen);
  }

  if (toolName === "copy_file") {
    const src = typeof obj.source === "string" ? obj.source : "";
    const dest = typeof obj.dest_dir === "string" ? obj.dest_dir : "";
    return truncate(collapseWhitespace(`${src} -> ${dest}`), maxLen);
  }

  if (toolName === "search" || toolName === "grep" || toolName === "glob") {
    const pattern =
      typeof obj.pattern === "string"
        ? obj.pattern
        : typeof obj.query === "string"
          ? obj.query
          : "";
    return truncate(collapseWhitespace(pattern), maxLen);
  }

  if (toolName === "env_get") {
    const name = typeof obj.name === "string" ? obj.name : "";
    return truncate(collapseWhitespace(name), maxLen);
  }

  if (toolName === "ask_user") {
    const q = typeof obj.question === "string" ? obj.question : "";
    return truncate(collapseWhitespace(q), maxLen);
  }

  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.trim()) {
      return truncate(collapseWhitespace(`${k}: ${v}`), maxLen);
    }
  }

  return "";
}

export function summarizeToolOutput(
  toolName: string,
  output: unknown,
  maxLen = 120,
): string {
  if (output === null || output === undefined) return "";
  if (typeof output === "string") {
    return truncate(collapseWhitespace(output), maxLen);
  }
  if (typeof output !== "object") {
    return truncate(String(output), maxLen);
  }

  const obj = output as Record<string, unknown>;

  if (typeof obj.error === "string" && obj.error.trim()) {
    return truncate(`error: ${collapseWhitespace(obj.error)}`, maxLen);
  }

  if (toolName === "bash_run" || toolName === "bash_background") {
    const exitCode = typeof obj.exit_code === "number" ? obj.exit_code : 0;
    const stderr =
      typeof obj.stderr === "string" ? collapseWhitespace(obj.stderr) : "";
    const stdout =
      typeof obj.stdout === "string" ? collapseWhitespace(obj.stdout) : "";
    const info =
      typeof obj.info === "string" ? collapseWhitespace(obj.info) : "";

    if (exitCode !== 0 && stderr) {
      return truncate(`exit ${exitCode}: ${stderr}`, maxLen);
    }
    if (info) return truncate(info, maxLen);
    if (stdout) {
      const codePrefix = exitCode !== 0 ? `exit ${exitCode}: ` : "";
      return truncate(`${codePrefix}${stdout}`, maxLen);
    }
    return `exit ${exitCode}`;
  }

  if (Array.isArray(obj.entries)) {
    return `${obj.entries.length} entries`;
  }

  if (typeof obj.bytesWritten === "number") {
    return `${obj.bytesWritten} bytes written`;
  }

  if (typeof obj.lines_returned === "number") {
    return `${obj.lines_returned} lines read`;
  }

  if (obj.unchanged === true) {
    return "unchanged";
  }

  if (obj.deleted === true) {
    return "deleted";
  }

  if (obj.moved === true) {
    return "moved";
  }

  if (obj.copied === true) {
    return "copied";
  }

  if (typeof obj.summary === "string" && obj.summary.trim()) {
    return truncate(collapseWhitespace(obj.summary), maxLen);
  }

  return "";
}

export function extractToolSummaries(parts: unknown[]): ToolCallSummary[] {
  const summaries: ToolCallSummary[] = [];

  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const part = p as Record<string, unknown>;
    const type = typeof part.type === "string" ? part.type : "";

    let toolName = "";
    if (type.startsWith("tool-")) {
      toolName = type.slice(5);
    } else if (type === "tool" || type === "tool-call") {
      toolName = typeof part.toolName === "string" ? part.toolName : "";
    }

    if (!toolName) continue;

    const rawState = typeof part.state === "string" ? part.state : "";
    let state: ToolCallState = "running";

    if (rawState === "approval-requested") {
      state = "awaiting-approval";
    } else if (rawState === "output-available") {
      const out = part.output as Record<string, unknown> | undefined;
      state = out && typeof out.error === "string" ? "error" : "done";
    }

    const input = summarizeToolInput(toolName, part.input);
    const output = summarizeToolOutput(toolName, part.output);

    summaries.push({
      toolName,
      state,
      input,
      ...(output ? { output } : {}),
    });
  }

  return summaries;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Formats a Markdown table into an aligned, monospace text table suitable
 * for Telegram's <pre> blocks.
 */
export function formatMarkdownTable(markdownTable: string): string {
  const lines = markdownTable
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return markdownTable;

  const parseRow = (line: string): string[] => {
    let row = line;
    if (row.startsWith("|")) row = row.slice(1);
    if (row.endsWith("|")) row = row.slice(0, -1);
    return row
      .replace(/\\\|/g, "\x00PIPE\x00")
      .split("|")
      .map((c) => c.replace(/\x00PIPE\x00/g, "|").trim());
  };

  const rows = lines.map(parseRow);
  if (rows.length < 2) return markdownTable;

  // Verify the second row is a separator line (e.g. ---, :---:, etc.)
  const isSeparator = rows[1].every((c) => /^:?-+:?$/.test(c));
  if (!isSeparator) return markdownTable;

  const header = rows[0];
  const dataRows = rows.slice(2);
  const colCount = Math.max(
    ...rows.filter((_, idx) => idx !== 1).map((r) => r.length),
  );

  // Calculate maximum visible length per column
  const colWidths: number[] = Array(colCount).fill(0);
  for (let c = 0; c < colCount; c++) {
    colWidths[c] = (header[c] ?? "").length;
    for (const r of dataRows) {
      colWidths[c] = Math.max(colWidths[c], (r[c] ?? "").length);
    }
    colWidths[c] = Math.max(colWidths[c], 3);
  }

  const pad = (str: string, len: number) =>
    str + " ".repeat(Math.max(0, len - str.length));

  const topBorder =
    "┌─" + colWidths.map((w) => "─".repeat(w)).join("─┬─") + "─┐";
  const headerLine =
    "│ " +
    colWidths.map((_, i) => pad(header[i] ?? "", colWidths[i])).join(" │ ") +
    " │";
  const midBorder =
    "├─" + colWidths.map((w) => "─".repeat(w)).join("─┼─") + "─┤";
  const dataLines = dataRows.map(
    (r) =>
      "│ " +
      colWidths.map((_, i) => pad(r[i] ?? "", colWidths[i])).join(" │ ") +
      " │",
  );
  const botBorder =
    "└─" + colWidths.map((w) => "─".repeat(w)).join("─┴─") + "─┘";

  return [topBorder, headerLine, midBorder, ...dataLines, botBorder].join("\n");
}

/**
 * Converts CommonMark / GitHub Markdown to Telegram-compatible HTML formatting:
 * - **bold** -> <b>bold</b>
 * - *italic* or _italic_ -> <i>italic</i>
 * - __underline__ -> <u>underline</u>
 * - ~~strikethrough~~ -> <s>strikethrough</s>
 * - `inline code` -> <code>inline code</code>
 * - ```code block``` -> <pre><code>code block</code></pre>
 * - Markdown tables -> clean monospace box tables inside <pre><code>...</code></pre>
 * - [link](url) -> <a href="url">link</a>
 * - Unicode emojis pass through natively
 */
export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return "";

  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // 1. Extract fenced code blocks: ```lang\ncode\n```
  let text = markdown.replace(
    /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)\r?\n```/g,
    (_, lang, code) => {
      const idx = codeBlocks.length;
      const escaped = escapeHtml(code);
      const html = lang
        ? `<pre><code class="language-${lang}">${escaped}</code></pre>`
        : `<pre><code>${escaped}</code></pre>`;
      codeBlocks.push(html);
      return `\x00CB_${idx}\x00`;
    },
  );

  // 2. Extract non-newline code blocks: ```code```
  text = text.replace(/```([\s\S]*?)```/g, (_, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
    return `\x00CB_${idx}\x00`;
  });

  // 3. Extract inline code: `code`
  text = text.replace(/`([^`\r\n]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00IC_${idx}\x00`;
  });

  // 4. Extract and format markdown tables into preformatted code blocks
  text = text.replace(
    /(?:^|\n)((?:\|[^\r\n]+\|\r?\n?)+)/g,
    (fullMatch, tableBlock: string) => {
      const formatted = formatMarkdownTable(tableBlock);
      if (formatted !== tableBlock) {
        const idx = codeBlocks.length;
        const escaped = escapeHtml(formatted);
        codeBlocks.push(`<pre><code>${escaped}</code></pre>`);
        return `\n\x00CB_${idx}\x00\n`;
      }
      return fullMatch;
    },
  );

  // 5. Escape remaining HTML entities so raw <, >, & do not break Telegram parsing
  text = escapeHtml(text);

  // 5. Allow explicit user HTML tags: <b>, <i>, <u>, <s>, <code>, <pre>, <blockquote>
  text = text.replace(
    /&lt;(\/)?(b|i|u|s|code|pre|blockquote)&gt;/gi,
    "<$1$2>",
  );

  // 6. Headings (# Title) -> <b>Title</b>
  text = text.replace(/^(#{1,6})\s+(.+)$/gm, "<b>$2</b>");

  // 7. Bold + Italic: ***text***
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");

  // 8. Bold: **text**
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // 9. Underline: __text__
  text = text.replace(/__(.+?)__/g, "<u>$1</u>");

  // 10. Italic: *text* (avoiding remaining single asterisks)
  text = text.replace(/(?<!\*)\*([^*\r\n]+?)\*(?!\*)/g, "<i>$1</i>");

  // 11. Italic: _text_ (only when surrounded by whitespace or punctuation, to avoid snake_case)
  text = text.replace(
    /(?<=^|[\s(\[{])_([^_ \r\n][^_\r\n]*?[^_ \r\n]|\S)_(?=[)\]}\s.,:;!?]|$)/gm,
    "<i>$1</i>",
  );

  // 12. Strikethrough: ~~text~~
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 13. Links: [label](url)
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g,
    '<a href="$2">$1</a>',
  );

  // 14. Blockquotes: > quote
  text = text.replace(/^&gt;\s+(.+)$/gm, "<blockquote>$1</blockquote>");

  // 15. Restore inline code and code blocks
  text = text.replace(
    /\x00IC_(\d+)\x00/g,
    (_, idx) => inlineCodes[Number(idx)] ?? "",
  );
  text = text.replace(
    /\x00CB_(\d+)\x00/g,
    (_, idx) => codeBlocks[Number(idx)] ?? "",
  );

  return text;
}

export function getToolDoneVerb(toolName: string): string {
  switch (toolName) {
    case "bash_run":
    case "bash_background":
    case "run_checks":
    case "terminal_run":
      return "Ran";
    case "read_file":
    case "read_image":
      return "Read";
    case "fetch":
    case "web_fetch":
      return "Fetched";
    case "web_search":
      return "Searched";
    case "write_file":
      return "Wrote";
    case "edit":
    case "multi_edit":
    case "replace":
      return "Edited";
    case "glob":
      return "Globbed";
    case "list_directory":
      return "Listed";
    case "grep":
    case "search":
    case "code_search":
      return "Searched";
    case "delete_file":
      return "Deleted";
    case "move_file":
      return "Moved";
    case "copy_file":
      return "Copied";
    case "generate_image":
      return "Generated image";
    case "run_subagent":
    case "run_subagents":
      return "Delegated";
    default:
      return `Executed ${toolName}`;
  }
}

export function getToolRunningVerb(toolName: string): string {
  switch (toolName) {
    case "bash_run":
    case "bash_background":
    case "run_checks":
    case "terminal_run":
      return "Running";
    case "read_file":
    case "read_image":
      return "Reading";
    case "fetch":
    case "web_fetch":
      return "Fetching";
    case "web_search":
      return "Searching";
    case "write_file":
      return "Writing";
    case "edit":
    case "multi_edit":
    case "replace":
      return "Editing";
    case "glob":
      return "Globbing";
    case "list_directory":
      return "Listing";
    case "grep":
    case "search":
    case "code_search":
      return "Searching";
    case "generate_image":
      return "Generating image";
    case "run_subagent":
    case "run_subagents":
      return "Delegating to subagent";
    default:
      return `Running ${toolName}`;
  }
}

export function formatToolActivity(t: ToolCallSummary): string {
  const { toolName, state, input, output } = t;
  const inputSnippet = input ? ` \`${truncate(input, 60)}\`` : "";
  const outSnippet = output ? ` -> _${truncate(output, 50)}_` : "";

  if (state === "running") {
    const verb = getToolRunningVerb(toolName);
    return `⚡ ${verb}${inputSnippet}`;
  }
  if (state === "awaiting-approval") {
    return `🔒 Approval required: \`${toolName}\`${inputSnippet}`;
  }
  if (state === "error") {
    return `❌ Failed: \`${toolName}\`${inputSnippet}${outSnippet}`;
  }
  // state === "done"
  const verb = getToolDoneVerb(toolName);
  return `✓ ${verb}${inputSnippet}${outSnippet}`;
}

export function formatLiveProgress(opts: FormatLiveProgressOptions): string {
  if (opts.completed) {
    return "**[Termigo Agent]** Selesai.";
  }

  if (opts.mode === "question") {
    return "";
  }

  const lines: string[] = [];
  const statusLabel =
    opts.status === "awaiting-approval"
      ? "Menunggu persetujuan..."
      : opts.status === "thinking"
        ? "Merencanakan..."
        : opts.status === "streaming"
          ? "Menulis jawaban..."
          : "Sedang mengerjakan...";

  const elapsedPart =
    typeof opts.elapsedMs === "number"
      ? ` · ${Math.floor(opts.elapsedMs / 1000)}s`
      : "";

  const stepPart =
    typeof opts.round === "number" && opts.round >= 0
      ? ` (langkah ${opts.round + 1})`
      : "";

  const modelPart = opts.modelLabel ? ` • ${opts.modelLabel}` : "";

  lines.push(
    `**[Termigo Agent]** *${statusLabel}*${stepPart}${modelPart}${elapsedPart}`,
  );

  if (opts.step) {
    lines.push(`*${truncate(opts.step, 120)}*`);
  }

  const inProgressTodo = opts.todos?.find((t) => t.status === "in_progress");
  if (inProgressTodo) {
    lines.push(`🔹 ${truncate(inProgressTodo.title, 100)}`);
  }

  const tools = opts.tools ?? [];
  if (tools.length > 0) {
    const active = tools.filter(
      (t) => t.state === "running" || t.state === "awaiting-approval",
    );
    const recentDone = tools
      .filter((t) => t.state === "done" || t.state === "error")
      .slice(-2);

    for (const t of recentDone) {
      const verb = getToolDoneVerb(t.toolName);
      const snippet = t.input ? ` \`${truncate(t.input, 40)}\`` : "";
      const out = t.output ? ` → _${truncate(t.output, 50)}_` : "";
      lines.push(`✓ ${verb}${snippet}${out}`);
    }

    for (const t of active.slice(-1)) {
      const verb = getToolRunningVerb(t.toolName);
      const snippet = t.input ? ` \`${truncate(t.input, 40)}\`` : "";
      lines.push(`⚡ ${verb}${snippet}`);
    }
  }

  return lines.join("\n");
}
