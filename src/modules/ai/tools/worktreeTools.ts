import { tool } from "ai";
import { z } from "zod";
import {
  generateSandboxInfo,
  getSandbox,
  listSandboxes,
  registerSandbox,
  unregisterSandbox,
  worktreeAddCommand,
  worktreeDeleteBranchCommand,
  worktreeDiffCommand,
  worktreeDiffStatCommand,
  worktreeMergeCommand,
  worktreeRemoveCommand,
} from "../lib/worktree";

export function buildWorktreeTools() {
  return {
    worktree_create: tool({
      description:
        "Create an isolated git worktree sandbox for performing risky or exploratory code modifications in parallel without affecting the main working tree.",
      inputSchema: z.object({
        taskLabel: z
          .string()
          .optional()
          .describe("A short identifier or descriptive label for this worktree task (e.g., 'refactor-auth')."),
        description: z
          .string()
          .optional()
          .describe("Purpose of this sandbox."),
      }),
      execute: async ({ taskLabel, description }) => {
        const info = generateSandboxInfo(taskLabel);
        const sandbox = {
          id: info.id,
          branchName: info.branchName,
          worktreePath: info.subpath,
          createdAt: Date.now(),
          status: "active" as const,
          description,
        };
        registerSandbox(sandbox);

        return {
          status: "created",
          sandboxId: info.id,
          branchName: info.branchName,
          worktreePath: info.subpath,
          setupCommand: worktreeAddCommand(info.subpath, info.branchName),
          instruction: `Run the setupCommand in your shell to check out the worktree. Then make all file edits inside '${info.subpath}'.`,
        };
      },
    }),

    worktree_list: tool({
      description: "List all active git worktree sandboxes currently registered in Termigo.",
      inputSchema: z.object({}),
      execute: async () => {
        const sandboxes = listSandboxes();
        return {
          total: sandboxes.length,
          sandboxes: sandboxes.map((s) => ({
            id: s.id,
            branchName: s.branchName,
            worktreePath: s.worktreePath,
            status: s.status,
            description: s.description,
            createdAt: new Date(s.createdAt).toISOString(),
          })),
        };
      },
    }),

    worktree_diff: tool({
      description: "Get the shell commands to inspect the diff or diffstat of an isolated worktree against base HEAD.",
      inputSchema: z.object({
        sandboxId: z.string().describe("The ID of the sandbox to diff."),
        conciseStatOnly: z.boolean().optional().describe("If true, returns diffstat instead of full diff."),
      }),
      execute: async ({ sandboxId, conciseStatOnly }) => {
        const sandbox = getSandbox(sandboxId);
        if (!sandbox) {
          return { error: `Sandbox '${sandboxId}' not found.` };
        }

        const command = conciseStatOnly
          ? worktreeDiffStatCommand(sandbox.worktreePath)
          : worktreeDiffCommand(sandbox.worktreePath);

        return {
          sandboxId,
          branchName: sandbox.branchName,
          command,
        };
      },
    }),

    worktree_merge: tool({
      description:
        "Generate the merge command to integrate the changes from an isolated worktree branch into the main working tree, then unregisters the sandbox.",
      inputSchema: z.object({
        sandboxId: z.string().describe("The ID of the sandbox to merge."),
        squash: z.boolean().optional().describe("If true, squashes commits when merging."),
      }),
      execute: async ({ sandboxId, squash }) => {
        const sandbox = getSandbox(sandboxId);
        if (!sandbox) {
          return { error: `Sandbox '${sandboxId}' not found.` };
        }

        const mergeCmd = worktreeMergeCommand(sandbox.branchName, squash ?? false);
        const cleanupCmd = `${worktreeRemoveCommand(sandbox.worktreePath)} && ${worktreeDeleteBranchCommand(sandbox.branchName)}`;

        unregisterSandbox(sandboxId, "merged");

        return {
          sandboxId,
          status: "merge_prepared",
          mergeCommand: mergeCmd,
          cleanupCommand: cleanupCmd,
          instruction: "Run mergeCommand in the main repository root, then run cleanupCommand to remove the worktree folder and branch.",
        };
      },
    }),

    worktree_discard: tool({
      description: "Discard and clean up an isolated worktree sandbox without merging its changes.",
      inputSchema: z.object({
        sandboxId: z.string().describe("The ID of the sandbox to discard."),
      }),
      execute: async ({ sandboxId }) => {
        const sandbox = getSandbox(sandboxId);
        if (!sandbox) {
          return { error: `Sandbox '${sandboxId}' not found.` };
        }

        const cleanupCmd = `${worktreeRemoveCommand(sandbox.worktreePath)} && ${worktreeDeleteBranchCommand(sandbox.branchName)}`;
        unregisterSandbox(sandboxId, "discarded");

        return {
          sandboxId,
          status: "discarded",
          cleanupCommand: cleanupCmd,
          instruction: "Run cleanupCommand in the main repository root to remove the worktree folder and branch.",
        };
      },
    }),
  } as const;
}
