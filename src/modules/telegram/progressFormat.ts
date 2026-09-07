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

export function formatLiveProgress(opts: FormatLiveProgressOptions): string {
  if (opts.completed) {
    return "[Termigo Agent] Finished.";
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
  lines.push(`[Termigo Agent] Status: ${statusLabel}${roundPart}`);

  if (opts.step) {
    lines.push(`Step: ${opts.step}`);
  }

  const tools = opts.tools ?? [];
  if (tools.length > 0) {
    const active = tools.filter(
      (t) => t.state === "running" || t.state === "awaiting-approval",
    );
    const recentCompleted = tools
      .filter((t) => t.state === "done" || t.state === "error")
      .slice(-2);

    if (active.length > 0) {
      lines.push("");
      lines.push("Active:");
      for (const t of active.slice(-1)) {
        lines.push(`* ${t.toolName} [${t.state}]`);
        if (t.input) lines.push(`  in: ${t.input}`);
      }
    }

    if (recentCompleted.length > 0) {
      lines.push("");
      lines.push("Recent:");
      for (const t of recentCompleted) {
        lines.push(`- ${t.toolName} [${t.state}]`);
        if (t.input) lines.push(`  in: ${t.input}`);
        if (t.output) lines.push(`  out: ${t.output}`);
      }
    }
  }

  if (opts.todos && opts.todos.length > 0) {
    lines.push("");
    lines.push("Todo:");
    for (const t of opts.todos.slice(0, 5)) {
      lines.push(`- [${t.status}] ${truncate(t.title, 40)}`);
    }
  }

  return lines.join("\n");
}
