/** Dynamic status labels for Telegram progress messages. */

export type AgentStatus = "idle" | "thinking" | "streaming" | "awaiting-approval" | "error";

const LABELS: Record<AgentStatus, string> = {
  idle: "Idle",
  thinking: "Thinking...",
  streaming: "Reasoning...",
  "awaiting-approval": "Waiting for approval...",
  error: "Error",
};

export function resolveStatusLabel(status: AgentStatus): string {
  return LABELS[status] ?? status;
}
