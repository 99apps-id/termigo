import { usePreferencesStore } from "@/modules/settings/preferences";
import { setAgentAlwaysAllowedTools } from "@/modules/settings/store";
import { subagentWriteNeedsApproval } from "../lib/approvalPolicy";
import { summarizeInput } from "../lib/approvalQueue";
import { subagentRuleGate } from "../lib/approvalRules";
import { isCustomTool } from "../lib/customToolNames";
import { isExtensionTool } from "../lib/extensionToolNames";
import { isMcpTool } from "../lib/mcpToolNames";
import { native } from "../lib/native";
import { isAutoApprovedScan } from "../lib/pentestScope";
import {
  isSessionAllowed,
  rememberSessionAllowed,
  useApprovalQueue,
} from "../store/approvalQueueStore";
import { useApprovalRulesStore } from "../store/approvalRulesStore";
import { useChatStore } from "../store/chatStore";
import { usePlanStore } from "../store/planStore";

/**
 * `write_file` is the one write with no read-before check, so a sub-agent gets
 * the same new-files-only guard the builder had - see `newFilesOnly`.
 */
export const WRITE_FILE = "write_file";

/**
 * How many consecutive denials end the run outright.
 *
 * A denied write returns an error result, and a model that ignores the "do
 * not retry" instruction simply asks again - that was the loop this breaker
 * closes. Three denials in a row is a conversation the user is losing; the
 * sub-agent stops itself instead of spending its whole step budget re-asking.
 */
export const MAX_CONSECUTIVE_DENIALS = 3;

export type AnyTool = { execute?: (input: never, opts: never) => unknown };

/** Shared loop-breaker state for one sub-agent run. */
export type DenialBreaker = {
  denials: number;
  tripped: boolean;
  /** Ends the run: no further model step can re-ask. */
  trip: () => void;
};

/**
 * Whether a sub-agent tool must route through the approval queue rather than
 * auto-run.
 *
 * A sub-agent holds the same toolset as the main agent, so this is the security
 * floor that makes that safe: everything the main agent would stop and ask for
 * asks here too. A built-in tool that mutates or runs a command declares
 * `needsApproval`; third-party tools (extension / MCP / custom) are always
 * policy-governed by name. Read-only file/search tools carry neither signal and
 * auto-run, exactly as they do for the main agent.
 */
export function subagentToolNeedsGate(name: string, tool?: unknown): boolean {
  if (isExtensionTool(name) || isMcpTool(name) || isCustomTool(name))
    return true;
  return (
    (tool as { needsApproval?: unknown } | undefined)?.needsApproval === true
  );
}

/**
 * Make a tool ask before it acts.
 *
 * The SDK's own `needsApproval` cannot be used here: it works by ending the
 * run and resuming from the next request, and a sub-agent has no message
 * boundary to end at. `execute` is plain async code in the same runtime as the
 * UI, so it can just wait for the user - which is what the approval queue is.
 *
 * The answer is a decision, not a yes/no: besides approve-once and deny, the
 * user can allow the tool for this session or permanently, both of which are
 * remembered here so later calls of the same tool skip the queue entirely.
 */
