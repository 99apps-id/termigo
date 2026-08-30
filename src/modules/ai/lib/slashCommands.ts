import { startPentestRun } from "@/modules/control/lib/startPentestRun";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  CancelCircleIcon,
  CheckListIcon,
  ClaudeIcon,
  CpuIcon,
  Flowchart02Icon,
  HelpCircleIcon,
  ShieldUserIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { compatModelIdForEndpoint, MODELS } from "../config";
import { useApprovalQueue } from "../store/approvalQueueStore";
import { useChatStore } from "../store/chatStore";
import { useCustomCommandsStore } from "../store/customCommandsStore";
import { usePlanStore } from "../store/planStore";
import { useSessionDirectiveStore } from "../store/sessionDirectiveStore";
import {
  formatQueue,
  type PendingApproval,
  parseApprovalTarget,
  resolveTarget,
} from "./approvalQueue";
import { expandCommand } from "./customCommands";
import {
  computeNextDueAt,
  parseScheduleWhen,
  startScheduler,
} from "./scheduler";

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
  goal: {
    name: "goal",
    invocation: "/goal",
    label: "Set the session goal",
    icon: SparklesIcon,
  },
  schedule: {
    name: "schedule",
    invocation: "/schedule",
    label: "Schedule a recurring task",
    icon: CheckListIcon,
  },
  pentest: {
    name: "pentest",
    invocation: "/pentest",
    label: "Start a pentest run",
    icon: ShieldUserIcon,
  },
  pipeline: {
    name: "pipeline",
    invocation: "/pipeline",
    label: "Run an orchestration pipeline",
    icon: Flowchart02Icon,
  },
  new: {
    name: "new",
    invocation: "/new",
    label: "Start a new chat",
    icon: SparklesIcon,
  },
  model: {
    name: "model",
    invocation: "/model",
    label: "Switch the active model",
    icon: CpuIcon,
  },
  stop: {
    name: "stop",
    invocation: "/stop",
    label: "Stop the current run",
    icon: CancelCircleIcon,
  },
  help: {
    name: "help",
    invocation: "/help",
    label: "List slash commands",
    icon: HelpCircleIcon,
  },
};

export const TERMIGO_CMD_RE =
  /^<termigo-command\s+name="([a-z0-9-]+)"(?:\s+state="([a-z]+)")?\s*\/>(?:\n+|$)/;

export function wrapWithCommandMarker(prompt: string, name: string): string {
  return `<termigo-command name="${name}" />\n\n${prompt}`;
}

/** Resolve a user-typed model query to a selectable model id + label. Matches
 *  built-in models by id/label/hint and custom endpoints by name/id, so both
 *  `/model gpt-5.6` and `/model DeepSeek` work. */
function resolveModel(query: string): { id: string; label: string } | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const builtin = MODELS.find(
    (m) =>
      m.id.toLowerCase() === q ||
      m.label.toLowerCase() === q ||
      m.hint.toLowerCase() === q,
  );
  if (builtin) return { id: builtin.id, label: builtin.label };
  for (const ep of usePreferencesStore.getState().customEndpoints) {
    const compatId = compatModelIdForEndpoint(ep.id);
    if (
      ep.id.toLowerCase() === q ||
      ep.name.toLowerCase() === q ||
      compatId.toLowerCase() === q
    ) {
      return { id: compatId, label: ep.name };
    }
  }
  return null;
}

export function tryRunSlashCommand(input: string): SlashOutcome {
  const trimmed = input.trim();
  const lead = trimmed[0];
  if (lead !== "/" && lead !== "#") return { kind: "none" };
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  // A built-in name always wins; otherwise a user-defined command may match.
  const custom = SLASH_COMMANDS[head]
    ? null
    : useCustomCommandsStore.getState().get(head);
  if (lead === "#" && !SLASH_COMMANDS[head] && !custom) return { kind: "none" };
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
    case "goal":
      return respondToGoal(tail);
    case "schedule":
      return respondToSchedule(tail);
    case "pentest":
      return respondToPentest(tail);
    case "pipeline":
      return respondToPipeline(tail);
    case "new":
      // A fresh session clears the whole transcript — the escape hatch when a
      // run has outgrown the model's context window and even a compacted retry
      // cannot fit (or the conversation is just a dead end). The old session
      // stays in the history list, so nothing is lost.
      useChatStore.getState().newSession();
      return { kind: "handled", toast: "New chat started" };
    case "model": {
      const store = useChatStore.getState();
      if (!tail) {
        return {
          kind: "handled",
          toast: `Current model: ${store.selectedModelId}`,
        };
      }
      const found = resolveModel(tail);
      if (!found) {
        return {
          kind: "handled",
          toast: `Unknown model "${tail}". Try /model <id>, e.g. /model gpt-5.6`,
        };
      }
      store.setSelectedModelId(found.id);
      return { kind: "handled", toast: `Model: ${found.label}` };
    }
    case "stop": {
      // Stop the current run. chatRuntime is imported lazily so this file does
      // not pull the AI SDK into the eager graph.
      void (async () => {
        const { stopRun } = await import("../store/chatRuntime");
        await stopRun();
      })().catch(() => {
        toast.error("Could not stop the run");
      });
      return { kind: "handled", toast: "Stopping…" };
    }
    case "help": {
      const list = Object.values(SLASH_COMMANDS)
        .map((c) => `${c.invocation} — ${c.label}`)
        .join("\n");
      return { kind: "handled", toast: `Slash commands\n${list}` };
    }
    default:
      if (custom) {
        return {
          kind: "send-prompt",
          prompt: expandCommand(custom, tail),
          commandName: custom.name,
        };
      }
      return { kind: "none" };
  }
}

