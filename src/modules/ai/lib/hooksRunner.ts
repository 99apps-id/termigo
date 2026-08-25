// Hook execution: writes payload files and runs hook commands.
//
// Payloads live in `.termigo/hooks/<runId>/` so concurrent runs never collide.
// Each hook command receives the payload JSON path as its only argument. The
// command reads the file, acts on it, and exits. Nothing is piped into stdin
// and no environment variables are set, so a hook cannot be tricked into
// executing injected content.

import { native } from "./native";
import { shellQuote } from "./remoteSearch";
import { checkShellCommand } from "./security";
import {
  type HookEvent,
  type HookRule,
  type HooksConfig,
  matchingHooks,
} from "./hooks";

/** Unique id for the current agent run. */
export type RunId = string;

/**
 * Build a stable run id for the current agent execution.
 *
 * The id is derived from the session id and a timestamp so it is unique per
 * run but stable enough to be useful in logs.
 */
export function makeRunId(sessionId: string | null): RunId {
  const ts = Date.now().toString(36);
  const sid = sessionId ? sessionId.slice(-8) : "nosession";
  return `run-${ts}-${sid}`;
}

/**
 * Directory inside `.termigo` where hook payloads for one run are stored.
 */
function hooksRunDir(workspaceRoot: string, runId: RunId): string {
  return `${workspaceRoot.replace(/[\\/]$/, "")}/.termigo/hooks/${runId}`;
}

/**
 * Write a hook payload to disk and return the path.
 *
 * The payload is a JSON file describing the event. The hook command receives
 * this path as its only argument.
 */
async function writePayload(
  workspaceRoot: string,
  runId: RunId,
  event: HookEvent,
  payload: Record<string, unknown>,
): Promise<string | null> {
  if (!workspaceRoot) return null;
  const dir = hooksRunDir(workspaceRoot, runId);
  try {
    await native.createDir(dir);
  } catch {
    // Already there, or the write reports a clearer failure.
  }
  const seq = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const path = `${dir}/${seq}-${event.toLowerCase()}.json`;
  try {
    await native.writeFile(path, JSON.stringify(payload, null, 2));
  } catch {
    return null;
  }
  return path;
}

/**
 * Execute one hook rule for an event.
 *
 * The command receives the payload path as its only argument. Failures are
 * swallowed: a broken hook must not block the agent run it is observing.
 */
async function fireHook(
  rule: HookRule,
  payloadPath: string | null,
  cwd: string | null,
): Promise<void> {
  if (!payloadPath) return;
  const command = `${rule.command} ${shellQuote(payloadPath)}`;
  // The same gate bash_run and custom tools use. A hook runs a shell command
  // the project author wrote, but it gets no more trust than a command the
  // model types directly: a broken or hostile hook must not open a path the
  // agent could not already use.
  const safety = checkShellCommand(command);
  if (!safety.ok) return;
  try {
    await native.runCommand(command, cwd ?? undefined, 30);
  } catch {
    // Hooks are advisory. A failing hook must not block the run.
  }
}

/**
 * Fire all matching hooks for an event.
 *
 * `toolName` is the name of the tool being called. Pass `null` for events
 * that have no tool context (Stop).
 */
export async function fireHooksForEvent(
  config: HooksConfig,
  event: HookEvent,
  toolName: string | null,
  payload: Record<string, unknown>,
  deps: {
    getWorkspaceRoot: () => string | null;
    getCwd: () => string | null;
    makeRunId: () => RunId;
  },
): Promise<void> {
  const rules = matchingHooks(config, event, toolName);
  if (rules.length === 0) return;

  const workspaceRoot = deps.getWorkspaceRoot();
  if (!workspaceRoot) return;
  const runId = deps.makeRunId();
  const cwd = deps.getCwd();
  const payloadPath = await writePayload(workspaceRoot, runId, event, {
    ...payload,
    runId,
    event,
    tool: toolName,
    at: Date.now(),
  });

  // Fire sequentially so a slow hook does not pile up processes. Each hook
  // is fire-and-forget internally; the outer loop just preserves order.
  for (const rule of rules) {
    await fireHook(rule, payloadPath, cwd);
  }

  // Clean up the payload directory after Stop hooks so `.termigo/hooks` does
  // not grow without bound. Pre/Post hooks leave payloads in place so the
  // user can inspect them while the run is in flight.
  if (event === "Stop" && payloadPath) {
    try {
      await native.deletePath(hooksRunDir(workspaceRoot ?? "", runId));
    } catch {
      // Cleanup is best-effort.
    }
  }
}
