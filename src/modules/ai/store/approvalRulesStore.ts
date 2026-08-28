import { create } from "zustand";
import {
  APPROVAL_RULES_REL_PATH,
  type ApprovalAction,
  type ApprovalRule,
  type ApprovalRuleContext,
  evaluateApprovalRules,
  parseApprovalRules,
} from "../lib/approvalRules";
import { native } from "../lib/native";

type State = {
  /** Rules loaded from the active workspace's `.termigo/approvals.json`. */
  rules: ApprovalRule[];
  /** Rescan the workspace's approval-rules file and publish the result. */
  loadFor: (workspaceRoot: string | null) => Promise<void>;
  /** Decide a tool call against the rules, synchronously. Null = no rule
   *  matched (fall back to the global approval mode). */
  evaluate: (
    ctx: ApprovalRuleContext,
  ) => { action: ApprovalAction; reason?: string } | null;
};

async function load(workspaceRoot: string | null): Promise<ApprovalRule[]> {
  if (!workspaceRoot) return [];
  const path = `${workspaceRoot.replace(/[\\/]$/, "")}/${APPROVAL_RULES_REL_PATH}`;
  try {
    const r = await native.readFile(path);
    if (r.kind !== "text" || !r.content) return [];
    return parseApprovalRules(JSON.parse(r.content));
  } catch {
    // No file / bad JSON is the normal case: no project rules.
    return [];
  }
}

export const useApprovalRulesStore = create<State>((set, getState) => ({
  rules: [],
  loadFor: async (workspaceRoot) => {
    set({ rules: await load(workspaceRoot) });
  },
  evaluate: (ctx) => evaluateApprovalRules(getState().rules, ctx),
}));
