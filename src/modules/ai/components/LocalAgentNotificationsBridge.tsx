import { routeAgentNotification } from "@/modules/agents/lib/route";
import { useWindowFocus } from "@/modules/agents/lib/useWindowFocus";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import type { AgentStatus } from "@/modules/agents/lib/types";
import { useEffect, useRef } from "react";
import { useChatStore } from "../store/chatStore";

const AGENT = "Termigo";

type RunStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "awaiting-approval"
  | "error";

function isBusy(s: RunStatus): boolean {
  return s === "thinking" || s === "streaming" || s === "awaiting-approval";
}

function liveStatus(s: RunStatus): AgentStatus | null {
  if (s === "awaiting-approval") return "waiting";
  if (s === "thinking" || s === "streaming") return "working";
  return null;
}

export function LocalAgentNotificationsBridge() {
  const status = useChatStore((s) => s.agentMeta.status) as RunStatus;
  const error = useChatStore((s) => s.agentMeta.error);
  const stopReason = useChatStore((s) => s.agentMeta.stopReason);
  const stoppedByUser = useChatStore((s) => s.agentMeta.stoppedByUser);
  const visible = useChatStore((s) => s.panelOpen || s.mini.open);
  const focused = useWindowFocus();

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const prev = useRef<RunStatus>(status);
  const prevStopReason = useRef<string | null>(stopReason);

  useEffect(() => {
    const live = liveStatus(status);
    useAgentStore.getState().setLocalAgent(
      live ? { agent: AGENT, status: live } : null,
    );

    const was = prev.current;
    prev.current = status;
    const prevReason = prevStopReason.current;
    prevStopReason.current = stopReason;

    const fire = (
      kind: "attention" | "finished" | "error",
      title: string,
      body?: string,
    ) =>
      routeAgentNotification({
        source: "local",
        agent: AGENT,
        kind,
        title,
        body,
        focused: focusedRef.current,
        visible: visibleRef.current,
        allowToast: true,
        onActivate: () => useChatStore.getState().openPanel(),
      });

    const isLoopStop =
      stopReason === "tool-only-loop" ||
      stopReason === "tool-repetition" ||
      stopReason === "idle-read-loop" ||
      stopReason === "tool-error";

    if (isLoopStop && stopReason !== prevReason && !stoppedByUser) {
      fire(
        "attention",
        "Termigo: Run paused",
        "Run paused due to repetition without progress. Click to continue.",
      );
      return;
    }

    if (was === status) return;

    if (status === "awaiting-approval") {
      fire("attention", "Termigo needs your approval", "Approve a tool to continue");
    } else if (status === "error") {
      fire("error", "Termigo run failed", error ?? undefined);
    } else if (status === "idle" && isBusy(was)) {
      if (stoppedByUser) {
        // User stopped intentionally; no notification needed.
      } else if (isLoopStop) {
        fire(
          "attention",
          "Termigo: Run paused",
          "Run paused due to repetition without progress. Click to continue.",
        );
      } else {
        fire("finished", "Termigo finished", "Your task is ready");
      }
    }
  }, [status, error, stopReason, stoppedByUser]);

  return null;
}
