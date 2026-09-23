import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { useTurnCheckpointStore } from "../store/turnCheckpointStore";

function userMsg(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistantMsg(id: string, text = "done"): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

describe("ChatTimelineNavigator extraction", () => {
  it("counts user turns and correlates parts", () => {
    const messages: UIMessage[] = [
      userMsg("u1", "first task"),
      assistantMsg("a1", "thinking"),
      assistantMsg("a2", "output"),
      userMsg("u2", "second task"),
      assistantMsg("a3", "result"),
    ];

    const userTurns = messages.filter((m) => m.role === "user");
    expect(userTurns).toHaveLength(2);
    expect(userTurns[0].id).toBe("u1");
    expect(userTurns[1].id).toBe("u2");
  });

  it("identifies checkpoint status from turnCheckpointStore", () => {
    useTurnCheckpointStore.getState().record("sess-1", {
      messageId: "u1",
      sha: "deadbeef",
      label: "first task",
      at: Date.now(),
    });

    const entry = useTurnCheckpointStore.getState().entryFor("sess-1", "u1");
    expect(entry).not.toBeNull();
    expect(entry?.sha).toBe("deadbeef");

    const noEntry = useTurnCheckpointStore.getState().entryFor("sess-1", "u2");
    expect(noEntry).toBeNull();
  });
});
