import { beforeEach, describe, expect, it } from "vitest";
import { useElicitationStore } from "./elicitationStore";

beforeEach(() => {
  useElicitationStore.setState({ pending: [] });
});

describe("elicitationStore (ask_user / question carousel)", () => {
  it("registers a pending question and resolves with the chosen option", async () => {
    const promise = useElicitationStore
      .getState()
      .ask("Pick an approach", ["A", "B", "C"]);
    expect(useElicitationStore.getState().pending).toHaveLength(1);
    expect(useElicitationStore.getState().pending[0].options).toEqual([
      "A",
      "B",
      "C",
    ]);

    useElicitationStore.getState().answer(
      useElicitationStore.getState().pending[0].id,
      "B",
    );
    await expect(promise).resolves.toBe("B");
    expect(useElicitationStore.getState().pending).toHaveLength(0);
  });

  it("resolves with null when cancelled (dismissed)", async () => {
    const promise = useElicitationStore.getState().ask("Continue?", ["Yes"]);
    useElicitationStore
      .getState()
      .cancel(useElicitationStore.getState().pending[0].id);
    await expect(promise).resolves.toBeNull();
    expect(useElicitationStore.getState().pending).toHaveLength(0);
  });

  it("resolves with null when the run is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      useElicitationStore.getState().ask("Done?", ["y"], controller.signal),
    ).resolves.toBeNull();
    expect(useElicitationStore.getState().pending).toHaveLength(0);
  });

  it("resolves with null when the run aborts while waiting", async () => {
    const controller = new AbortController();
    const promise = useElicitationStore
      .getState()
      .ask("Continue?", ["Yes"], controller.signal);
    controller.abort();
    await expect(promise).resolves.toBeNull();
    expect(useElicitationStore.getState().pending).toHaveLength(0);
  });
});
