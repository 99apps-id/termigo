import { beforeEach, describe, expect, it } from "vitest";
import { useTurnCheckpointStore } from "./turnCheckpointStore";

const entry = (messageId: string, sha = "a".repeat(40)) => ({
  messageId,
  sha,
  label: messageId,
  at: 1,
});

describe("turnCheckpointStore", () => {
  beforeEach(() => {
    useTurnCheckpointStore.setState({ bySession: {} });
  });

  it("records turns per session in order", () => {
    const store = useTurnCheckpointStore.getState();
    store.record("s1", entry("u1"));
    store.record("s1", entry("u2"));
    expect(
      useTurnCheckpointStore.getState().bySession["s1"].map((r) => r.messageId),
    ).toEqual(["u1", "u2"]);
  });

  it("replaces a repeat for the same message in place", () => {
    const store = useTurnCheckpointStore.getState();
    store.record("s1", entry("u1"));
    store.record("s1", entry("u2"));
    store.record("s1", { ...entry("u1"), label: "edited" });
    const rows = useTurnCheckpointStore.getState().bySession["s1"];
    expect(rows.map((r) => r.messageId)).toEqual(["u1", "u2"]);
    expect(rows[0].label).toBe("edited");
  });

  it("prunes a turn and everything newer when history is edited away", () => {
    const store = useTurnCheckpointStore.getState();
    store.record("s1", entry("u1"));
    store.record("s1", entry("u2"));
    store.record("s1", entry("u3"));
    store.pruneAfter("s1", "u2");
    expect(
      useTurnCheckpointStore.getState().bySession["s1"].map((r) => r.messageId),
    ).toEqual(["u1"]);
  });

  it("pruning an unknown message leaves rows alone", () => {
    const store = useTurnCheckpointStore.getState();
    store.record("s1", entry("u1"));
    store.pruneAfter("s1", "nope");
    expect(useTurnCheckpointStore.getState().bySession["s1"]).toHaveLength(1);
  });

  it("caps rows per session", () => {
    const store = useTurnCheckpointStore.getState();
    for (let i = 0; i < 60; i++) store.record("s1", entry(`u${i}`));
    const rows = useTurnCheckpointStore.getState().bySession["s1"];
    expect(rows).toHaveLength(50);
    expect(rows[0].messageId).toBe("u10");
  });

  it("clears one session without touching others", () => {
    const store = useTurnCheckpointStore.getState();
    store.record("s1", entry("u1"));
    store.record("s2", entry("u9"));
    store.clearSession("s1");
    expect(useTurnCheckpointStore.getState().bySession["s1"]).toBeUndefined();
    expect(
      useTurnCheckpointStore.getState().bySession["s2"],
    ).toHaveLength(1);
  });
});
