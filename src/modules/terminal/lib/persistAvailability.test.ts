import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

async function freshModule() {
  vi.resetModules();
  const mod = await import("./persistAvailability");
  return mod;
}

describe("getPersistAvailability", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("returns true when the backend reports tmux availability", async () => {
    invokeMock.mockResolvedValue(true);
    const { getPersistAvailability } = await freshModule();
    await expect(getPersistAvailability()).resolves.toBe(true);
  });

  it("returns false when the backend has no tmux", async () => {
    invokeMock.mockResolvedValue(false);
    const { getPersistAvailability } = await freshModule();
    await expect(getPersistAvailability()).resolves.toBe(false);
  });

  it("falls back to false (and caches) when the probe fails", async () => {
    invokeMock.mockRejectedValue(new Error("command not found"));
    const { getPersistAvailability } = await freshModule();
    await expect(getPersistAvailability()).resolves.toBe(false);
    // A failed probe is cached so a later render does not keep failing.
    await expect(getPersistAvailability()).resolves.toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
