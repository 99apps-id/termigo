import { beforeEach, describe, expect, it } from "vitest";
import { useConfirmationStore } from "./confirmationStore";

beforeEach(() => {
  useConfirmationStore.setState({ pending: [] });
});

describe("confirmationStore (post-execution Keep/Revert)", () => {
  it("registers a pending confirmation and resolves with the decision", async () => {
    const promise = useConfirmationStore.getState().request("s1", {
      toolName: "write_file",
      summary: "Wrote a.ts",
      touchedPaths: ["/p/a.ts"],
    });
    expect(useConfirmationStore.getState().pending).toHaveLength(1);
    expect(useConfirmationStore.getState().pending[0]).toMatchObject({
      sessionId: "s1",
      toolName: "write_file",
      summary: "Wrote a.ts",
      touchedPaths: ["/p/a.ts"],
    });

    useConfirmationStore
      .getState()
      .resolve(useConfirmationStore.getState().pending[0].id, true);
    await expect(promise).resolves.toBe(true);
    expect(useConfirmationStore.getState().pending).toHaveLength(0);
  });

  it("resolves false when the user chooses Revert", async () => {
    const promise = useConfirmationStore.getState().request("s1", {
      toolName: "edit",
      summary: "Edited b.ts",
      touchedPaths: ["/p/b.ts"],
    });
    useConfirmationStore
      .getState()
      .resolve(useConfirmationStore.getState().pending[0].id, false);
    await expect(promise).resolves.toBe(false);
    expect(useConfirmationStore.getState().pending).toHaveLength(0);
  });

  it("keeps multiple confirmations in order per session", async () => {
    const p1 = useConfirmationStore.getState().request("s1", {
      toolName: "write_file",
      summary: "Wrote a.ts",
      touchedPaths: [],
    });
    const p2 = useConfirmationStore.getState().request("s1", {
      toolName: "bash_run",
      summary: "Ran command",
      touchedPaths: [],
    });
    expect(useConfirmationStore.getState().pending).toHaveLength(2);
    useConfirmationStore
      .getState()
      .resolve(useConfirmationStore.getState().pending[1].id, true);
    await expect(p2).resolves.toBe(true);
    expect(useConfirmationStore.getState().pending).toHaveLength(1);
    useConfirmationStore
      .getState()
      .resolve(useConfirmationStore.getState().pending[0].id, false);
    await expect(p1).resolves.toBe(false);
    expect(useConfirmationStore.getState().pending).toHaveLength(0);
  });

  it("resolves null when cancelled (change is kept, never auto-reverted)", async () => {
    const promise = useConfirmationStore.getState().request("s1", {
      toolName: "write_file",
      summary: "Wrote a.ts",
      touchedPaths: ["/p/a.ts"],
    });
    useConfirmationStore
      .getState()
      .cancel(useConfirmationStore.getState().pending[0].id);
    await expect(promise).resolves.toBeNull();
    expect(useConfirmationStore.getState().pending).toHaveLength(0);
  });

  it("resolves null when the run is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      useConfirmationStore
        .getState()
        .request(
          "s1",
          { toolName: "write_file", summary: "Wrote a.ts", touchedPaths: [] },
          controller.signal,
        ),
    ).resolves.toBeNull();
    expect(useConfirmationStore.getState().pending).toHaveLength(0);
  });

  it("resolves null when the run aborts while waiting", async () => {
    const controller = new AbortController();
    const promise = useConfirmationStore
      .getState()
      .request(
        "s1",
        { toolName: "edit", summary: "Edited b.ts", touchedPaths: [] },
        controller.signal,
      );
    controller.abort();
    await expect(promise).resolves.toBeNull();
    expect(useConfirmationStore.getState().pending).toHaveLength(0);
  });
});
