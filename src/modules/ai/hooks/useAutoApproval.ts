// Answers approval prompts the current mode allows, so the run does not stall
// on a click the user has already delegated.
//
// This only responds to prompts the model raised; it never grants anything the
// tool would not otherwise be offered. The per-tool safety checks run inside
// `execute` after approval, so a mode change can widen what proceeds without a
// click but cannot widen what is allowed to happen.

import { useEffect, useRef } from "react";
import type { UIMessage } from "ai";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { isAutoApproved } from "../lib/approvalPolicy";

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
  // One response per approval id. The part stays in the message list after it
  // is answered, and re-answering resumes the run twice.
  const answered = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (mode === "ask") return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;

    for (const part of last.parts as Array<Record<string, unknown>>) {
      if (part.state !== "approval-requested") continue;
      const id = (part.approval as { id?: string } | undefined)?.id;
      if (!id || answered.current.has(id)) continue;

      const tool = toolNameOf(String(part.type ?? ""));
      if (!tool || !isAutoApproved(tool, mode)) continue;

      answered.current.add(id);
      void respond({ id, approved: true });
    }
  }, [messages, mode, respond]);
}
