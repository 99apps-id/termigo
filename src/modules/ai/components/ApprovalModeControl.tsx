import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { setAgentApprovalMode } from "@/modules/settings/store";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  APPROVAL_MODE_HINTS,
  APPROVAL_MODE_LABELS,
  APPROVAL_MODES,
  type ApprovalMode,
} from "../lib/approvalPolicy";

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
      <PopoverContent align="end" className="w-72 p-1">
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
                <span className="text-[10px] text-muted-foreground">active</span>
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
      </PopoverContent>
    </Popover>
  );
}
