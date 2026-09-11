// Progress/status helpers for the Telegram bot: approval inspection, status labels,
// and tool-output summarization used by streaming updates.

import type { AgentMeta } from "../ai/store/chatStore";

export type AgentStatus = "idle" | "thinking" | "streaming" | "awaiting-approval" | "error";

const LABELS: Record<AgentStatus, string> = {
  idle: "Idle",
  thinking: "Thinking...",
  streaming: "Streaming...",
  "awaiting-approval": "Awaiting approval...",
  error: "Error",
};

export function resolveStatusLabel(status: AgentStatus): string {
  return LABELS[status] ?? status;
}

export function inferAgentStatus(meta: AgentMeta): AgentStatus {
  if (meta.error) return "error";
  if (meta.approvalsPending > 0) return "awaiting-approval";
  if (meta.step) return "streaming";
  if (meta.status === "thinking") return "thinking";
  return "idle";
}

export function formatToolLabel(toolName: string, input: unknown): string {
  const prefix = toolName || "Tool";
  const raw = typeof input === "string" ? input : JSON.stringify(input ?? {});
  const trimmed = raw.length > 80 ? `${raw.slice(0, 77)}...` : raw;
  return `**${prefix}**: \`${trimmed}\``;
}

export function getPendingApprovals(
  sessionId: string,
  state: { sessions: Array<{ id: string; agentMeta: AgentMeta }> },
  approvalQueue: { pending: Array<{ id: string; toolName?: string; summary?: string }> },
): Array<{ id: string; toolName: string; summary: string }> {
  const chat = state.sessions.find((s) => s.id === sessionId);
  if (!chat) return [];
  const pendingIds = new Set(approvalQueue.pending.map((p) => p.id));
  return chat.agentMeta.pendingApprovals.filter((p) => pendingIds.has(p.id));
}