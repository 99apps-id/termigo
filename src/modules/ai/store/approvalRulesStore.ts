import { create } from "zustand";
import {
  APPROVAL_RULES_REL_PATH,
  type ApprovalAction,
  type ApprovalRule,
  type ApprovalRuleContext,
  evaluateApprovalRules,
  parseApprovalRules,
  serializeApprovalRules,
  upsertRule,
} from "../lib/approvalRules";
import { native } from "../lib/native";

const ACTION_CYCLE: Record<ApprovalAction, ApprovalAction> = {
  allow: "ask",
  ask: "deny",
  deny: "allow",
};

type State = {
  /** Rules loaded from the active workspace's `.termigo/approvals.json`. */
  rules: ApprovalRule[];
  /** The workspace root the current rules were loaded for; where a save writes
   *  back. Null when no workspace is active (rules cannot be persisted). */
  root: string | null;
  /** Rescan the workspace's approval-rules file and publish the result. */
  loadFor: (workspaceRoot: string | null) => Promise<void>;
  /** Decide a tool call against the rules, synchronously. Null = no rule
   *  matched (fall back to the global approval mode). */
  evaluate: (
    ctx: ApprovalRuleContext,
  ) => { action: ApprovalAction; reason?: string } | null;
  /** Persist a rule to the active workspace's `.termigo/approvals.json`,
   *  replacing any rule that targets the same calls. Resolves false when there
   *  is no workspace to write to or the write fails. */
  addRule: (rule: ApprovalRule) => Promise<boolean>;
  /** Remove the rule at `index` and persist. */
  removeRule: (index: number) => Promise<boolean>;
  /** Cycle the rule at `index` allow → ask → deny → allow and persist. */
  cycleRuleAction: (index: number) => Promise<boolean>;
};

async function writeRules(
  root: string,
  next: ApprovalRule[],
  set: (partial: { rules: ApprovalRule[] }) => void,
): Promise<boolean> {
  try {
    await native.writeFile(filePath(root), serializeApprovalRules(next));
    set({ rules: next });
    return true;
  } catch {
    return false;
  }
}

function filePath(workspaceRoot: string): string {
  return `${workspaceRoot.replace(/[\\/]$/, "")}/${APPROVAL_RULES_REL_PATH}`;
}

async function load(workspaceRoot: string | null): Promise<ApprovalRule[]> {
  if (!workspaceRoot) return [];
  try {
    const r = await native.readFile(filePath(workspaceRoot));
    if (r.kind !== "text" || !r.content) return [];
    return parseApprovalRules(JSON.parse(r.content));
  } catch {
    // No file / bad JSON is the normal case: no project rules.
    return [];
  }
}

export const useApprovalRulesStore = create<State>((set, getState) => ({
  rules: [],
  root: null,
  loadFor: async (workspaceRoot) => {
    set({ rules: await load(workspaceRoot), root: workspaceRoot });
  },
  evaluate: (ctx) => evaluateApprovalRules(getState().rules, ctx),
  addRule: async (rule) => {
    const { root, rules } = getState();
    if (!root) return false;
    return writeRules(root, upsertRule(rules, rule), set);
  },
  removeRule: async (index) => {
    const { root, rules } = getState();
    if (!root || index < 0 || index >= rules.length) return false;
    return writeRules(
      root,
      rules.filter((_, i) => i !== index),
      set,
    );
  },
  cycleRuleAction: async (index) => {
    const { root, rules } = getState();
    if (!root || index < 0 || index >= rules.length) return false;
    const next = rules.map((r, i) =>
      i === index ? { ...r, action: ACTION_CYCLE[r.action] } : r,
    );
    return writeRules(root, next, set);
  },
}));
