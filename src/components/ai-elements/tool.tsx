"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  ArrowRight01Icon,
  CheckListIcon,
  Edit02Icon,
  EyeIcon,
  File01Icon,
  FileEditIcon,
  FilePlusIcon,
  Folder01Icon,
  FolderAddIcon,
  FolderOpenIcon,
  GlobalSearchIcon,
  RobotIcon,
  SparklesIcon,
  TerminalIcon,
  ToolsIcon,
} from "@hugeicons/core-free-icons";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { native } from "@/modules/ai/lib/native";
import {
  useSubagentRunStore,
  type SubagentRun,
} from "@/modules/ai/store/subagentRunStore";
import { resolveSubagentLabel, resolveSubagentType } from "@/modules/ai/agents/resolveSubagent";
import { Spinner } from "@/components/ui/spinner";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, memo, useEffect, useMemo, useRef, useState } from "react";
import { isMcpTool, parseMcpToolName } from "@/modules/ai/lib/mcpToolNames";
import { Shimmer } from "./shimmer";

export type ToolPart = ToolUIPart | DynamicToolUIPart;

// Present tense (shown while the tool runs, with a shimmer) and past tense
// (shown once it is done, static) - VS Code-style "Running..." -> "Ran".
type ToolMeta = { present: string; past: string; icon: typeof File01Icon };
const TOOL_META: Record<string, ToolMeta> = {
  read_file: { present: "Reading", past: "Read", icon: File01Icon },
  list_directory: { present: "Listing", past: "Listed", icon: FolderOpenIcon },
  write_file: { present: "Writing", past: "Wrote", icon: FilePlusIcon },
  create_directory: {
    present: "Creating",
    past: "Created",
    icon: FolderAddIcon,
  },
  edit: { present: "Editing", past: "Edited", icon: FileEditIcon },
  multi_edit: { present: "Editing", past: "Edited", icon: Edit02Icon },
  bash_run: { present: "Running", past: "Ran", icon: TerminalIcon },
  bash_background: { present: "Spawning", past: "Spawned", icon: TerminalIcon },
  bash_logs: { present: "Reading logs", past: "Read logs", icon: TerminalIcon },
  bash_list: { present: "Listing jobs", past: "Listed jobs", icon: TerminalIcon },
  bash_kill: { present: "Stopping", past: "Stopped", icon: TerminalIcon },
  grep: { present: "Searching", past: "Searched", icon: GlobalSearchIcon },
  glob: { present: "Globbing", past: "Globbed", icon: Folder01Icon },
  suggest_command: { present: "Suggesting", past: "Suggested", icon: SparklesIcon },
  open_preview: { present: "Opening", past: "Opened", icon: EyeIcon },
  preview_file: { present: "Previewing", past: "Previewed", icon: EyeIcon },
  render_view: { present: "Rendering", past: "Rendered", icon: EyeIcon },
  run_subagent: { present: "Delegating", past: "Finished", icon: RobotIcon },
  todo_write: { present: "Updating plan", past: "Updated plan", icon: CheckListIcon },
  run_sql: { present: "Running SQL", past: "Ran SQL", icon: TerminalIcon },
  list_sql_connections: {
    present: "Listing DBs",
    past: "Listed DBs",
    icon: FolderOpenIcon,
  },
};

/** Title-cased tool name as a last-resort present-tense label (MCP / extension /
 *  custom tools that have no entry above). */
function fallbackPresent(toolName: string): string {
  if (isMcpTool(toolName)) {
    const parsed = parseMcpToolName(toolName);
    if (parsed) {
      return `MCP: ${parsed.server} / ${parsed.tool}`;
    }
  }
  const words = toolName.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : toolName;
}

const STATUS_DOT: Record<ToolPart["state"], string> = {
  "approval-requested": "bg-amber-500",
  "approval-responded": "bg-sky-500",
  "input-streaming": "bg-muted-foreground/40",
  "input-available": "bg-amber-500",
  "output-available": "bg-transparent border border-muted-foreground/40",
  "output-denied": "bg-orange-500",
  "output-error": "bg-destructive",
};

const STATUS_LABEL: Record<ToolPart["state"], string> = {
  "approval-requested": "awaiting approval",
  "approval-responded": "responded",
  "input-streaming": "preparing",
  "input-available": "running",
  "output-available": "done",
  "output-denied": "denied",
  "output-error": "error",
};

function deriveSummary(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const str = (k: string) =>
    typeof i[k] === "string" ? (i[k] as string) : null;

  switch (toolName) {
    case "read_file":
    case "write_file":
    case "edit":
    case "multi_edit":
    case "create_directory":
    case "list_directory":
      return str("path");
    case "bash_run":
    case "bash_background":
      return str("command");
    case "bash_logs":
    case "bash_kill":
      return str("id");
    case "grep":
      return str("pattern") ?? str("query");
    case "glob":
      return str("pattern");
    case "suggest_command":
      return str("intent") ?? str("description");
    case "open_preview":
      return str("path") ?? str("url");
    case "run_subagent":
      return str("agent") ?? str("task");
    case "todo_write": {
      const items = Array.isArray(i.todos) ? i.todos : null;
      return items
        ? `${items.length} item${items.length === 1 ? "" : "s"}`
        : null;
    }
    case "run_sql":
      return str("query") ?? str("connection");
    case "list_sql_connections":
      return "Saved database connections";
    default: {
      if (isMcpTool(toolName)) {
        const parsed = parseMcpToolName(toolName);
        const arg =
          str("query") ??
          str("path") ??
          str("url") ??
          str("command") ??
          str("prompt") ??
          str("message");
        if (parsed && arg) return `${parsed.server}: ${arg}`;
        if (parsed) return parsed.tool;
      }
      return null;
    }
  }
}

