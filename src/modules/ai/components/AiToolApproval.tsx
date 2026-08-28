import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setAgentAlwaysAllowedTools } from "@/modules/settings/store";
import {
  Cancel01Icon,
  Clock01Icon,
  Edit02Icon,
  FileEditIcon,
  FilePlusIcon,
  FolderAddIcon,
  Infinity01Icon,
  TerminalIcon,
  Tick02Icon,
  ToolsIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ToolUIPart } from "ai";
import { memo } from "react";
import { ruleFromApproval } from "../lib/approvalRules";
import { rememberSessionAllowed } from "../store/approvalQueueStore";
import { useApprovalRulesStore } from "../store/approvalRulesStore";

type Props = {
  part: Extract<ToolUIPart, { state: "approval-requested" }>;
  toolName: string;
  onRespond: (approved: boolean) => void;
};

const TOOL_META: Record<string, { label: string; icon: typeof FilePlusIcon }> =
  {
    write_file: { label: "Write file", icon: FilePlusIcon },
    edit: { label: "Edit file", icon: FileEditIcon },
    multi_edit: { label: "Edit file (batch)", icon: Edit02Icon },
    create_directory: { label: "Create directory", icon: FolderAddIcon },
    bash_run: { label: "Run shell command", icon: TerminalIcon },
    bash_background: { label: "Spawn background process", icon: TerminalIcon },
  };

function AiToolApprovalImpl({ part, toolName, onRespond }: Props) {
  const meta = TOOL_META[toolName];
  const label = meta?.label ?? toolName;
  const Icon = meta?.icon ?? ToolsIcon;
  const input = part.input as Record<string, unknown>;

  // Persist an "always allow" rule scoped to this call into the project's
  // `.termigo/approvals.json`, then approve. Only offered when there is a
  // workspace to write to and the call is specific enough to generalise.
  const hasWorkspace = useApprovalRulesStore((s) => s.root !== null);
  const projectRule = ruleFromApproval(
    toolName,
    {
      command: typeof input.command === "string" ? input.command : null,
      path: typeof input.path === "string" ? input.path : null,
    },
    "allow",
  );
  const allowInProject = () => {
    if (projectRule) void useApprovalRulesStore.getState().addRule(projectRule);
    rememberSessionAllowed(toolName);
    onRespond(true);
  };

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="size-1.5 shrink-0 rounded-full bg-amber-500 animate-pulse" />
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="text-[12px] font-medium text-foreground">{label}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          needs approval
        </span>
      </div>

      <div className="px-3 py-2.5">
        <PreviewBlock toolName={toolName} input={input} />
      </div>

      <div className="flex items-center justify-end gap-1.5 border-t border-border/60 px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onRespond(false)}
          className="h-7 gap-1.5 text-[11px]"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
          Deny
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            rememberSessionAllowed(toolName);
            onRespond(true);
          }}
          className="h-7 gap-1.5 text-[11px]"
          title="Approve, and don't ask again for this tool this session"
        >
          <HugeiconsIcon icon={Clock01Icon} size={12} strokeWidth={2} />
          This session
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            rememberSessionAllowed(toolName);
            const list = usePreferencesStore.getState().agentAlwaysAllowedTools;
            if (!list.includes(toolName)) {
              void setAgentAlwaysAllowedTools([...list, toolName]);
            }
            onRespond(true);
          }}
          className="h-7 gap-1.5 text-[11px]"
          title="Approve, and never ask again for this tool"
        >
          <HugeiconsIcon icon={Infinity01Icon} size={12} strokeWidth={2} />
          Always
        </Button>
        {hasWorkspace && projectRule && (
          <Button
            size="sm"
            variant="ghost"
            onClick={allowInProject}
            className="h-7 gap-1.5 text-[11px]"
            title={`Approve, and save an allow rule to this project's .termigo/approvals.json${projectRule.command ? ` (${projectRule.command})` : projectRule.path ? ` (${projectRule.path})` : ""}`}
          >
            <HugeiconsIcon icon={FolderAddIcon} size={12} strokeWidth={2} />
            Project
          </Button>
        )}
        <Button
          size="sm"
          variant="default"
          onClick={() => onRespond(true)}
          className="h-7 gap-1.5 text-[11px]"
        >
          <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
          Approve
        </Button>
      </div>
    </div>
  );
}

export const AiToolApproval = memo(AiToolApprovalImpl, (a, b) => {
  // The approval card never changes content for a given approvalId — once
  // the model has emitted the approval-requested part with its input, we
  // don't want to re-render on every downstream token.
  return (
    a.toolName === b.toolName &&
    a.part.approval.id === b.part.approval.id &&
    a.onRespond === b.onRespond
  );
});

