import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setAgentApprovalMode } from "@/modules/settings/store";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  APPROVAL_MODE_HINTS,
  APPROVAL_MODE_LABELS,
  APPROVAL_MODES,
  type ApprovalMode,
} from "../lib/approvalPolicy";
import type { ApprovalAction, ApprovalRule } from "../lib/approvalRules";
import { useApprovalRulesStore } from "../store/approvalRulesStore";

/** Short label for the status bar, where the full one does not fit. */
const SHORT: Record<ApprovalMode, string> = {
  ask: "Ask",
  edits: "Auto edits",
  all: "Auto all",
};

/**
 * Approval mode selector.
 *
 * A non-default mode stays visibly marked rather than sitting silently in
 * settings: delegating approval is exactly the state a user should be able to
 * see at a glance before typing the next instruction.
 */
export function ApprovalModeControl({ className }: { className?: string }) {
  const mode = usePreferencesStore((s) => s.agentApprovalMode);
  const delegated = mode !== "ask";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={`Tool approval: ${APPROVAL_MODE_LABELS[mode]}`}
          aria-label={`Tool approval mode: ${APPROVAL_MODE_LABELS[mode]}`}
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
            delegated
              ? "bg-amber-500/15 text-amber-500 hover:bg-amber-500/25"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
            className,
          )}
        >
          {SHORT[mode]}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-1">
        <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
          Tool approval
        </div>
        {APPROVAL_MODES.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => void setAgentApprovalMode(value)}
            className={cn(
              "w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-accent",
              value === mode && "bg-accent/60",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">
                {APPROVAL_MODE_LABELS[value]}
              </span>
              {value === mode && (
                <span className="text-[10px] text-muted-foreground">
                  active
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
              {APPROVAL_MODE_HINTS[value]}
            </p>
          </button>
        ))}
        <p className="border-t border-border/60 px-2 py-1.5 text-[10px] leading-snug text-muted-foreground">
          Path and command safety checks always run, in every mode.
        </p>
        <ProjectRulesSection />
      </PopoverContent>
    </Popover>
  );
}

const ACTION_STYLE: Record<ApprovalAction, string> = {
  allow: "bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25",
  ask: "bg-amber-500/15 text-amber-500 hover:bg-amber-500/25",
  deny: "bg-red-500/15 text-red-500 hover:bg-red-500/25",
};

/** One-line description of what a rule matches, for the manager list. */
function describeRule(rule: ApprovalRule): string {
  const tools = rule.tools?.length ? rule.tools.join(", ") : "any tool";
  const target = rule.command
    ? ` · ${rule.command}`
    : rule.path
      ? ` · ${rule.path}`
      : "";
  return `${tools}${target}`;
}

/**
 * Project approval rules manager.
 *
 * Lists the rules saved in the active workspace's `.termigo/approvals.json`
 * (added via the "Project" button on an approval), and lets the user cycle a
 * rule's action or delete it — so an over-broad or mistaken "always allow" is
 * reversible from the UI instead of only by hand-editing the file. Hidden when
 * no workspace is active.
 */
function ProjectRulesSection() {
  const root = useApprovalRulesStore((s) => s.root);
  const rules = useApprovalRulesStore((s) => s.rules);
  if (!root) return null;

  return (
    <div className="border-t border-border/60">
      <div className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground">
        Project rules
      </div>
      {rules.length === 0 ? (
        <p className="px-2 pb-1.5 text-[10px] leading-snug text-muted-foreground">
          None yet. Use “Project” on an approval to remember a decision for this
          project.
        </p>
      ) : (
        <div className="max-h-52 space-y-0.5 overflow-y-auto px-1 pb-1">
          {rules.map((rule, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: rules are addressed by position in the store
              key={i}
              className="flex items-center gap-1.5 rounded px-1 py-1 hover:bg-accent/50"
            >
              <button
                type="button"
                title="Cycle allow → ask → deny"
                onClick={() =>
                  void useApprovalRulesStore.getState().cycleRuleAction(i)
                }
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide transition-colors",
                  ACTION_STYLE[rule.action],
                )}
              >
                {rule.action}
              </button>
              <span
                className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground/80"
                title={describeRule(rule)}
              >
                {describeRule(rule)}
              </span>
              <button
                type="button"
                aria-label="Delete rule"
                title="Delete rule"
                onClick={() =>
                  void useApprovalRulesStore.getState().removeRule(i)
                }
                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-red-500/15 hover:text-red-500"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