type ModifiedFile = {
  path: string;
  kind: "edited" | "created" | "deleted" | "moved";
};

/**
 * Derive the files a mutating tool changed from its result output, so the tool
 * card can surface a "Modified files" chip row (BatikCode parity). The edit /
 * write / fileops tools all return an object carrying a `path` (or from/to for
 * a move) plus an `ok`/`moved`/`deleted`/`created` flag - this reads that shape
 * and normalises it to one entry per touched file.
 */
function modifiedFilesFromOutput(
  toolName: string,
  output: unknown,
): ModifiedFile[] {
  if (!output || typeof output !== "object") return [];
  const o = output as Record<string, unknown>;
  const hasError =
    typeof o.error === "string" ||
    typeof o.binary === "string" ||
    typeof o.safety === "string";
  if (hasError) return [];

  const path = typeof o.path === "string" ? o.path : null;
  const list: ModifiedFile[] = [];
  switch (toolName) {
    case "write_file":
    case "edit":
    case "multi_edit":
      if (path) list.push({ path, kind: "edited" });
      break;
    case "create_directory":
      if (path) list.push({ path, kind: "created" });
      break;
    case "move":
      if (typeof o.to === "string" && o.moved === true)
        list.push({ path: o.to, kind: "moved" });
      break;
    case "delete":
      if (o.deleted === true && path) list.push({ path, kind: "deleted" });
      break;
    default:
      return [];
  }
  return list;
}

const MODIFIED_KIND_LABEL: Record<ModifiedFile["kind"], string> = {
  edited: "edited",
  created: "created",
  deleted: "deleted",
  moved: "moved",
};

