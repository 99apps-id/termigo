import type { HarnessProfile } from "../lib/harnessProfile";
import { applyProfileToTools } from "../lib/harnessProfile";
import {
  type SubagentType,
  subagentDef,
  subagentIsReadOnly,
  subagentNeedsVision,
} from "./registry";
import {
  resolveSubagentLabel,
  resolveSubagentType,
  routeSubagentType,
} from "./resolveSubagent";

/**
 * Agent registry + lifecycle centralization.
 *
 * One place that turns a request ("run a sub-agent of type X", "build the
 * main agent for this workspace") into a concrete, runnable agent spec and a
 * context-safe toolset:
 *
 * - `buildSubagentSpec` resolves a loose type (id / label / synonym / domain
 *   route) against the roster in `registry.ts`, applies the active harness
 *   profile's prompt prelude, and carries the agent's capabilities (vision,
 *   read-only) and step budget.
 * - `buildAgentTools` is the context-safe tool injection: it applies the
 *   profile's reorder/hide rules and, for a nested agent, withholds the spawn
 *   tools at the nesting cap. Both the main run and every sub-agent go through
 *   it, so a profile consistently shapes every agent instead of only the main
 *   one.
 * - `resolveAgentForPrompt` is the routing entry point: an explicit type wins,
 *   otherwise the prompt's domain classifies it.
 */

/** Shared step budget for one sub-agent run unless a def overrides it. */
export const DEFAULT_SUBAGENT_MAX_STEPS = 12;

/** Default nesting cap when no preference is available (see runSubagent). */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 3;

/** Tools that spawn sub-agents — the only ones the depth cap governs. */
export const SPAWN_TOOLS = new Set(["run_subagent", "run_subagents"]);

/** A fully-resolved, runnable agent description. */
export type AgentSpec = {
  id: SubagentType;
  label: string;
  description: string;
  systemPrompt: string;
  /** Needs a vision-capable model to do its job. */
  needsVision: boolean;
  /** Read-tier only by design (never writes or executes). */
  readOnly: boolean;
  /** Step budget for one run. */
  maxSteps: number;
};

/** Whether spawn tools should be withheld at a nesting depth. */
export function spawnToolsWithheld(depth: number, maxDepth: number): boolean {
  return depth >= maxDepth;
}

/**
 * Context-safe tool injection.
 *
 * Applies the harness profile's tool rules (reorder `prioritizeTools`, drop
 * `hideTools`) to any agent's toolset, and — when `depth` is given — withholds
 * the spawn tools at the nesting cap so a sub-agent cannot recurse without
 * bound. The main agent passes no `depth`, so its spawn tools are never
 * withheld. `maxDepth` is passed in (not read from the store) so the factory
 * stays pure and testable; the runner supplies `effectiveSubagentMaxDepth()`.
 */
export function buildAgentTools<T>(
  tools: Record<string, T>,
  opts: { profile?: HarnessProfile; depth?: number; maxDepth?: number } = {},
): Record<string, T> {
  const profiled = opts.profile
    ? applyProfileToTools(tools, opts.profile)
    : { ...tools };

  const depth = opts.depth;
  if (depth === undefined) return profiled;

  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
  if (!spawnToolsWithheld(depth, maxDepth)) return profiled;

  const out: Record<string, T> = {};
  for (const [name, tool] of Object.entries(profiled)) {
    if (SPAWN_TOOLS.has(name)) continue;
    out[name] = tool;
  }
  return out;
}

/** Prepend a profile's prompt prelude to a base system prompt (string form). */
function applyPrelude(prompt: string, profile?: HarnessProfile): string {
  const prelude = profile?.promptPrelude?.trim();
  return prelude ? `${prelude}\n\n${prompt}` : prompt;
}

/**
 * Build the runnable spec for a sub-agent from a loose type + the active
 * harness profile. Resolves ids, labels, synonyms and domain routes exactly
 * the way the runtime does, so the spec the caller shows is the agent that
 * actually runs.
 */
export function buildSubagentSpec(
  type: SubagentType | string,
  profile?: HarnessProfile,
): AgentSpec {
  const id = resolveSubagentType(type);
  const def = subagentDef(id);
  return {
    id,
    label: def.label,
    description: def.description,
    systemPrompt: applyPrelude(def.systemPrompt, profile),
    needsVision: subagentNeedsVision(id),
    readOnly: subagentIsReadOnly(id),
    maxSteps: def.maxSteps ?? DEFAULT_SUBAGENT_MAX_STEPS,
  };
}

export type ResolvedAgent = {
  type: SubagentType;
  label: string;
  route: string | null;
};

/**
 * Routing entry point: an explicit type (id / label / synonym) wins; without
 * one the prompt's domain classifies the agent (frontend/backend → builder,
 * infra → general, testing → code-review), falling back to `general`. Mirrors
 * what `run_subagent` and `run_subagents` do, so previews and the runtime
 * agree.
 */
export function resolveAgentForPrompt(
  prompt: string,
  explicitType?: string,
): ResolvedAgent {
  const raw = (explicitType ?? "").trim();
  if (raw) {
    const type = resolveSubagentType(raw);
    return { type, label: resolveSubagentLabel(raw), route: null };
  }
  const routed = routeSubagentType(prompt ?? "");
  return {
    type: routed.type,
    label: resolveSubagentLabel(routed.type),
    route: routed.route,
  };
}
