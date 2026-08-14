// Loading, saving and running custom tools. The rules live in customTools.ts;
// this is the part that touches the filesystem and the shell.

import { dynamicTool, jsonSchema, type Tool } from "ai";
import { sshExec } from "@/modules/ssh/bridge";
import { native } from "./native";
import { checkShellCommand } from "./security";
import { shellQuote } from "./remoteSearch";
import {
  type CustomTool,
  customToolName,
  describeCustomTool,
  formatToolsFile,
  parseToolsFile,
  renderCommand,
  toolInputSchema,
  TOOLS_REL_PATH,
  upsertTool,
  validateTool,
} from "./customTools";

function toolsPath(workspaceRoot: string): string {
  return `${workspaceRoot.replace(/[\\/]$/, "")}/${TOOLS_REL_PATH}`;
}

export async function loadCustomTools(
  workspaceRoot: string | null,
): Promise<CustomTool[]> {
  if (!workspaceRoot) return [];
  try {
    const read = await native.readFile(toolsPath(workspaceRoot));
    if (read.kind !== "text") return [];
    return parseToolsFile(read.content);
  } catch {
    return []; // no tools file is the normal case
  }
}

export type SaveToolOutcome =
  | { saved: true; replaced: boolean; total: number }
  | { saved: false; reason: string };

export async function saveCustomTool(
  workspaceRoot: string | null,
  tool: CustomTool,
): Promise<SaveToolOutcome> {
  if (!workspaceRoot) {
    return { saved: false, reason: "no workspace is open, so there is nowhere to store this" };
  }
  const valid = validateTool(tool);
  if (!valid.ok) return { saved: false, reason: valid.reason };

  const existing = await loadCustomTools(workspaceRoot);
  const replaced = existing.some((t) => t.name === tool.name);
  const next = upsertTool(existing, tool);

  try {
    await native.createDir(`${workspaceRoot.replace(/[\\/]$/, "")}/.termigo`);
  } catch {
    // Already there, or the write reports a clearer failure.
  }
  await native.writeFile(toolsPath(workspaceRoot), formatToolsFile(next));
  return { saved: true, replaced, total: next.length };
}

export type CustomToolset = Record<string, Tool>;

export type CustomToolDeps = {
  getRemoteSession: () => { sessionId: number; cwd: string | null } | null;
  getCwd: () => string | null;
  runLocal: (command: string, cwd: string | null) => Promise<unknown>;
};

/**
 * Build callable tools from the stored definitions.
 *
 * Execution deliberately reuses the paths a command already takes: the safety
 * check that guards bash_run runs here too, and an open SSH session sends the
 * command to the server exactly as bash_run would. A custom tool can therefore
 * not do anything the agent could not already do - it only makes a command
 * worth repeating something the model can find and call by name.
 */
export function buildCustomTools(
  tools: readonly CustomTool[],
  deps: CustomToolDeps,
): CustomToolset {
  const out: CustomToolset = {};
  for (const tool of tools) {
    out[customToolName(tool.name)] = dynamicTool({
      description: describeCustomTool(tool),
      inputSchema: jsonSchema(toolInputSchema(tool)),
      // Always. A custom tool runs a shell command, and the tier for that is
      // exec regardless of who wrote the template.
      needsApproval: true,
      execute: async (args) => {
        const rendered = renderCommand(tool, (args ?? {}) as Record<string, unknown>);
        if (!rendered.ok) return { error: rendered.reason, tool: tool.name };

        // The same gate bash_run uses. The template came from the model, so it
        // gets no more trust than a command the model types directly.
        const safety = checkShellCommand(rendered.command);
        if (!safety.ok) return { error: safety.reason, command: rendered.command };

        const remote = deps.getRemoteSession();
        if (remote) {
          const full = remote.cwd
            ? `cd ${shellQuote(remote.cwd)} && ${rendered.command}`
            : rendered.command;
          try {
            const r = await sshExec(remote.sessionId, full);
            return {
              tool: tool.name,
              command: rendered.command,
              remote: true,
              cwd: remote.cwd,
              stdout: r.stdout,
              stderr: r.stderr,
              exit_code: r.exitCode,
              truncated: r.truncated,
            };
          } catch (e) {
            return { error: String(e), tool: tool.name, remote: true };
          }
        }

        try {
          const result = await deps.runLocal(rendered.command, deps.getCwd());
          return { tool: tool.name, command: rendered.command, ...(result as object) };
        } catch (e) {
          return { error: String(e), tool: tool.name, command: rendered.command };
        }
      },
    });
  }
  return out;
}
