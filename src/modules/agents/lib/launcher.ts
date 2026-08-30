import type { PaneNode } from "@/modules/terminal";
import { makePersistKey } from "@/modules/terminal/lib/persistTerminals";

export const AGENT_LAUNCHERS = [
  {
    id: "claude",
    label: "Claude",
    defaultCommand: "claude",
    supportsHooks: true,
  },
  {
    id: "codex",
    label: "Codex",
    defaultCommand: "codex",
    supportsHooks: true,
  },
  {
    id: "gemini",
    label: "Gemini",
    defaultCommand: "gemini",
    supportsHooks: true,
  },
  {
    id: "pi",
    label: "Pi",
    defaultCommand: "pi",
    supportsHooks: true,
  },
  {
    id: "opencode",
    label: "OpenCode",
    defaultCommand: "opencode",
    supportsHooks: false,
  },
  {
    id: "grok",
    label: "Grok",
    defaultCommand: "grok",
    supportsHooks: false,
  },
  {
    id: "aider",
    label: "Aider",
    defaultCommand: "aider",
    supportsHooks: false,
  },
  {
    id: "qwen",
    label: "Qwen",
    defaultCommand: "qwen",
    supportsHooks: false,
  },
  {
    id: "cursor",
    label: "Cursor",
    defaultCommand: "cursor",
    supportsHooks: false,
  },
] as const;

export type AgentLauncherId = (typeof AGENT_LAUNCHERS)[number]["id"];
export type AgentInstanceCount = 1 | 2 | 3 | 4;
export type AgentLaunchCommands = Record<AgentLauncherId, string>;

/** A user-defined coding-agent CLI registered in Settings. */
export type CustomAgentLauncher = {
  id: string;
  label: string;
  command: string;
};

/** Any launcher (built-in or user-defined) once its command is resolved. */
export type ResolvedAgentLauncher = {
  id: string;
  label: string;
  defaultCommand: string;
  supportsHooks: boolean;
};

export type AgentLaunchRequest = {
  agent: string;
  command: string;
  instances: AgentInstanceCount;
};

export const DEFAULT_AGENT_LAUNCH_COMMANDS: AgentLaunchCommands =
  Object.fromEntries(
    AGENT_LAUNCHERS.map((agent) => [agent.id, agent.defaultCommand]),
  ) as AgentLaunchCommands;

const MAX_AGENT_COMMAND_LENGTH = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export type AgentCommandValidation =
  | { ok: true; command: string }
  | { ok: false; error: string };

export function validateAgentLaunchCommand(
  value: unknown,
): AgentCommandValidation {
  if (typeof value !== "string") {
    return { ok: false, error: "Enter a start command." };
  }
  const command = value.trim();
  if (!command) return { ok: false, error: "Enter a start command." };
  if (command.length > MAX_AGENT_COMMAND_LENGTH) {
    return {
      ok: false,
      error: `Keep the command under ${MAX_AGENT_COMMAND_LENGTH} characters.`,
    };
  }
  if (CONTROL_CHARACTERS.test(command)) {
    return { ok: false, error: "Use a single-line command." };
  }
  return { ok: true, command };
}

export function normalizeAgentLaunchCommands(
  value: unknown,
): AgentLaunchCommands {
  const stored =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    AGENT_LAUNCHERS.map((agent) => {
      const result = validateAgentLaunchCommand(stored[agent.id]);
      return [
        agent.id,
        result.ok ? result.command : agent.defaultCommand,
      ] as const;
    }),
  ) as AgentLaunchCommands;
}

export function findAgentLauncher(id: string) {
  return AGENT_LAUNCHERS.find((agent) => agent.id === id) ?? AGENT_LAUNCHERS[0];
}

const MAX_CUSTOM_AGENT_ID_LENGTH = 32;
const MAX_CUSTOM_AGENT_LABEL_LENGTH = 40;

