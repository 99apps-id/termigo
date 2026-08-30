// Harness profiles — named, composable tweaks to the agent's surrounding code
// (the "harness": system prompt, tool ordering, loop budget).
//
// Inspired by DeepSeek Harness's "everything is a plugin" profiles and the
// Meta-Harness search (hermes-agent-metaharness) mutations: instead of hand
// tuning one prompt, ship a set of named profiles that shift how the agent is
// run, let a user pick one, and over time pick the one that works best for this
// workspace (see harnessFrontier).

import type { SystemModelMessage } from "ai";

export type SystemLike = string | SystemModelMessage | SystemModelMessage[];

export type HarnessProfile = {
  id: string;
  label: string;
  description: string;
  /** Prepended to the system prompt. */
  promptPrelude?: string;
  /** Tool names moved earlier in the exposed tool order (affects model choice). */
  prioritizeTools?: string[];
  /** Tool names removed from the toolset entirely. */
  hideTools?: string[];
  /** Added to the default step budget (can be negative). */
  stepBudgetDelta?: number;
  /** Hard cap on the step budget. 0 = no cap. */
  stepBudgetCap?: number;
};

export const DEFAULT_PROFILE_ID = "balanced";

export const BUILTIN_PROFILES: Record<string, HarnessProfile> = {
  balanced: {
    id: "balanced",
    label: "Balanced",
    description:
      "Default harness: no extra guidance, full toolset, standard loop.",
  },
  plan_briefly: {
    id: "plan_briefly",
    label: "Plan first",
    description:
      "Prepend a short planning reminder before the task prompt, nudging a brief plan before acting.",
    promptPrelude:
      "Start with a short plan, then act. Avoid repeating environment discovery if the prompt already gives you the needed context.",
  },
  verify_before_finish: {
    id: "verify_before_finish",
    label: "Verify before finish",
    description:
      "Remind the agent to run the smallest relevant verification (run_checks) and summarize the result before stopping.",
    promptPrelude:
      "Before finishing, run the smallest relevant verification step you can (e.g. run_checks kind=test or kind=lint) and summarize the concrete result.",
  },
  terminal_first: {
    id: "terminal_first",
    label: "Terminal-first",
    description:
      "Prefer terminal / shell / python tools earlier in the tool list for command-heavy work.",
    prioritizeTools: [
      "bash_run",
      "bash_background",
      "bash_logs",
      "bash_list",
      "bash_kill",
      "suggest_command",
      "get_terminal_output",
      "terminal",
    ],
  },
  shorter_loop: {
    id: "shorter_loop",
    label: "Shorter loop",
    description:
      "Cap the number of agent steps to reduce wandering on short, bounded tasks.",
    stepBudgetDelta: -6,
    stepBudgetCap: 16,
  },
  no_todo: {
    id: "no_todo",
    label: "No todo overhead",
    description:
      "Hide the todo tools for lighter tasks, so short asks do not carry plan overhead.",
    hideTools: ["todo_write"],
  },
};

/** Resolve a profile id, falling back to the balanced default. */
export function getProfile(id: string | null | undefined): HarnessProfile {
  if (id && BUILTIN_PROFILES[id]) return BUILTIN_PROFILES[id];
  return BUILTIN_PROFILES[DEFAULT_PROFILE_ID];
}

/** Prepend the profile's prompt prelude, if any, to the base system prompt. */
export function applyProfileToSystem(
  base: SystemLike,
  profile: HarnessProfile,
): SystemLike {
  const prelude = profile.promptPrelude?.trim();
  if (!prelude) return base;
  const preludeMsg: SystemModelMessage = { role: "system", content: prelude };
  if (Array.isArray(base)) return [preludeMsg, ...base];
  if (typeof base === "string") return `${prelude}\n\n${base}`;
  return [preludeMsg, base];
}

/** Append a system hint (e.g. the live todo list) as the last system message. */
export function appendSystemHint(
  system: SystemLike,
  hint: string,
): SystemModelMessage[] {
  const arr = Array.isArray(system)
    ? system
    : typeof system === "string"
      ? [{ role: "system" as const, content: system }]
      : [system];
  return [...arr, { role: "system" as const, content: hint }];
}

/** Reorder and/or hide tools according to the profile. Preserves other tools. */
export function applyProfileToTools<T>(
  tools: Record<string, T>,
  profile: HarnessProfile,
): Record<string, T> {
  const entries = Object.entries(tools);
  const hidden = new Set(profile.hideTools ?? []);
  const kept = entries.filter(([name]) => !hidden.has(name));

  const priority = profile.prioritizeTools ?? [];
  const rank = new Map(priority.map((name, i) => [name, i]));
  if (rank.size > 0) {
    kept.sort(([a], [b]) => {
      const ra = rank.has(a) ? (rank.get(a) as number) : priority.length;
      const rb = rank.has(b) ? (rank.get(b) as number) : priority.length;
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b);
    });
  }

  return Object.fromEntries(kept) as Record<string, T>;
}

/** Adjust a base step budget by the profile's delta, capped at budgetCap. */
export function applyProfileToStepBudget(
  base: number,
  profile: HarnessProfile,
): number {
  let budget = base;
  if (profile.stepBudgetDelta) budget += profile.stepBudgetDelta;
  if (profile.stepBudgetDelta && budget < 1) budget = 1;
  if (profile.stepBudgetCap && profile.stepBudgetCap > 0) {
    budget = Math.min(budget, profile.stepBudgetCap);
  }
  return budget;
}
