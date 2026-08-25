import { useChatStore } from "../store/chatStore";
import { native } from "./native";

// ─── Types ────────────────────────────────────────────────────────────────

export type PolicyRule = {
  id: string;
  description: string;
  /** Tool names this rule applies to. Empty = all tools. */
  tools?: string[];
  /** Shell command patterns this rule applies to. Empty = all commands. */
  commands?: string[];
  /** If true, the rule is a hard block. If false, it's a warning. */
  block?: boolean;
  /** Custom evaluation logic. */
  evaluate?: (context: PolicyContext) => PolicyResult;
};

export type PolicyContext = {
  toolName?: string;
  command?: string;
  path?: string;
  cwd?: string;
  workspaceRoot?: string;
};

export type PolicyResult =
  | { allowed: true }
  | { allowed: false; reason: string; ruleId: string };

export type PolicySet = {
  version: number;
  rules: PolicyRule[];
};

// ─── Default policies ─────────────────────────────────────────────────────

const DEFAULT_POLICIES: PolicySet = {
  version: 1,
  rules: [
    {
      id: "no-commit-to-main",
      description: "Block direct commits to main/master branches",
      tools: ["git_commit"],
      evaluate: (ctx) => {
        const branch = ctx.command?.match(/git commit.*-m\s+["']?\[([^\]]+)\]/)?.[1];
        if (branch && /^(main|master)$/i.test(branch)) {
          return {
            allowed: false,
            reason: `Direct commits to ${branch} are blocked. Use a feature branch.`,
            ruleId: "no-commit-to-main",
          };
        }
        return { allowed: true };
      },
    },
    {
      id: "no-force-push",
      description: "Block force pushes to any remote branch",
      tools: ["git_push"],
      commands: ["git push --force", "git push -f"],
      block: true,
      evaluate: (ctx) => {
        const cmd = ctx.command || "";
        if (cmd.includes("--force") || cmd.includes("-f")) {
          return {
            allowed: false,
            reason: "Force push is blocked by policy.",
            ruleId: "no-force-push",
          };
        }
        return { allowed: true };
      },
    },
    {
      id: "max-file-size",
      description: "Block writes to files larger than 1MB",
      tools: ["write_file", "edit", "multi_edit"],
      evaluate: (ctx) => {
        if (!ctx.path) return { allowed: true };
        // This is a soft check; the actual size check happens at write time.
        // Here we just flag obviously large paths.
        if (ctx.path.endsWith(".bin") || ctx.path.endsWith(".iso")) {
          return {
            allowed: false,
            reason: "Writing binary files is blocked by policy.",
            ruleId: "max-file-size",
          };
        }
        return { allowed: true };
      },
    },
    {
      id: "no-delete-in-system-dirs",
      description: "Block deletions in system directories",
      tools: ["delete_file"],
      evaluate: (ctx) => {
        if (!ctx.path) return { allowed: true };
        const lower = ctx.path.toLowerCase();
        if (
          lower.includes("/windows/") ||
          lower.includes("/program files") ||
          lower.includes("/system/")
        ) {
          return {
            allowed: false,
            reason: "Deleting files in system directories is blocked by policy.",
            ruleId: "no-delete-in-system-dirs",
          };
        }
        return { allowed: true };
      },
    },
  ],
};

// ─── Storage ──────────────────────────────────────────────────────────────

const POLICY_PATH = ".termigo/policies.json";

async function loadPolicies(): Promise<PolicySet> {
  const root = useChatStore.getState().live.getWorkspaceRoot() ?? ".";
  const path = `${root.replace(/\/$/, "")}/${POLICY_PATH}`;
  try {
    const r = await native.readFile(path);
    if (r.kind !== "text" || !r.content) return DEFAULT_POLICIES;
    return JSON.parse(r.content) as PolicySet;
  } catch {
    return DEFAULT_POLICIES;
  }
}

// ─── Evaluation ───────────────────────────────────────────────────────────

export async function evaluatePolicy(
  ctx: PolicyContext,
): Promise<PolicyResult> {
  const policies = await loadPolicies();

  for (const rule of policies.rules) {
    // Check if rule applies to this tool
    if (rule.tools && rule.tools.length > 0 && ctx.toolName) {
      const tool = ctx.toolName;
      const matchesTool = rule.tools.some(
        (t) => tool === t || tool.endsWith(`/${t}`),
      );
      if (!matchesTool) continue;
    }

    // Check if rule applies to this command
    if (rule.commands && rule.commands.length > 0 && ctx.command) {
      const matchesCommand = rule.commands.some((pattern) =>
        ctx.command?.includes(pattern),
      );
      if (!matchesCommand) continue;
    }

    // Run custom evaluation if present
    if (rule.evaluate) {
      const result = rule.evaluate(ctx);
      if (!result.allowed) {
        return result;
      }
    }
  }

  return { allowed: true };
}

import { tool } from "ai";
import { z } from "zod";

// ─── Agent tool ───────────────────────────────────────────────────────────

export function buildPolicyTools() {
  return {
    list_policies: tool({
      description:
        "List active agentic policies for this workspace. Returns policy names and descriptions.",
      inputSchema: z.object({}),
      execute: async () => {
        const policies = await loadPolicies();
        return {
          policies: policies.rules.map((r) => ({
            id: r.id,
            description: r.description,
            block: r.block ?? false,
          })),
        };
      },
    }),
  } as const;
}

/**
 * Evaluate policies for a tool call. Returns the policy result, or
 * `{ allowed: true }` if no policy blocks the action.
 */
export async function enforcePolicy(ctx: {
  toolName?: string;
  command?: string;
  path?: string;
}): Promise<PolicyResult> {
  const result = await evaluatePolicy({
    toolName: ctx.toolName,
    command: ctx.command,
    path: ctx.path,
  });
  if (!result.allowed) {
    return result;
  }
  return { allowed: true };
}
