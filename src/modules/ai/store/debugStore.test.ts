import { beforeEach, describe, expect, it } from "vitest";
import { useDebugStore, type DebugCapture } from "./debugStore";

type NewCapture = Omit<DebugCapture, "id" | "at">;

function capture(overrides: Partial<NewCapture> = {}): NewCapture {
  return {
    model: { id: "deepseek-v4-pro", provider: "deepseek" },
    params: { stepBudget: 25 },
    system: [{ role: "system", content: "you are termigo" }],
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "read_file", description: "read a file" }],
    ...overrides,
  };
}

describe("useDebugStore", () => {
  beforeEach(() => useDebugStore.getState().clear());

  it("starts empty", () => {
    expect(useDebugStore.getState().captures).toEqual([]);
  });

  it("keeps the newest first, so the last request is the one on screen", () => {
    const { add } = useDebugStore.getState();
    add(capture({ params: { stepBudget: 25 } }));
    add(capture({ params: { stepBudget: 50 } }));
    const [first, second] = useDebugStore.getState().captures;
    expect(first.params.stepBudget).toBe(50);
    expect(second.params.stepBudget).toBe(25);
  });

  it("stamps each entry with a distinct id and a time", () => {
    const { add } = useDebugStore.getState();
    add(capture());
    add(capture());
    const [a, b] = useDebugStore.getState().captures;
    expect(a.id).not.toBe(b.id);
    expect(a.at).toBeGreaterThan(0);
  });

  // A hundred-step round would otherwise pin every request of the run in
  // memory, and the whole point is that this is cheap enough to leave on.
  it("stays bounded, dropping the oldest", () => {
    const { add } = useDebugStore.getState();
    for (let i = 0; i < 45; i++) {
      add(capture({ params: { stepBudget: i } }));
    }
    const captures = useDebugStore.getState().captures;
    expect(captures).toHaveLength(30);
    expect(captures[0].params.stepBudget).toBe(44);
    expect(captures[29].params.stepBudget).toBe(15);
  });

  it("clears on request, since a capture is the whole conversation", () => {
    const { add, clear } = useDebugStore.getState();
    add(capture());
    clear();
    expect(useDebugStore.getState().captures).toEqual([]);
  });
});
