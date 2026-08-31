// Answers approval prompts the current mode allows, so the run does not stall
// on a click the user has already delegated.
//
// This only responds to prompts the model raised; it never grants anything the
// tool would not otherwise be offered. The per-tool safety checks run inside
// `execute` after approval, so a mode change can widen what proceeds without a
// click but cannot widen what is allowed to happen.

import { usePreferencesStore } from "@/modules/settings/preferences";
import type { UIMessage } from "ai";
import { useEffect, useRef } from "react";
import { isAutoApproved } from "../lib/approvalPolicy";
import { isAutoApprovedScan } from "../lib/pentestScope";
import { isSessionAllowed } from "../store/approvalQueueStore";
import { useApprovalRulesStore } from "../store/approvalRulesStore";
import { useChatStore } from "../store/chatStore";

type ApprovalResponder = (arg: {
  id: string;
  approved: boolean;
  reason?: string;
}) => void | PromiseLike<void>;

/** `tool-write_file` -> `write_file`. */
function toolNameOf(partType: string): string {
  return partType.startsWith("tool-") ? partType.slice("tool-".length) : "";
}

export function useAutoApproval(
  messages: UIMessage[],
  respond: ApprovalResponder,
): void {
  const mode = usePreferencesStore((s) => s.agentApprovalMode);
  const alwaysAllowed = usePreferencesStore((s) => s.agentAlwaysAllowedTools);
  // One response per approval id. The part stays in the message list after it
  // is answered, and re-answering resumes the run twice.
  const answered = useRef<Set<string>>(new Set());

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant") return;

    for (const part of last.parts as Array<Record<string, unknown>>) {
      if (part.state !== "approval-requested") continue;
      const id = (part.approval as { id?: string } | undefined)?.id;
      if (!id || answered.current.has(id)) continue;

      const tool = toolNameOf(String(part.type ?? ""));
      if (!tool) continue;

      // An explicit allowance answers the question whatever the mode says:
      // "allow this session" and "always allow" were chosen by the user, so
      // they hold even while the global mode is still "ask".
      if (isSessionAllowed(tool) || alwaysAllowed.includes(tool)) {
        answered.current.add(id);
        void respond({ id, approved: true });
        continue;
      }

      // The command decides whether a remote call is inspection or a change,
      // so it has to reach the policy rather than being inferred from the name.
      const input = part.input as
        | { command?: unknown; path?: unknown }
        | undefined;
      const command =
        typeof input?.command === "string" ? input.command : undefined;
      const path = typeof input?.path === "string" ? input.path : undefined;

      // Project-scoped approval rules (.termigo/approvals.json) refine the
      // global mode per project: `deny` auto-refuses, `allow` auto-approves
      // regardless of mode, and `ask` forces a manual prompt. First match wins;
      // no match falls through to the mode logic below.
      const ruleDecision = useApprovalRulesStore
        .getState()
        .evaluate({ tool, command, path });
      if (ruleDecision) {
        if (ruleDecision.action === "deny") {
          answered.current.add(id);
          void respond({ id, approved: false, reason: ruleDecision.reason });
          continue;
        }
        if (ruleDecision.action === "allow") {
          answered.current.add(id);
          void respond({ id, approved: true });
          continue;
        }
        // "ask": leave it for the user, whatever the mode would have done.
        continue;
      }

      // Scoped scan auto-approval is its own opt-in, independent of the mode:
      // an in-scope read-tier scan (nmap -sV, ffuf, ...) runs without a prompt
      // when the user turned it on, even while the global mode is still "ask".
      // Exploit-grade tools and out-of-scope targets are excluded by
      // isAutoApprovedScan, and the shell fence has already refused anything
      // outside scope before it could reach an approval prompt.
      if (command && (tool === "bash_run" || tool === "bash_background")) {
        const prefs = usePreferencesStore.getState();
        // In-scope auto-approval only makes sense while the scope fence is on.
        const scanScope = prefs.enforcePentestScope ? prefs.pentestScope : [];
        if (
          isAutoApprovedScan(command, scanScope, prefs.autoApproveInScopeScans)
        ) {
          answered.current.add(id);
          void respond({ id, approved: true });
          continue;
        }
      }

      if (mode === "ask") continue;

      // Read at answer time, not render time: the user can focus an SSH tab
      // between the request and this effect, and the machine the command would
      // land on is what decides whether a mode may speak for them.
      const onRemoteHost = !!useChatStore.getState().live.getRemoteSession();
      if (!isAutoApproved(tool, mode, { onRemoteHost, command })) continue;

      answered.current.add(id);
      void respond({ id, approved: true });
    }
  }, [messages, mode, alwaysAllowed, respond]);
}
