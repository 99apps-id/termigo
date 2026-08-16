import { generateText, stepCountIs } from "ai";
import { DEFAULT_MODEL_ID, getModel, type ModelId } from "../config";
import { buildLanguageModel } from "../lib/agent";
import type { ProviderKeys } from "../lib/keyring";
import type { ToolContext } from "../tools/context";
import { buildFsTools } from "../tools/fs";
import { buildSearchTools } from "../tools/search";
import { buildEditTools } from "../tools/edit";
import { summarizeInput } from "../lib/approvalQueue";
import { subagentWriteNeedsApproval } from "../lib/approvalPolicy";
import { useApprovalQueue } from "../store/approvalQueueStore";
import { useChatStore } from "../store/chatStore";
import { usePlanStore } from "../store/planStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { native } from "../lib/native";
import { SUBAGENTS, type SubagentType } from "./registry";

const SUBAGENT_MAX_STEPS = 12;

type Args = {
  type: SubagentType;
  prompt: string;
  keys: ProviderKeys;
  modelId: string;
  toolContext: ToolContext;
  lmstudioBaseURL?: string;
  onStep?: (label: string) => void;
  /** Label shown in the approval queue: "builder #2". */
  requester?: string;
  abortSignal?: AbortSignal;
};

/** Writes a sub-agent may perform only after the user says so. */
const GATED = new Set(["write_file", "create_directory", "edit", "multi_edit"]);

type AnyTool = { execute?: (input: never, opts: never) => unknown };

/**
 * Make a tool ask before it acts.
 *
 * The SDK's own `needsApproval` cannot be used here: it works by ending the
 * run and resuming from the next request, and a sub-agent has no message
 * boundary to end at. `execute` is plain async code in the same runtime as the
 * UI, so it can just wait for the user - which is what the approval queue is.
 */
function gate<T extends AnyTool>(
  tool: T,
  toolName: string,
  requester: string,
  abortSignal?: AbortSignal,
): T {
  const inner = tool.execute;
  if (!inner) return tool;
  return {
    ...tool,
    execute: async (input: never, opts: never) => {
      const mustAsk = subagentWriteNeedsApproval(
        toolName,
        usePreferencesStore.getState().agentApprovalMode,
        {
          planActive: usePlanStore.getState().active,
          onRemoteHost: !!useChatStore.getState().live.getRemoteSession(),
        },
      );
      if (!mustAsk) return inner(input, opts);

      const approved = await useApprovalQueue.getState().request(
        { requester, toolName, summary: summarizeInput(input) },
        abortSignal,
      );
      if (!approved) {
        return {
          error:
            "denied by the user. Do not retry this write; report it as not done.",
        };
      }
      return inner(input, opts);
    },
  };
}

/**
 * Refuse `write_file` on a path that already exists.
 *
 * `edit` fails loudly when a sibling changed the file first, because it has to
 * match `old_string`. `write_file` has no such check - it replaces the whole
 * file - so with several builders running it is the one call that can silently
 * destroy another's work. Creating new files stays allowed, which is what a
 * builder actually needs.
 */
function newFilesOnly<T extends AnyTool>(tool: T): T {
  const inner = tool.execute;
  if (!inner) return tool;
  return {
    ...tool,
    execute: async (input: never, opts: never) => {
      const path = (input as { path?: unknown })?.path;
      if (typeof path === "string") {
        const existing = await native.readFile(path).catch(() => null);
        if (existing) {
          return {
            error: `${path} already exists. A builder may only create new files - use edit for an existing one.`,
          };
        }
      }
      return inner(input, opts);
    },
  };
}

type RunResult = {
  summary: string;
  stepCount: number;
  durationMs: number;
};

export async function runSubagent({
  type,
  prompt,
  keys,
  modelId,
  toolContext,
  lmstudioBaseURL,
  onStep,
  requester,
  abortSignal,
}: Args): Promise<RunResult> {
  const def = SUBAGENTS[type];
  if (!def) throw new Error(`unknown subagent type: ${type}`);

  // Its own read history. The invariant `edit` enforces - read this file before
  // changing it - is meaningless if it can be satisfied by a read some other
  // agent did, which is what sharing the parent's cache amounted to.
  const ctx: ToolContext = { ...toolContext, readCache: new Map() };

  const available: Record<string, unknown> = {
    ...buildFsTools(ctx),
    ...buildSearchTools(ctx),
    ...buildEditTools(ctx),
  };

  const tools: Record<string, unknown> = {};
  for (const t of def.tools) {
    const found = available[t];
    if (!found) continue;
    if (!GATED.has(t)) {
      tools[t] = found;
      continue;
    }
    const guarded = t === "write_file" ? newFilesOnly(found as AnyTool) : found;
    tools[t] = gate(guarded as AnyTool, t, requester ?? type, abortSignal);
  }

  const model = await buildLanguageModel(
    getModel(modelId as ModelId).provider,
    keys,
    getModel(modelId as ModelId).id,
    { lmstudioBaseURL },
  );

  const start = Date.now();
  const result = await generateText({
    model,
    system: def.systemPrompt,
    prompt,
    tools: tools as Parameters<typeof generateText>[0]["tools"],
    stopWhen: stepCountIs(SUBAGENT_MAX_STEPS),
    // Stop has to reach a sub-agent too. Without this, stopping the main run
    // left every spawned agent working - harmless while they only read, not
    // once they write.
    abortSignal,
    onStepFinish: (step) => {
      if (!onStep) return;
      const last = step.toolCalls?.[step.toolCalls.length - 1];
      if (last) onStep(`${type}: ${last.toolName}`);
    },
  });

  return {
    summary: result.text || "(no output)",
    stepCount: result.steps?.length ?? 0,
    durationMs: Date.now() - start,
  };
}

export const DEFAULT_SUBAGENT_MODEL: ModelId = DEFAULT_MODEL_ID;
