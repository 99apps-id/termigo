import { getAgentLaunchers } from "@/modules/agents/lib/launcher";
import { useManagedAgentsStore } from "@/modules/agents/store/managedAgentsStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { writeToSession } from "@/modules/terminal";
import { tool } from "ai";
import { z } from "zod";
import { remoteUnsupported } from "../lib/remoteFs";
import type { ToolContext } from "./context";

// Claude Code's TUI treats a trailing CR in the same write chunk as the text
// as a literal newline, not a submit. Send the Enter as a separate chunk once
// the input has rendered so it registers as a standalone keypress.
const SUBMIT_DELAY_MS = 90;

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function tailLines(text: string, n: number): string {
  const parts = text.split("\n");
  return parts.length <= n ? text : parts.slice(parts.length - n).join("\n");
}

export function buildManagedAgentTools(ctx: ToolContext) {
  const customAgentLaunchers =
    usePreferencesStore.getState().customAgentLaunchers ?? [];
  const launchers = getAgentLaunchers(customAgentLaunchers);
  const agentIds = launchers.map((a) => a.id) as [string, ...string[]];
  const agentList = launchers.map((a) => a.id).join(", ");
  const hookAgentList = launchers
    .filter((a) => a.supportsHooks)
    .map((a) => a.id)
    .join("/");

  return {
    spawn_coding_agent: tool({
      description: `Spawn an external coding-agent CLI in a new terminal tab and give it the prompt. Use this when the user wants work delegated and no agent is active yet in this session. Craft a complete, self-contained prompt first; the user approves it before the agent starts. Do not call this if an agent is already active — use send_to_agent instead. Supported agents: ${agentList} (defaults to claude; the CLI must be installed and on PATH).`,
      inputSchema: z.object({
        prompt: z
          .string()
          .min(1)
          .describe("The full, self-contained task prompt for the agent."),
        agent: z
          .enum(agentIds)
          .optional()
          .describe(
            `Which coding-agent CLI to launch (${agentList}). Defaults to claude. Pick what the user asked for; only ${hookAgentList} support activity hooks.`,
          ),
      }),
      needsApproval: true,
      execute: async ({ prompt, agent }) => {
        // Claude Code runs in a local terminal tab. With an SSH terminal
        // focused the model is usually thinking about the server, and would
        // hand the task to an agent on the wrong machine - which looks like it
        // worked, because a local agent happily does local work.
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "Spawning a coding agent",
            "Focus a local terminal tab first if you meant to delegate local work, or do the remote work yourself with bash_run, which runs on the server.",
          );
        }
        const sessionId = ctx.getSessionId();
        if (!sessionId) return { error: "no active chat session" };
        const store = useManagedAgentsStore.getState();
        const existing = store.getBySessionId(sessionId);
        if (existing) {
          return {
            error: `a ${existing.agent} agent is already active in this session; use send_to_agent to give it more work`,
          };
        }
        const spawned = ctx.spawnAgent(prompt, agent);
        if (!spawned) return { error: "could not spawn the agent" };
        return {
          ok: true,
          tab_id: spawned.tabId,
          agent: agent ?? "claude",
          message: `${agent ?? "claude"} agent spawned. It will start working shortly.`,
        };
      },
    }),

    send_to_agent: tool({
      description:
        "Send a follow-up instruction to the active coding agent in this session. Use after reviewing its output to request fixes or the next unit of work. The instruction is typed into the agent's prompt and submitted once the user approves. Read its latest output first so the follow-up is informed.",
      inputSchema: z.object({
        instruction: z
          .string()
          .min(1)
          .describe(
            "One clear, self-contained instruction for the agent. No control characters.",
          ),
      }),
      needsApproval: true,
      execute: async ({ instruction }) => {
        const sessionId = ctx.getSessionId();
        const store = useManagedAgentsStore.getState();
        const managed = sessionId ? store.getBySessionId(sessionId) : undefined;
        if (!managed) {
          return {
            error:
              "no coding agent is active in this session; spawn one with spawn_coding_agent",
          };
        }
        const oneLine = instruction.replace(/\s*\r?\n\s*/g, " ").trim();
        if (!oneLine) return { error: "empty instruction" };
        if (hasControlChars(oneLine)) {
          return { error: "instruction contains control characters" };
        }
        if (!writeToSession(managed.leafId, oneLine)) {
          store.remove(managed.leafId);
          return { error: "agent terminal is no longer available (closed?)" };
        }
        setTimeout(() => writeToSession(managed.leafId, "\r"), SUBMIT_DELAY_MS);
        store.bumpRound(managed.leafId);
        return {
          ok: true,
          sent: oneLine,
          round: store.get(managed.leafId)?.rounds,
        };
      },
    }),

    read_agent_output: tool({
      description:
        "Inspect the coding agent running in this session (claude, codex, gemini, …): whether one is active, which agent it is, its status, and the tail of its terminal output. Call this first when delegating so you know whether to spawn a new agent or follow up with the existing one, and to see what it has done and reported.",
      inputSchema: z.object({
        lines: z
          .number()
          .int()
          .min(1)
          .max(400)
          .optional()
          .describe(
            "Trailing lines of the agent terminal to return. Default 120.",
          ),
      }),
      execute: async ({ lines }) => {
        const sessionId = ctx.getSessionId();
        const managed = sessionId
          ? useManagedAgentsStore.getState().getBySessionId(sessionId)
          : undefined;
        if (!managed) return { active: false };
        const raw = ctx.readAgentOutput(managed.leafId);
        return {
          active: true,
          agent: managed.agent,
          phase: managed.phase,
          rounds: managed.rounds,
          max_rounds: managed.maxRounds,
          output: raw ? tailLines(raw, lines ?? 120) : "",
        };
      },
    }),
  } as const;
}
