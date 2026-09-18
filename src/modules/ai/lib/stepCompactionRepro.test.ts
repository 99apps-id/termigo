import type { ModelMessage, ToolResultPart } from "ai";
import { describe, expect, it } from "vitest";
import { compactModelMessagesDetailed } from "./compact";
import { evictObsoleteToolOutputs } from "./contextEviction";
import { repairModelMessageSequence } from "./validateModelSequence";

describe("step compaction sequence validity", () => {
  it("guarantees every tool-call is answered even when prior turn had unexecuted approval responses", () => {
    // Exact scenario from session transcript:
    // Turn 1: Assistant calls 4 tools, user approves them (generating tool-approval-response),
    // but before execution finishes, the user sends a new message (e.g. "Continue from where you stopped").
    // Turn 2: Assistant calls another tool.
    const messages: ModelMessage[] = [
      { role: "user", content: "read and edit routes" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Writing routes" },
          { type: "tool-call", toolCallId: "call_0", toolName: "write_file", input: { path: "a.ts" } },
          { type: "tool-call", toolCallId: "call_1", toolName: "write_file", input: { path: "b.ts" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-approval-response",
            approvalId: "app_0",
            toolCallId: "call_0",
            approved: true,
          } as unknown as ToolResultPart,
          {
            type: "tool-approval-response",
            approvalId: "app_1",
            toolCallId: "call_1",
            approved: true,
          } as unknown as ToolResultPart,
        ],
      },
      { role: "user", content: "Continue from where you stopped." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Now checking status" },
          { type: "tool-call", toolCallId: "call_2", toolName: "bash_run", input: { command: "git status" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call_2", toolName: "bash_run", output: { type: "text", value: "clean" } },
        ],
      },
    ];

    const eviction = evictObsoleteToolOutputs(messages);
    const compacted = compactModelMessagesDetailed(eviction.messages, 10000, 1000);
    const nextMessages = repairModelMessageSequence(compacted.messages, { preserveTrailingApproval: false });

    // Validate that every assistant message with tool-calls is followed by tool results for all calls
    for (let i = 0; i < nextMessages.length; i++) {
      const m = nextMessages[i];
      if (m.role === "assistant" && Array.isArray(m.content)) {
        const calls = m.content.filter((p: any) => p.type === "tool-call");
        if (calls.length > 0) {
          const toolResults: any[] = [];
          let j = i + 1;
          while (j < nextMessages.length && nextMessages[j].role === "tool") {
            const tm = nextMessages[j];
            if (Array.isArray(tm.content)) {
              toolResults.push(...tm.content.filter((p: any) => p.type === "tool-result"));
            }
            j++;
          }

          const callIds = calls.map((c: any) => c.toolCallId);
          const resultCallIds = new Set(toolResults.map((r: any) => r.toolCallId));
          const missing = callIds.filter((id: string) => !resultCallIds.has(id));

          expect(missing).toEqual([]);
        }
      }
    }
  });
});