function ModifiedFilesChips({ files }: { files: ModifiedFile[] }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium text-muted-foreground">
        Modified files
      </div>
      <div className="flex flex-wrap gap-1">
        {files.map((f, i) => (
          <span
            key={`${f.path}-${i}`}
            className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-600 dark:text-emerald-400"
          >
            <span className="text-[9px] font-semibold uppercase">
              {MODIFIED_KIND_LABEL[f.kind]}
            </span>
            <span className="truncate max-w-64">{f.path}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export type ToolProps = ComponentProps<typeof Collapsible> & {
  toolName: string;
  state: ToolPart["state"];
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

// Tools whose `input` carries large/streaming content (file bodies, sub-
// agent prompts, todo lists). The AI diff tab is the canonical place to
// view file changes; for the rest, the header summary + final output is
// enough. Re-rendering streamed input on every token both stalls the UI
// and duplicates information.
const HEAVY_CONTENT_TOOLS = new Set([
  "write_file",
  "edit",
  "multi_edit",
  "run_subagent",
  "todo_write",
]);

const ToolImpl = ({
  className,
  toolName,
  state,
  input,
  output,
  errorText,
  defaultOpen,
  ...props
}: ToolProps) => {
  const meta = TOOL_META[toolName];
  const Icon = meta?.icon ?? ToolsIcon;
  // Present/past + shimmer, VS Code-style. While the tool is preparing or
  // running the label shimmers in the present tense ("Running…"); once it has
  // finished it is static and past tense ("Ran"). A pending approval reads as
  // "1 confirmation pending" and shimmers until the user answers.
  const pendingApproval = state === "approval-requested";
  const inProgress =
    state === "input-streaming" ||
    state === "input-available" ||
    state === "approval-responded";
  const busyLabel = pendingApproval || inProgress;
  const label = pendingApproval
    ? "1 confirmation pending"
    : inProgress
      ? (meta?.present ?? fallbackPresent(toolName))
      : state === "output-denied"
        ? "Denied"
        : (meta?.past ?? "Finished");
  const summary = deriveSummary(toolName, input);
  const isError = state === "output-error";
  const isSubagent = toolName === "run_subagent" || toolName === "run_subagents";
  // Subagent cards open by default so the live fan-out progress is visible.
  const open = defaultOpen ?? (isError || isSubagent);
  const isHeavy = HEAVY_CONTENT_TOOLS.has(toolName);
  // Files this tool reports as modified (BatikCode "modified files" chips).
  const modifiedFiles = modifiedFilesFromOutput(toolName, output);
  // Edit tools are "heavy" (input carries file text), but their input preview is
  // a compact computed line-diff, not the raw streamed body - and the memo keys
  // heavy re-renders off the path summary, so it settles once at completion
  // rather than per token. Surface it so the card expands to an inline diff.
  const isEditDiff =
    (toolName === "edit" || toolName === "multi_edit") && Boolean(input);
  // For other heavy tools, only show details on error - never the streamed
  // input body, which is huge and re-renders per token.
  const showInputBody = (!isHeavy && Boolean(input)) || isEditDiff;
  const showOutputBody = !isHeavy && output !== undefined;
  const hasDetails =
    showInputBody ||
    showOutputBody ||
    Boolean(errorText) ||
    isSubagent ||
    modifiedFiles.length > 0;

  return (
    <Collapsible
      defaultOpen={open}
      className={cn("group/tool not-prose w-full", className)}
      {...props}
    >
      <CollapsibleTrigger
        disabled={!hasDetails}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
          "text-[12px] transition-colors",
          "hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        {state === "input-streaming" || state === "input-available" ? (
          // Granular status: a live spinner while the tool prepares / runs,
          // then the status dot once it settles (BatikCode parity).
          <Spinner className="size-3 shrink-0" />
        ) : (
          <span
            className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[state])}
            aria-label={STATUS_LABEL[state]}
          />
        )}
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        {busyLabel ? (
          <Shimmer
            as="span"
            duration={1}
            iterations="infinite"
            className={cn(
              "shrink-0 font-medium",
              pendingApproval ? "text-amber-600 dark:text-amber-400" : "text-foreground",
            )}
          >
            {label}
          </Shimmer>
        ) : (
          <span className="shrink-0 font-medium text-foreground">{label}</span>
        )}
        {summary ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {isError && (
          <span className="shrink-0 text-[10px] font-medium text-destructive">
            failed
          </span>
        )}
      </CollapsibleTrigger>

      {hasDetails && (
        <CollapsibleContent
          className={cn("termigo-collapsible-content")}
        >
          <div className="ml-3 mt-1 pb-1">
            {isSubagent ? (
              <div className="mb-2 border-l border-border/60 pl-3">
                <SubagentLiveDetails toolName={toolName} input={input} />
              </div>
            ) : null}
            {modifiedFiles.length > 0 ? (
              <div className="mb-2 border-l border-border/60 pl-3">
                <ModifiedFilesChips files={modifiedFiles} />
              </div>
            ) : null}
            {/* IN / OUT box, VS Code-style: a labelled gutter down the left of a
                single bordered card so the call's input and result read as one
                unit. */}
            {showInputBody || showOutputBody || errorText ? (
              <div className="overflow-hidden rounded-md border border-border/50">
                {showInputBody ? (
                  <GutterRow label="IN">
                    <ToolInput toolName={toolName} input={input} />
                  </GutterRow>
                ) : null}
                {showOutputBody || errorText ? (
                  <GutterRow label={errorText ? "ERR" : "OUT"} error={!!errorText}>
                    <ToolOutput
                      toolName={toolName}
                      output={showOutputBody ? output : undefined}
                      errorText={errorText}
                    />
                  </GutterRow>
                ) : null}
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
};

// For heavy tools, the only thing that should trigger a re-render is a
// state transition or the path summary changing - NOT every input-content
// token. We compare the cheap derived summary instead of the input ref.
export const Tool = memo(ToolImpl, (a, b) => {
  if (a.toolName !== b.toolName || a.state !== b.state) return false;
  if (a.errorText !== b.errorText) return false;
  if (a.output !== b.output) return false;
  if (a.className !== b.className) return false;
  if (HEAVY_CONTENT_TOOLS.has(a.toolName)) {
    return deriveSummary(a.toolName, a.input) ===
      deriveSummary(b.toolName, b.input);
  }
  return a.input === b.input;
});

/** One labelled row of the IN / OUT box: a small uppercase gutter label on the
 *  left, the content on the right, rows divided by a hairline. */
function GutterRow({
  label,
  error,
  children,
}: {
  label: string;
  error?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-2 border-b border-border/40 px-2 py-1.5 last:border-b-0">
      <span
        className={cn(
          "w-7 shrink-0 select-none pt-px font-mono text-[9px] font-semibold uppercase tracking-wider",
          error ? "text-destructive/80" : "text-muted-foreground/60",
        )}
      >
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function ToolInput({ toolName, input }: { toolName: string; input: unknown }) {
  if (input == null) return null;
  const preview = renderInputPreview(toolName, input);
  if (preview) return preview;
  return (
    <CodeBlockMini
      code={typeof input === "string" ? input : JSON.stringify(input, null, 2)}
      language="json"
    />
  );
}

function renderInputPreview(
  toolName: string,
  input: unknown,
): ReactNode | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const str = (k: string) =>
    typeof i[k] === "string" ? (i[k] as string) : null;

  if (toolName === "bash_run" || toolName === "bash_background") {
    const cmd = str("command");
    const cwd = str("cwd");
    if (!cmd) return null;
    return (
      <div className="space-y-1">
        {cwd ? (
          <div className="font-mono text-[10px] text-muted-foreground">
            {cwd}
          </div>
        ) : null}
        <pre className="overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
          {cmd}
        </pre>
      </div>
    );
  }
  if (
    toolName === "read_file" ||
    toolName === "list_directory" ||
    toolName === "create_directory" ||
    toolName === "open_preview"
  ) {
    const path = str("path") ?? str("url");
    if (!path) return null;
    return (
      <div className="font-mono text-[11px] text-muted-foreground">{path}</div>
    );
  }
  if (toolName === "grep") {
    const pat = str("pattern") ?? str("query");
    const path = str("path") ?? str("root");
    if (!pat) return null;
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-foreground">{pat}</div>
        {path ? <div className="text-muted-foreground">{path}</div> : null}
      </div>
    );
  }
  if (toolName === "edit" || toolName === "multi_edit") {
    const path = str("path");
    const edits: EditPair[] =
      toolName === "edit"
        ? [{ oldStr: str("old_string") ?? "", newStr: str("new_string") ?? "" }]
        : Array.isArray(i.edits)
          ? (i.edits as Array<Record<string, unknown>>).map((e) => ({
              oldStr: typeof e.old_string === "string" ? e.old_string : "",
              newStr: typeof e.new_string === "string" ? e.new_string : "",
            }))
          : [];
    if (edits.length === 0) return null;
    return <EditDiffPreview path={path} edits={edits} />;
  }
  return null;
}

type EditPair = { oldStr: string; newStr: string };
type DiffRow = { type: "del" | "add"; text: string };

// A minimal line diff: trim the common head/tail, then everything left in the
// middle is what actually changed - removed lines then added lines. Good enough
// to read an edit at a glance without pulling in a full Myers diff.
function lineDiff(oldStr: string, newStr: string): DiffRow[] {
  const a = oldStr.split("\n");
  const b = newStr.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let ea = a.length;
  let eb = b.length;
  while (ea > start && eb > start && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const rows: DiffRow[] = [];
  for (let i = start; i < ea; i++) rows.push({ type: "del", text: a[i] });
  for (let i = start; i < eb; i++) rows.push({ type: "add", text: b[i] });
  return rows;
}

const MAX_DIFF_ROWS = 40;

function EditDiffPreview({
  path,
  edits,
}: {
  path: string | null;
  edits: EditPair[];
}) {
  const rows: DiffRow[] = [];
  for (const e of edits) {
    if (rows.length >= MAX_DIFF_ROWS) break;
    rows.push(...lineDiff(e.oldStr, e.newStr));
  }
  const shown = rows.slice(0, MAX_DIFF_ROWS);
  const overflow = rows.length - shown.length;

  return (
    <div className="space-y-1">
      {path ? (
        <div className="truncate font-mono text-[10px] text-muted-foreground">
          {path}
        </div>
      ) : null}
      <div className="overflow-auto rounded border border-border/40 font-mono text-[11px] leading-relaxed">
        {shown.map((r, idx) => (
          <div
            key={`${r.type}-${idx}-${r.text.slice(0, 24)}`}
            className={cn(
              "flex gap-1.5 whitespace-pre px-2",
              r.type === "del"
                ? "bg-destructive/10 text-destructive"
                : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
            )}
          >
            <span className="select-none opacity-60">
              {r.type === "del" ? "−" : "+"}
            </span>
            <span className="min-w-0 flex-1">{r.text || " "}</span>
          </div>
        ))}
      </div>
      {overflow > 0 ? (
        <div className="text-[10px] text-muted-foreground">
          +{overflow} more changed line{overflow === 1 ? "" : "s"}
        </div>
      ) : null}
    </div>
  );
}

function ToolOutput({
  toolName,
  output,
  errorText,
}: {
  toolName: string;
  output: unknown;
  errorText?: string;
}) {
  if (errorText) {
    return (
      <div className="font-mono text-[11px] text-destructive whitespace-pre-wrap">
        {errorText}
      </div>
    );
  }
  if (output === undefined || output === null) return null;

  const custom = renderToolOutput(toolName, output);
  if (custom) return custom;

  let body: ReactNode;
  if (typeof output === "string") {
    body = <CodeBlockMini code={output} language="text" />;
  } else if (typeof output === "object" && !isValidElement(output)) {
    body = (
      <CodeBlockMini code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else {
    body = <div className="text-[12px]">{output as ReactNode}</div>;
  }

  return body;
}

function renderToolOutput(toolName: string, output: unknown): ReactNode | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;

  if (toolName === "run_sql" && typeof o.output === "string") {
    return <CodeBlockMini code={o.output} language="sql" />;
  }

  if (isMcpTool(toolName) && Array.isArray(o.content)) {
    const textBlocks = o.content
      .filter(
        (c: unknown) =>
          typeof c === "object" &&
          c !== null &&
          (c as { type?: string }).type === "text" &&
          typeof (c as { text?: string }).text === "string",
      )
      .map((c: unknown) => (c as { text: string }).text);
    if (textBlocks.length > 0) {
      return <CodeBlockMini code={textBlocks.join("\n\n")} language="text" />;
    }
  }

  if (toolName === "browser_screenshot" && o.kind === "screenshot") {
    if (typeof o.data !== "string") return null;
    const mediaType = typeof o.mediaType === "string" ? o.mediaType : "image/png";
    return (
      <div className="space-y-1">
        {/* biome-ignore lint/nursery/noImgElement: local data URI, no next/image here */}
        <img
          src={`data:${mediaType};base64,${o.data}`}
          alt="browser screenshot"
          className="max-h-64 max-w-full rounded border border-border/40 object-contain"
        />
      </div>
    );
  }

  if (toolName === "read_file") {
    const path = typeof o.path === "string" ? o.path : "";
    const size = typeof o.size === "number" ? o.size : null;
    // Image reads carry the picture back for a vision model - show it.
    if (o.kind === "image" && typeof o.data === "string") {
      const mediaType =
        typeof o.mediaType === "string" ? o.mediaType : "image/png";
      return (
        <div className="space-y-1">
          {path ? (
            <div className="truncate font-mono text-[10px] text-muted-foreground">
              {path}
              {size != null ? ` · ${formatBytes(size)}` : ""}
            </div>
          ) : null}
          {/* biome-ignore lint/nursery/noImgElement: local data URI, no next/image here */}
          <img
            src={`data:${mediaType};base64,${o.data}`}
            alt={path || "image"}
            className="max-h-64 max-w-full rounded border border-border/40 object-contain"
          />
        </div>
      );
    }
    const content = typeof o.content === "string" ? o.content : "";
    const lines = content ? content.split("\n").length : null;
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        <span className="text-foreground">read</span>
        {path ? <span className="text-muted-foreground">· {path}</span> : null}
        {lines != null ? (
          <span className="text-muted-foreground">
            ({lines} line{lines === 1 ? "" : "s"}
            {size != null ? `, ${formatBytes(size)}` : ""})
          </span>
        ) : null}
      </div>
    );
  }

  if (toolName === "list_directory") {
    const entries = Array.isArray(o.entries)
      ? (o.entries as Array<{ name: string; kind: string }>)
      : [];
    if (entries.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">empty</div>
      );
    }
    const dirs = entries.filter(
      (e) => e.kind === "directory" || e.kind === "dir",
    );
    const files = entries.filter(
      (e) => !(e.kind === "directory" || e.kind === "dir"),
    );
    return (
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[11px]">
        {dirs.map((e) => (
          <div
            key={`d-${e.name}`}
            className="flex items-center gap-1.5 truncate"
          >
            <HugeiconsIcon
              icon={FolderOpenIcon}
              size={11}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate text-foreground">{e.name}/</span>
          </div>
        ))}
        {files.map((e) => (
          <div
            key={`f-${e.name}`}
            className="flex items-center gap-1.5 truncate"
          >
            <HugeiconsIcon
              icon={File01Icon}
              size={11}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate text-muted-foreground">{e.name}</span>
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "bash_run") {
    return <BashRunOutput data={o} />;
  }

  if (toolName === "suggest_command") {
    const cmd = typeof o.command === "string" ? o.command : null;
    const explanation =
      typeof o.explanation === "string" ? o.explanation : null;
    if (!cmd) return null;
    return <SuggestCommandCard command={cmd} explanation={explanation} />;
  }

  if (toolName === "grep") {
    const hits = Array.isArray(o.hits)
      ? (o.hits as Array<{
          rel?: string;
          path?: string;
          line: number;
          text: string;
        }>)
      : [];
    const pattern = typeof o.pattern === "string" ? o.pattern : null;
    const truncated = Boolean(o.truncated);
    const filesScanned =
      typeof o.files_scanned === "number" ? o.files_scanned : null;

    if (hits.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">
          no matches
          {filesScanned != null ? ` · ${filesScanned} files scanned` : ""}
        </div>
      );
    }

    return (
      <div className="space-y-1">
        <div className="max-h-72 overflow-auto rounded bg-muted/30 font-mono text-[11px]">
          {hits.slice(0, 200).map((h, idx) => (
            <div
              key={`${h.rel ?? h.path}-${h.line}-${idx}`}
              className="flex gap-2 border-b border-border/30 px-2 py-1 last:border-b-0 hover:bg-muted/60"
            >
              <span className="shrink-0 text-muted-foreground">
                {h.rel ?? h.path}:{h.line}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground">
                {pattern ? highlightMatch(h.text, pattern) : h.text}
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>
            {hits.length} hit{hits.length === 1 ? "" : "s"}
            {filesScanned != null ? ` · ${filesScanned} files` : ""}
          </span>
          {truncated ? (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-400">
              truncated
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  if (toolName === "glob") {
    // glob returns `hits` - either bare path strings or `{ path }` objects
    // (grep and glob share `native.search`'s hit shape). Read the real key so
    // the result renders as a list instead of falling through to JSON.
    const raw = Array.isArray(o.hits)
      ? o.hits
      : Array.isArray(o.matches)
        ? o.matches
        : Array.isArray(o.paths)
          ? o.paths
          : [];
    const matches: string[] = raw.map((m) =>
      typeof m === "string" ? m : (m as { path?: string; rel?: string }).rel ?? (m as { path?: string }).path ?? String(m),
    );
    if (matches.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">
          no matches
        </div>
      );
    }
    return (
      <div className="max-h-60 overflow-auto rounded bg-muted/30 px-2 py-1 font-mono text-[11px]">
        {matches.slice(0, 300).map((p) => (
          <div key={p} className="truncate text-muted-foreground">
            {p}
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "edit" || toolName === "multi_edit") {
    const ok = o.ok === true || typeof o.replacements === "number";
    if (ok) {
      const reps = typeof o.replacements === "number" ? o.replacements : null;
      const path = typeof o.path === "string" ? o.path : "";
      return (
        <div className="flex items-center gap-1.5 font-mono text-[11px]">
          <span className="text-emerald-600 dark:text-emerald-400">✓</span>
          {reps != null ? (
            <span className="text-foreground">
              {reps} replacement{reps === 1 ? "" : "s"}
            </span>
          ) : null}
          {path ? (
            <span className="text-muted-foreground">· {path}</span>
          ) : null}
        </div>
      );
    }
  }

  if (toolName === "write_file" || toolName === "create_directory") {
    const path = typeof o.path === "string" ? o.path : "";
    const bytes = typeof o.bytesWritten === "number" ? o.bytesWritten : null;
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        <span className="text-foreground">
          {toolName === "create_directory" ? "created" : "wrote"}
        </span>
        {path ? <span className="text-muted-foreground">· {path}</span> : null}
        {bytes != null ? (
          <span className="text-muted-foreground">({formatBytes(bytes)})</span>
        ) : null}
      </div>
    );
  }

  if (toolName === "bash_background") {
    const handle = typeof o.handle === "number" ? o.handle : null;
    const cmd = typeof o.command === "string" ? o.command : "";
    if (handle == null) return null;
    return (
      <BashBackgroundLiveOutput handle={handle} command={cmd} />
    );
  }

  return null;
}

/**
 * Live view of a `bash_background` process. Polls the Rust ring-buffer
 * (`shell_bg_logs`) on a short interval and appends the new bytes, so a long
 * dev server / watcher / scan reads as a streaming terminal right in the tool
 * card (BatikCode `chatTerminalToolProgressPart` parity) instead of a handle
 * the user has to chase with `bash_logs`.
 */
function BashBackgroundLiveOutput({
  handle,
  command,
}: {
  handle: number;
  command: string;
}) {
  const [log, setLog] = useState("");
  const [running, setRunning] = useState(true);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [dropped, setDropped] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let alive = true;
    let offset = 0;
    const tick = async () => {
      try {
        const r = await native.shellBgLogs(handle, offset);
        if (!alive) return;
        offset = r.next_offset;
        if (r.bytes) {
          setLog((prev) => {
            const chunk = r.bytes.replace(/\n$/, "");
            const next = prev ? `${prev}\n${chunk}` : chunk;
            // Incremental rendering: a long-lived process can push hundreds of
            // KB/min into the 4MB ring buffer; keep only the tail so the DOM
            // node never balloons and the card stays smooth (BatikCode
            // `chatIncrementalRendering` parity).
            return next.length > 64_000 ? next.slice(next.length - 64_000) : next;
          });
        }
        if (r.dropped > 0) setDropped(r.dropped);
        if (r.exited) {
          setRunning(false);
          setExitCode(r.exit_code);
        }
      } catch (e) {
        if (!alive) return;
        setError(String(e));
        setRunning(false);
      }
    };
    void tick();
    const id = setInterval(tick, 800);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [handle]);

  // Keep the newest output in view while it streams.
  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [log]);

  const status = running
    ? "running"
    : exitCode === 0
      ? "exited"
      : exitCode != null
        ? "exited"
        : "stopped";
  const statusDot = running
    ? "bg-emerald-500 animate-pulse"
    : exitCode === 0
      ? "bg-muted-foreground/40"
      : "bg-destructive";

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <span
          className={cn("size-1.5 shrink-0 rounded-full", statusDot)}
          aria-label={status}
        />
        <span className="shrink-0 text-foreground">#{handle}</span>
        <span className="shrink-0 text-muted-foreground">{status}</span>
        {exitCode != null ? (
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]",
              exitCode === 0
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                : "bg-destructive/15 text-destructive",
            )}
          >
            exit {exitCode}
          </span>
        ) : null}
        {dropped > 0 ? (
          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            dropped {formatBytes(dropped)}
          </span>
        ) : null}
        {error ? (
          <span className="shrink-0 font-mono text-[10px] text-destructive">
            error
          </span>
        ) : null}
      </div>
      {command ? (
        <div className="truncate text-muted-foreground">{command}</div>
      ) : null}
      {error ? (
        <div className="font-mono text-[11px] text-destructive">{error}</div>
      ) : null}
      <pre
        ref={scrollRef}
        className="max-h-56 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
      >
        {log || " "}
      </pre>
    </div>
  );
}

function BashRunOutput({ data }: { data: Record<string, unknown> }) {
  const stdout = typeof data.stdout === "string" ? data.stdout : "";
  const stderr = typeof data.stderr === "string" ? data.stderr : "";
  const exit = typeof data.exit_code === "number" ? data.exit_code : null;
  const cwdAfter = typeof data.cwd_after === "string" ? data.cwd_after : null;
  const truncated = Boolean(data.truncated);
  const timedOut = Boolean(data.timed_out);

  const hasStdout = stdout.length > 0;
  const hasStderr = stderr.length > 0;
  const initial = hasStdout ? "stdout" : hasStderr ? "stderr" : "stdout";
  const [tab, setTab] = useState<"stdout" | "stderr">(initial);

  const tabs: Array<{
    key: "stdout" | "stderr";
    label: string;
    count: number;
  }> = [
    { key: "stdout", label: "stdout", count: stdout.length },
    { key: "stderr", label: "stderr", count: stderr.length },
  ];

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors",
              tab === t.key
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:text-foreground",
              t.count === 0 && "opacity-40",
            )}
            disabled={t.count === 0}
          >
            {t.label}
            {t.count > 0 ? (
              <span className="ml-1 text-muted-foreground">
                · {formatBytes(t.count)}
              </span>
            ) : null}
          </button>
        ))}
        <span className="flex-1" />
        {exit != null ? (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px]",
              exit === 0
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                : "bg-destructive/15 text-destructive",
            )}
          >
            exit {exit}
          </span>
        ) : null}
        {timedOut ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            timed out
          </span>
        ) : null}
        {truncated ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            truncated
          </span>
        ) : null}
      </div>
      <pre className="max-h-72 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {tab === "stdout" ? tailForDisplay(stdout) || " " : tailForDisplay(stderr) || " "}
      </pre>
      {cwdAfter ? (
        <div className="font-mono text-[10px] text-muted-foreground">
          cwd → {cwdAfter}
        </div>
      ) : null}
    </div>
  );
}

function highlightMatch(text: string, pattern: string): ReactNode {
  if (!pattern) return text;
  let re: RegExp;
  try {
    re = new RegExp(
      `(${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
      "gi",
    );
  } catch {
    return text;
  }
  const parts = text.split(re);
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded bg-amber-500/30 px-0.5 text-foreground">
        {p}
      </mark>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

// Incremental rendering: keep only the tail of a very large output so the DOM
// node stays bounded even when a command floods stdout (BatikCode
// `chatIncrementalRendering` parity).
function tailForDisplay(text: string, maxChars = 96_000): string {
  if (text.length <= maxChars) return text;
  return `…[truncated ${formatBytes(text.length - maxChars)}]…\n${text.slice(text.length - maxChars)}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function CodeBlockMini({ code }: { code: string; language: string }) {
  // Tool input/output is debug-grade detail - JSON arrives pre-formatted and
  // file content is shown in the editor diff tab. Highlighting here is not
  // worth the parser hop.
  return (
    <pre className="max-h-60 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap">
      {code}
    </pre>
  );
}

function SuggestCommandCard({
  command,
  explanation,
}: {
  command: string;
  explanation: string | null;
}) {
  const [inserted, setInserted] = useState(false);
  const onInsert = () => {
    const ok = useChatStore
      .getState()
      .live.injectIntoActivePty(command);
    if (ok) setInserted(true);
  };
  return (
    <div className="space-y-1.5">
      {explanation ? (
        <div className="text-[11px] text-muted-foreground">{explanation}</div>
      ) : null}
      <div className="flex items-stretch gap-1.5 rounded bg-muted/40 overflow-hidden">
        <pre className="flex-1 overflow-auto p-2 font-mono text-[11px] leading-relaxed">
          {command}
        </pre>
        <button
          type="button"
          onClick={onInsert}
          disabled={inserted}
          className={cn(
            "shrink-0 flex items-center gap-1 px-2.5 text-[11px] font-medium",
            "border-l border-border/60",
            "hover:bg-muted/80 active:bg-muted",
            "disabled:opacity-60 disabled:cursor-default disabled:hover:bg-transparent",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
          aria-label="Insert into active terminal"
        >
          <HugeiconsIcon
            icon={inserted ? TerminalIcon : ArrowRight01Icon}
            size={12}
            strokeWidth={1.75}
          />
          <span>{inserted ? "Inserted" : "Insert"}</span>
        </button>
      </div>
    </div>
  );
}

// Compatibility re-exports - the previous API exposed these subcomponents,
// but the new compact <Tool /> takes everything via props. Kept as no-ops
// to avoid breaking accidental imports.
export const ToolHeader = () => null;
export const ToolContent = ({ children }: { children?: ReactNode }) => (
  <>{children}</>
);
export { ToolInput, ToolOutput };

// ── Live sub-agent runs ─────────────────────────────────────────────────────
// A run_subagent / run_subagents card shows each spawned agent live: a spinner
// while it works, its latest step, then a collapsible summary once it finishes.
// Fed by subagentRunStore (written from the tool's execute), matched back to
// this card by the type/label of the tasks the card was called with.

function useLiveNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function expectedSubagentRuns(
  toolName: string,
  input: unknown,
): Array<{ type: string; label?: string }> {
  if (!input || typeof input !== "object") return [];
  const data = input as Record<string, unknown>;
  if (toolName === "run_subagent") {
    return typeof data.type === "string"
      ? [{ type: data.type, label: typeof data.description === "string" ? data.description : undefined }]
      : [];
  }
  if (toolName !== "run_subagents" || !Array.isArray(data.tasks)) return [];
  const out: Array<{ type: string; label?: string }> = [];
  for (const task of data.tasks) {
    if (!task || typeof task !== "object") continue;
    const v = task as Record<string, unknown>;
    if (typeof v.type !== "string") continue;
    out.push({ type: v.type, label: typeof v.description === "string" ? v.description : undefined });
  }
  return out;
}

function sameSubagentRun(run: SubagentRun, want: { type: string; label?: string }): boolean {
  return run.type === resolveSubagentType(want.type) && (run.label ?? "") === (want.label ?? "");
}

function matchSubagentRuns(toolName: string, input: unknown, runs: SubagentRun[]): SubagentRun[] {
  const expected = expectedSubagentRuns(toolName, input);
  if (expected.length === 0 || runs.length === 0) return [];
  const matched: SubagentRun[] = [];
  let cursor = runs.length - 1;
  for (let i = expected.length - 1; i >= 0; i--) {
    const want = expected[i];
    let found: SubagentRun | null = null;
    for (let j = cursor; j >= 0; j--) {
      if (!sameSubagentRun(runs[j], want)) continue;
      found = runs[j];
      cursor = j - 1;
      break;
    }
    if (!found) return [];
    matched.push(found);
  }
  return matched.reverse();
}

function SubagentLiveDetails({ toolName, input }: { toolName: string; input: unknown }) {
  const sessionId = useChatStore((s) => s.activeSessionId) ?? "";
  const runs = useSubagentRunStore((s) => (sessionId ? s.bySession[sessionId] : undefined)) ?? [];
  const matched = useMemo(
    () => matchSubagentRuns(toolName, input, runs),
    [toolName, input, runs],
  );
  const active = matched.some((r) => r.status === "running");
  const now = useLiveNow(active);
  if (matched.length === 0) return null;
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium text-muted-foreground">Progress</div>
      <div className="space-y-1">
        {matched.map((run) => (
          <SubagentRunRow key={run.id} run={run} now={now} />
        ))}
      </div>
    </div>
  );
}

const SubagentRunRow = memo(
  function SubagentRunRow({ run, now }: { run: SubagentRun; now: number }) {
    const agentName = resolveSubagentLabel(run.type);
    const isRunning = run.status === "running";
    const isError = run.status === "error";
    const elapsed = isRunning
      ? now - run.startedAt
      : (run.durationMs ?? (run.endedAt ? run.endedAt - run.startedAt : 0));
    const stats = [
      run.stepCount != null ? `${run.stepCount} step${run.stepCount === 1 ? "" : "s"}` : null,
      elapsed > 0 ? fmtDuration(elapsed) : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const summary = run.status === "done" && run.summary?.trim() ? run.summary : null;

    const header = (
      <>
        <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
          {isRunning ? (
            <Spinner className="size-3" />
          ) : (
            <span
              className={cn(
                "size-2 rounded-full",
                isError ? "bg-destructive" : "bg-emerald-500",
              )}
            />
          )}
        </span>
        <span className="shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
          {agentName}
        </span>
        {run.depth != null && run.depth > 0 ? (
          <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            L{run.depth}
          </span>
        ) : null}
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            isError ? "text-destructive" : isRunning ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {isError ? run.error?.trim() || "failed" : run.currentStep || run.label || "working"}
        </span>
        {stats ? (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{stats}</span>
        ) : null}
      </>
    );

    const container = cn(
      "flex flex-col gap-1 rounded-md border border-border/50 bg-muted/25 px-2 py-1.5 text-[11px]",
      isRunning && "border-primary/30",
      isError && "border-destructive/30 bg-destructive/5",
    );

    if (summary) {
      return (
        <Collapsible className={container}>
          <CollapsibleTrigger className="group/sar flex w-full cursor-pointer items-center gap-1.5 text-left">
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={11}
              strokeWidth={2}
              className="shrink-0 text-muted-foreground transition-transform group-data-[state=open]/sar:rotate-90"
            />
            {header}
          </CollapsibleTrigger>
          <CollapsibleContent className="termigo-collapsible-content">
            <div className="mt-1 ml-2 space-y-1.5 border-l border-border/60 pl-2.5">
              <div className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-foreground/90">
                {summary}
              </div>
              {run.steps && run.steps.length > 0 ? (
                <div className="space-y-0.5">
                  <div className="text-[10px] font-medium text-muted-foreground">
                    Steps
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {run.steps.map((s, i) => (
                      <span
                        key={i}
                        className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </CollapsibleContent>
        </Collapsible>
      );
    }
    return (
      <div className={container}>
        <div className="flex items-center gap-1.5">{header}</div>
      </div>
    );
  },
  (a, b) => a.run === b.run && (a.run.status === "running" ? a.now === b.now : true),
);