function respondToGoal(tail: string): SlashOutcome {
  const sessionId = useChatStore.getState().activeSessionId ?? "";
  const store = useSessionDirectiveStore.getState();
  if (tail === "off") {
    store.setGoal(sessionId, null);
    return { kind: "handled", toast: "Goal cleared" };
  }
  if (!tail) {
    const goal = store.getGoal(sessionId);
    return {
      kind: "handled",
      toast: goal ? `Goal: ${goal}` : "No goal set. Usage: /goal <goal>",
    };
  }
  store.setGoal(sessionId, tail);
  return { kind: "handled", toast: "Goal set" };
}

function respondToSchedule(tail: string): SlashOutcome {
  const sessionId = useChatStore.getState().activeSessionId ?? "";
  const store = useSessionDirectiveStore.getState();
  if (!tail) {
    return {
      kind: "handled",
      toast: "Usage: /schedule <when> <prompt> | list | remove <n>",
    };
  }
  if (tail === "list") {
    const schedules = store.getSchedules(sessionId);
    if (schedules.length === 0) {
      return { kind: "handled", toast: "No scheduled tasks." };
    }
    const lines = schedules.map(
      (s, i) =>
        `${i + 1}. ${s.enabled ? "" : "(paused) "}${s.when}: ${s.prompt}`,
    );
    return { kind: "handled", toast: lines.join("\n") };
  }
  if (tail.startsWith("remove ")) {
    const n = Number(tail.slice(7).trim());
    const schedules = store.getSchedules(sessionId);
    const target = schedules[n - 1];
    if (!target) return { kind: "handled", toast: "No such schedule." };
    store.removeSchedule(sessionId, target.id);
    return { kind: "handled", toast: `Removed schedule ${n}` };
  }
  const sp = tail.indexOf(" ");
  if (sp === -1) {
    return {
      kind: "handled",
      toast: "Usage: /schedule <when> <prompt>",
    };
  }
  const when = tail.slice(0, sp).trim();
  const prompt = tail.slice(sp + 1).trim();
  if (!prompt) {
    return { kind: "handled", toast: "Usage: /schedule <when> <prompt>" };
  }
  const timing = parseScheduleWhen(when);
  const nextDueAt = computeNextDueAt(Date.now(), timing);
  const spec = nextDueAt !== null ? { ...timing, nextDueAt } : undefined;
  store.addSchedule(sessionId, when, prompt, spec);
  if (spec) startScheduler();
  return {
    kind: "handled",
    toast: spec
      ? `Scheduled "${when}": ${prompt}`
      : `Saved "${when}": ${prompt} (no auto-run; use 'every <N>m' or 'daily at HH:MM')`,
  };
}

function respondToPentest(tail: string): SlashOutcome {
  const sp = tail.indexOf(" ");
  const target = (sp === -1 ? tail : tail.slice(0, sp)).trim();
  const category = (sp === -1 ? "" : tail.slice(sp + 1)).trim();
  if (!target) {
    return {
      kind: "handled",
      toast:
        "Usage: /pentest <target> [category] (recon, web, network, subdomains, tls, headers, full, …)",
    };
  }
  // Fire-and-forget: the shared helper (same one the CLI control plane uses)
  // authorizes the target in the pentest scope and sends the guardrail prompt.
  // The run's approvals surface in the chat like any other agent work; a failed
  // start (no active session) is reported as an error toast.
  void startPentestRun(target, category).then((result) => {
    if (!result.ok) {
      console.warn("[termigo] /pentest could not start:", result.message);
    }
  });
  return {
    kind: "handled",
    toast: category
      ? `Starting ${category} pentest against ${target}…`
      : `Starting pentest against ${target}…`,
  };
}

function respondToPipeline(tail: string): SlashOutcome {
  const name = tail.trim();
  if (!name) {
    return {
      kind: "handled",
      toast: "Usage: /pipeline <name> | list",
    };
  }
  if (name === "list") {
    // The orchestrator module statically imports the AI SDK; importing it here
    // would drag it into the eager startup bundle, so it is loaded on demand
    // (the same budget guard that keeps composer cheap applies to slash
    // commands).
    void import("./orchestrator")
      .then(({ listPipelines }) => listPipelines())
      .then((pipelines) => {
        if (pipelines.length === 0) {
          toast.error("No pipelines in .termigo/pipelines/");
          return;
        }
        toast(
          `Pipelines:\n${pipelines
            .map(
              (p) =>
                `• ${p.id} — ${p.steps.length} steps${p.description ? ` (${p.description})` : ""}`,
            )
            .join("\n")}`,
        );
      })
      .catch(() => toast.error("Could not list pipelines"));
    return { kind: "handled", toast: "Listing pipelines…" };
  }
  // Fire-and-forget: the helper validates the pipeline file, then sends a
  // prompt that runs it through the `orchestrate` tool, so step progress is
  // visible in the chat transcript like any other agent work.
  void import("./orchestrator")
    .then(({ runPipelineByName }) => runPipelineByName(name))
    .then((result) => {
      if (!result.ok) {
        toast.error(result.message ?? "Could not start pipeline");
      } else {
        toast(`Started pipeline ${name}`);
      }
    });
  return { kind: "handled", toast: `Starting pipeline ${name}…` };
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
    const detail =
      queue.length > 1
        ? `
${formatQueue(queue)}`
        : "";
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
