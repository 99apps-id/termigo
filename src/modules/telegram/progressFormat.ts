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
  completed?: boolean;
};

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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
 * Converts CommonMark / GitHub Markdown to Telegram-compatible HTML formatting:
 * - **bold** -> <b>bold</b>
 * - *italic* or _italic_ -> <i>italic</i>
 * - __underline__ -> <u>underline</u>
 * - ~~strikethrough~~ -> <s>strikethrough</s>
 * - `inline code` -> <code>inline code</code>
 * - ```code block``` -> <pre><code>code block</code></pre>
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

  // 4. Escape remaining HTML entities so raw <, >, & do not break Telegram parsing
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

export function formatLiveProgress(opts: FormatLiveProgressOptions): string {
  if (opts.completed) {
    return "**[Termigo Agent]** Finished.";
  }

  const lines: string[] = [];
  const statusLabel =
    opts.status === "awaiting-approval"
      ? "Waiting for approval..."
      : opts.status === "thinking"
        ? "Thinking..."
        : "Working...";

  const roundPart =
    typeof opts.round === "number" && opts.round >= 0
      ? ` (round ${opts.round + 1})`
      : "";
  lines.push(`**[Termigo Agent]** *${statusLabel}*${roundPart}`);

  if (opts.step) {
    lines.push(`Step: *${opts.step}*`);
  }

  // Display only the currently in-progress task; past/completed tasks disappear automatically
  const inProgressTodo = opts.todos?.find((t) => t.status === "in_progress");
  if (inProgressTodo) {
    lines.push(`Task: **${truncate(inProgressTodo.title, 60)}**`);
  }

  // Display only the currently running tool; past/completed tools disappear automatically
  const tools = opts.tools ?? [];
  const active = tools.filter(
    (t) => t.state === "running" || t.state === "awaiting-approval",
  );

  if (active.length > 0) {
    for (const t of active.slice(-1)) {
      const stateLabel =
        t.state === "awaiting-approval" ? "awaiting approval" : "running";
      lines.push(`Running: \`${t.toolName}\` [${stateLabel}]`);
      if (t.input) {
        lines.push(`\`${t.input}\``);
      }
    }
  }

  return lines.join("\n");
}
