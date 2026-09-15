import { describe, it, expect, vi, afterEach } from "vitest";
import { PtyResizeScheduler } from "./PtyResizeScheduler";

describe("PtyResizeScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces rapid resize calls and invokes only the last one", async () => {
    vi.useFakeTimers();
    const resize = vi.fn();
    const scheduler = new PtyResizeScheduler(resize);

    scheduler.schedule(80, 24);
    scheduler.schedule(120, 30);
    scheduler.schedule(100, 25);

    expect(resize).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(16);

    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(100, 25);
  });

  it("cancels pending resize", async () => {
    vi.useFakeTimers();
    const resize = vi.fn();
    const scheduler = new PtyResizeScheduler(resize);

    scheduler.schedule(80, 24);
    scheduler.cancel();

    await vi.advanceTimersByTimeAsync(16);
    expect(resize).not.toHaveBeenCalled();
  });

  it("invokes immediately when no pending resize", async () => {
    vi.useFakeTimers();
    const resize = vi.fn();
    const scheduler = new PtyResizeScheduler(resize);

    scheduler.schedule(80, 24);

    await vi.advanceTimersByTimeAsync(16);

    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(80, 24);
  });
});