export function gate<T extends AnyTool>(
  tool: T,
  toolName: string,
  requester: string,
  breaker: DenialBreaker,
  abortSignal?: AbortSignal,
): T {
  const inner = tool.execute;
  if (!inner) return tool;
  return {
    ...tool,
    execute: async (input: never, opts: never) => {
      // A session or permanent allowance answers the question before it is
      // asked. Checked first so an allowed tool never touches the queue,
      // whatever the approval mode says.
      if (isSessionAllowed(toolName)) return inner(input, opts);
      if (
        usePreferencesStore
          .getState()
          .agentAlwaysAllowedTools.includes(toolName)
      ) {
        return inner(input, opts);
      }

      // Project-scoped approval rules (.termigo/approvals.json) hold for
      // sub-agents too - a rule the user set for their own agent must not be
      // bypassed by a worker. deny auto-refuses, allow auto-runs, and ask (or
      // no match) falls through to the queue below. Same precedence as the
      // main agent's auto-approval path: an explicit session/global allowance
      // wins, then the rules, then the scoped-scan opt-in.
      const ruleInput = input as { command?: unknown; path?: unknown };
      const ruleGate = subagentRuleGate(
        useApprovalRulesStore.getState().rules,
        {
          tool: toolName,
          command:
            typeof ruleInput.command === "string" ? ruleInput.command : null,
          path: typeof ruleInput.path === "string" ? ruleInput.path : null,
        },
      );
      if (ruleGate === "deny") {
        return {
          error:
            "denied by a project approval rule (.termigo/approvals.json). Do not retry this call; report it as not done.",
        };
      }
      if (ruleGate === "allow") return inner(input, opts);

      // Scoped auto-approval: an in-scope, read-tier scan (nmap -sV, ffuf, ...)
      // against a target already in the authorized scope runs without a prompt
      // when the user turned that on. Exploit-grade tools and out-of-scope
      // targets still ask. This is what makes an unattended guardian run
      // feasible without hundreds of clicks; the shell fence has already
      // refused anything outside scope before the command reaches here.
      if (toolName === "bash_run" || toolName === "bash_background") {
        const cmd = (input as { command?: unknown }).command;
        const prefs = usePreferencesStore.getState();
        const scanScope = prefs.enforcePentestScope ? prefs.pentestScope : [];
        if (
          typeof cmd === "string" &&
          isAutoApprovedScan(cmd, scanScope, prefs.autoApproveInScopeScans)
        ) {
          return inner(input, opts);
        }
      }

      const mustAsk = subagentWriteNeedsApproval(
        toolName,
        usePreferencesStore.getState().agentApprovalMode,
        {
          planActive: usePlanStore.getState().active,
          onRemoteHost: !!useChatStore.getState().live.getRemoteSession(),
        },
      );
      if (!mustAsk) return inner(input, opts);

      const decision = await useApprovalQueue
        .getState()
        .request(
          { requester, toolName, summary: summarizeInput(input) },
          abortSignal,
        );

      if (decision === "allow-session") {
        rememberSessionAllowed(toolName);
        breaker.denials = 0;
        return inner(input, opts);
      }
      if (decision === "allow-always") {
        rememberSessionAllowed(toolName);
        const list = usePreferencesStore.getState().agentAlwaysAllowedTools;
        if (!list.includes(toolName)) {
          // Fire-and-forget: the call is approved the moment the user clicks,
          // and a slow disk write must not delay it.
          void setAgentAlwaysAllowedTools([...list, toolName]);
        }
        breaker.denials = 0;
        return inner(input, opts);
      }
      if (decision === "approve") {
        breaker.denials = 0;
        return inner(input, opts);
      }

      // Denied. Count consecutive denials and stop the run when the user is
      // clearly saying no - otherwise the model can spend every remaining
      // step re-asking the same question.
      breaker.denials++;
      if (breaker.denials >= MAX_CONSECUTIVE_DENIALS) {
        breaker.tripped = true;
        breaker.trip();
        return {
          error:
            "denied by the user three times in a row. This sub-agent is stopping; report the write as not done.",
        };
      }
      return {
        error:
          "denied by the user. Do not retry this write; report it as not done.",
      };
    },
  };
}

function isReportDocument(path: string): boolean {
  const norm = path.toLowerCase().replace(/\\/g, "/");
  const base = norm.split("/").pop() ?? "";
  if (base.endsWith(".md") || base.endsWith(".markdown")) return true;
  if (
    norm.includes("/reports/") ||
    norm.includes("/docs/") ||
    base.startsWith("report") ||
    base.startsWith("audit") ||
    base.startsWith("summary")
  ) {
    return true;
  }
  return false;
}

/**
 * Refuse unprompted overwrite of existing code files by subagents.
 *
 * edit fails loudly when a sibling changed the file first, because it has to
 * match old_string. write_file replaces the whole file, so with several
 * builders running it could silently destroy another's work.
 * Overwrites are allowed when:
 * 1. overwrite: true is explicitly provided.
 * 2. The target is a report or documentation document.
 * 3. The file was created earlier by this same subagent run.
 */
export function newFilesOnly<T extends AnyTool>(tool: T): T {
  const inner = tool.execute;
  if (!inner) return tool;
  const selfCreated = new Set<string>();

  return {
    ...tool,
    execute: async (input: never, opts: never) => {
      const typed = input as {
        path?: unknown;
        file_path?: unknown;
        file?: unknown;
        overwrite?: unknown;
      };
      const rawPath =
        typeof typed?.path === "string"
          ? typed.path
          : typeof typed?.file_path === "string"
            ? typed.file_path
            : typeof typed?.file === "string"
              ? typed.file
              : undefined;

      if (typeof rawPath === "string" && rawPath.trim()) {
        const path = rawPath.trim();
        const canOverwrite =
          typed.overwrite === true ||
          isReportDocument(path) ||
          selfCreated.has(path);

        if (!canOverwrite) {
          const existing = await native.readFile(path).catch(() => null);
          if (existing) {
            return {
              error: `${path} already exists. If you intend to overwrite this file entirely, supply overwrite: true; or call read_file followed by edit/multi_edit for safe in-place modifications.`,
            };
          }
        }
        selfCreated.add(path);
      }
      return inner(input, opts);
    },
  };
}