/** Coerce an unknown stored value into a valid custom agent, or null. */
export function sanitizeCustomAgent(
  value: unknown,
): CustomAgentLauncher | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const label = typeof obj.label === "string" ? obj.label.trim() : "";
  const command = typeof obj.command === "string" ? obj.command.trim() : "";
  if (!id || !label || !command) return null;
  if (id.length > MAX_CUSTOM_AGENT_ID_LENGTH) return null;
  if (label.length > MAX_CUSTOM_AGENT_LABEL_LENGTH) return null;
  if (command.length > MAX_AGENT_COMMAND_LENGTH) return null;
  if (
    CONTROL_CHARACTERS.test(id) ||
    CONTROL_CHARACTERS.test(label) ||
    CONTROL_CHARACTERS.test(command)
  ) {
    return null;
  }
  return { id, label, command };
}

/** Load persisted custom agents, dropping invalid, duplicate, or built-in ids. */
export function normalizeCustomAgentLaunchers(
  value: unknown,
): CustomAgentLauncher[] {
  if (!Array.isArray(value)) return [];
  const builtinIds = new Set<string>(AGENT_LAUNCHERS.map((a) => a.id));
  const seen = new Set<string>(builtinIds);
  const result: CustomAgentLauncher[] = [];
  for (const item of value) {
    const agent = sanitizeCustomAgent(item);
    if (!agent) continue;
    if (seen.has(agent.id)) continue;
    seen.add(agent.id);
    result.push(agent);
  }
  return result;
}

/** All launchable agents: built-ins first, then user-defined. */
export function getAgentLaunchers(
  customAgents: readonly CustomAgentLauncher[] = [],
): ResolvedAgentLauncher[] {
  const builtinIds = new Set<string>(AGENT_LAUNCHERS.map((a) => a.id));
  return [
    ...AGENT_LAUNCHERS.map(({ id, label, defaultCommand, supportsHooks }) => ({
      id,
      label,
      defaultCommand,
      supportsHooks,
    })),
    ...customAgents
      .filter((c) => !builtinIds.has(c.id))
      .map(({ id, label, command }) => ({
        id,
        label,
        defaultCommand: command,
        supportsHooks: false,
      })),
  ];
}

/** Resolve a launcher by id. Custom agents are honoured; unknown ids fall back
 *  to the first built-in launchable agent. */
export function findAgentLauncherWithCustom(
  id: string,
  customAgents: readonly CustomAgentLauncher[] = [],
): ResolvedAgentLauncher {
  const launchers = getAgentLaunchers(customAgents);
  return launchers.find((agent) => agent.id === id) ?? AGENT_LAUNCHERS[0];
}

export type AgentPanePlan = {
  paneTree: PaneNode;
  leafIds: number[];
};

export function createAgentPanePlan(
  instances: AgentInstanceCount,
  allocateId: () => number,
  cwd?: string,
): AgentPanePlan {
  if (!Number.isInteger(instances) || instances < 1 || instances > 4) {
    throw new RangeError("Agent instance count must be between 1 and 4.");
  }

  const leaves = Array.from({ length: instances }, () => {
    const id = allocateId();
    return {
      kind: "leaf" as const,
      id,
      cwd,
      persistKey: makePersistKey(cwd, String(id)),
    };
  });
  const split = (dir: "row" | "col", children: PaneNode[]): PaneNode => ({
    kind: "split",
    id: allocateId(),
    dir,
    children,
  });

  switch (instances) {
    case 1:
      return { paneTree: leaves[0], leafIds: leaves.map((leaf) => leaf.id) };
    case 2:
      return {
        paneTree: split("row", leaves),
        leafIds: leaves.map((leaf) => leaf.id),
      };
    case 3:
      return {
        paneTree: split("row", [
          leaves[0],
          split("col", [leaves[1], leaves[2]]),
        ]),
        leafIds: leaves.map((leaf) => leaf.id),
      };
    case 4:
      return {
        paneTree: split("row", [
          split("col", [leaves[0], leaves[1]]),
          split("col", [leaves[2], leaves[3]]),
        ]),
        leafIds: leaves.map((leaf) => leaf.id),
      };
  }
}
