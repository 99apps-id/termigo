import {
  CheckListIcon,
  ClaudeIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { usePlanStore } from "../store/planStore";
import { useChatStore } from "../store/chatStore";
import { useApprovalQueue } from "../store/approvalQueueStore";
import {
  formatQueue,
  parseApprovalTarget,
  resolveTarget,
  type PendingApproval,
} from "./approvalQueue";

/**
 * Outcome of intercepting a slash command from the composer.
 *
 * - `"handled"`: command ran; the composer should NOT send a chat message.
 * - `"send-prompt"`: replace the user's text with `prompt` and send normally.
 * - `"none"`: not a slash command; let the composer behave as usual.
 */
export type SlashOutcome =
  | { kind: "handled"; toast?: string }
  | { kind: "send-prompt"; prompt: string; commandName?: string }
  | { kind: "none" };

function claudeCodeDirective(request: string): string {
  return `The user wants to drive a Claude Code agent through you. Their request:

<request>
${request}
</request>

You are the orchestrator, not the implementer. Do not write the code yourself.
1. Call read_agent_output to see whether a Claude Code agent is already active in this session.
2. If none is active: turn the request into one clear, complete, self-contained prompt (state the concrete goal, relevant constraints, and what "done" looks like) and call spawn_coding_agent with it.
3. If one is active: read its latest output, then craft a precise follow-up and call send_to_agent.
Sharpen vague requests into precise engineering instructions; keep each agent prompt focused on one coherent unit of work.`;
}

const INIT_PROMPT = `Scan this workspace and produce TERMIGO.md at the workspace root with:

- One-paragraph project description.
- Build / test / dev commands.
- Architecture overview (subsystems, data flow, key dirs).
- Conventions worth knowing (naming, patterns, gotchas).
- Paths to entry points.

Use grep/glob/list_directory/read_file to explore. Cap TERMIGO.md under 200 lines. Use write_file to create it (will go through normal approval).`;

export type SlashCommandMeta = {
  name: string;
  invocation: string;
  label: string;
  icon: typeof SparklesIcon;
};

export const SLASH_COMMANDS: Record<string, SlashCommandMeta> = {
  approve: {
    name: "approve",
    invocation: "/approve",
    label: "Approve waiting work",
    icon: CheckListIcon,
  },
  deny: {
    name: "deny",
    invocation: "/deny",
    label: "Deny waiting work",
    icon: CheckListIcon,
  },
  init: {
    name: "init",
    invocation: "/init",
    label: "Initialize workspace",
    icon: SparklesIcon,
  },
  plan: {
    name: "plan",
    invocation: "/plan",
    label: "Plan mode",
    icon: CheckListIcon,
  },
  "claude-code": {
    name: "claude-code",
    invocation: "/claude-code",
    label: "Delegate to Claude Code",
    icon: ClaudeIcon,
  },
};

export const TERMIGO_CMD_RE =
  /^<termigo-command\s+name="([a-z0-9-]+)"(?:\s+state="([a-z]+)")?\s*\/>(?:\n+|$)/;

export function wrapWithCommandMarker(prompt: string, name: string): string {
  return `<termigo-command name="${name}" />\n\n${prompt}`;
}

export function tryRunSlashCommand(input: string): SlashOutcome {
  const trimmed = input.trim();
  const lead = trimmed[0];
  if (lead !== "/" && lead !== "#") return { kind: "none" };
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  if (lead === "#" && !SLASH_COMMANDS[head]) return { kind: "none" };
  const tail = rest.join(" ").trim();

  switch (head) {
    case "plan": {
      const store = usePlanStore.getState();
      if (tail === "off" || tail === "exit") {
        store.disable();
        return { kind: "handled", toast: "Plan mode off" };
      }
      store.toggle();
      const nowActive = usePlanStore.getState().active;
      return {
        kind: "handled",
        toast: nowActive ? "Plan mode on" : "Plan mode off",
      };
    }
    case "init": {
      return {
        kind: "send-prompt",
        prompt: INIT_PROMPT,
        commandName: "init",
      };
    }
    case "claude-code": {
      if (!tail) {
        return { kind: "handled", toast: "Usage: /claude-code <request>" };
      }
      return {
        kind: "send-prompt",
        prompt: claudeCodeDirective(tail),
        commandName: "claude-code",
      };
    }
    case "approve":
      return respondToWaiting(tail, true);
    case "deny":
      return respondToWaiting(tail, false);
    default:
      return { kind: "none" };
  }
}

/**
 * Everything waiting on the user, main agent and sub-agents together, in one
 * numbering.
 *
 * They arrive by different routes - the main agent's approvals ride the SDK
 * message round-trip, a sub-agent's block on a promise - but the person
 * answering should not have to know which. The main agent's come first because
 * its work is what the sub-agents were spawned from.
 */
function waitingQueue(): PendingApproval[] {
  const meta = useChatStore.getState().agentMeta;
  const fromAgent: PendingApproval[] = meta.pendingApprovals.map((a) => ({
    id: a.id,
    requester: "agent",
    toolName: a.toolName,
    summary: a.summary,
    requestedAt: 0,
  }));
  return [...fromAgent, ...useApprovalQueue.getState().pending];
}

function respondToWaiting(arg: string, approved: boolean): SlashOutcome {
  const verb = approved ? "Approved" : "Denied";
  const queue = waitingQueue();

  if (arg.trim().toLowerCase() === "list" || arg.trim() === "?") {
    return { kind: "handled", toast: formatQueue(queue) };
  }

  const target = parseApprovalTarget(arg);
  if (!target) {
    return {
      kind: "handled",
      toast: `Usage: /${approved ? "approve" : "deny"} [n | all | list]`,
    };
  }

  const picked = resolveTarget(queue, target);
  if ("error" in picked) {
    const detail = queue.length > 1 ? `
${formatQueue(queue)}` : "";
    return { kind: "handled", toast: `${picked.error}${detail}` };
  }

  const ids = new Set(picked.ids);
  const agentIds = queue
    .filter((q) => q.requester === "agent" && ids.has(q.id))
    .map((q) => q.id);
  const queueIds = picked.ids.filter((id) => !agentIds.includes(id));

  for (const id of agentIds) {
    useChatStore.getState().respondToApproval(id, approved);
  }
  if (queueIds.length > 0) {
    useApprovalQueue.getState().respond(queueIds, approved);
  }

  const n = agentIds.length + queueIds.length;
  return { kind: "handled", toast: `${verb} ${n}` };
}