function PreviewBlock({
  toolName,
  input,
}: {
  toolName: string;
  input: Record<string, unknown>;
}) {
  if (toolName === "bash_run" || toolName === "bash_background") {
    const cwd = typeof input.cwd === "string" ? input.cwd : null;
    return (
      <div className="space-y-1.5">
        {cwd && (
          <div className="font-mono text-[10.5px] text-muted-foreground">
            {cwd}
          </div>
        )}
        <pre
          className={cn(
            "max-h-40 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed",
          )}
        >
          {String(input.command ?? "")}
        </pre>
      </div>
    );
  }
  // For file mutations we deliberately do NOT preview content here —
  // streamed write/edit content thrashes the UI and the AI diff tab is the
  // authoritative place to review the change. Show just the path + a
  // one-line size hint so the user knows what's being touched.
  if (toolName === "write_file") {
    const content = typeof input.content === "string" ? input.content : "";
    const lines = content ? content.split("\n").length : 0;
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-muted-foreground">{String(input.path ?? "")}</div>
        <div className="text-[10.5px] text-muted-foreground/80">
          {lines} line{lines === 1 ? "" : "s"} · review in the diff tab
        </div>
      </div>
    );
  }
  if (toolName === "edit") {
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    const removed = oldStr ? oldStr.split("\n").length : 0;
    const added = newStr ? newStr.split("\n").length : 0;
    return (
      <div className="space-y-1.5 font-mono text-[11px]">
        <div className="text-muted-foreground">
          {String(input.path ?? "")}
          {input.replace_all ? " · replace all" : ""}
        </div>
        <InlineDiff oldStr={oldStr} newStr={newStr} />
        <div className="text-[10.5px] text-muted-foreground/80">
          −{removed} / +{added} line{added === 1 && removed === 1 ? "" : "s"} ·
          review in the diff tab
        </div>
      </div>
    );
  }
  if (toolName === "multi_edit") {
    const edits = Array.isArray(input.edits)
      ? (input.edits as Array<{ old_string?: string; new_string?: string }>)
      : [];
    return (
      <div className="space-y-1.5 font-mono text-[11px]">
        <div className="text-muted-foreground">{String(input.path ?? "")}</div>
        <div className="space-y-1.5">
          {edits.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static edit list, order never changes
            <div key={i} className="space-y-0.5">
              <div className="text-[10.5px] text-muted-foreground/80">
                edit {i + 1}
              </div>
              <InlineDiff
                oldStr={e.old_string ?? ""}
                newStr={e.new_string ?? ""}
              />
            </div>
          ))}
        </div>
        <div className="text-[10.5px] text-muted-foreground/80">
          {edits.length} edit{edits.length === 1 ? "" : "s"} · review in the
          diff tab
        </div>
      </div>
    );
  }
  if (toolName === "create_directory") {
    return (
      <div className="font-mono text-[11px] text-muted-foreground">
        {String(input.path ?? "")}
      </div>
    );
  }
  return (
    <pre className="overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}

// Compact inline diff for an edit in the approval card. Shows the removed
// block in red and the added block in green so the user sees exactly what
// changes before approving, without opening the diff tab. Long blocks are
// capped so a huge paste does not flood the card.
function InlineDiff({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const CAP = 24;
  const oldLines = oldStr ? oldStr.split("\n") : [];
  const newLines = newStr ? newStr.split("\n") : [];
  const oldShown = oldLines.length > CAP ? oldLines.slice(0, CAP) : oldLines;
  const newShown = newLines.length > CAP ? newLines.slice(0, CAP) : newLines;

  return (
    <div className="max-h-52 overflow-auto rounded-md bg-muted/40 font-mono text-[11px] leading-relaxed">
      {oldShown.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static diff lines, order never changes
        <div
          key={`o${i}`}
          className="whitespace-pre-wrap bg-red-500/10 px-2 text-red-500"
        >
          <span className="mr-1 select-none text-muted-foreground">−</span>
          {l || " "}
        </div>
      ))}
      {oldLines.length > oldShown.length && (
        <div className="px-2 text-[10px] text-muted-foreground">
          … {oldLines.length - oldShown.length} more removed lines
        </div>
      )}
      {newShown.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static diff lines, order never changes
        <div
          key={`n${i}`}
          className="whitespace-pre-wrap bg-green-500/10 px-2 text-green-600"
        >
          <span className="mr-1 select-none text-muted-foreground">+</span>
          {l || " "}
        </div>
      ))}
      {newLines.length > newShown.length && (
        <div className="px-2 text-[10px] text-muted-foreground">
          … {newLines.length - newShown.length} more added lines
        </div>
      )}
    </div>
  );
}
