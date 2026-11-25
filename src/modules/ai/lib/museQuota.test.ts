import { describe, expect, it } from "vitest";
import {
  MUSE_QUOTA_MAX_AGE_MS,
  getMuseQuotaSnapshot,
  recordMuseSubscription,
} from "./museQuota";

describe("museQuota", () => {
  it("records the 5-hour and weekly windows from a subscription event", () => {
    recordMuseSubscription({
      tier: "plus",
      window: {
        resets_at: 1_900_000_000,
        used_percent: 23.4,
        window_duration_mins: 300,
      },
      weekly: {
        resets_at: 1_900_500_000,
        used_percent: 41,
        window_duration_mins: 10080,
      },
    });
    const snap = getMuseQuotaSnapshot();
    expect(snap?.tier).toBe("plus");
    expect(snap?.windows).toHaveLength(2);
    expect(snap?.windows[0]).toMatchObject({
      key: "session",
      displayName: "Session (5h)",
      usedPercent: 23.4,
      resetsAt: 1_900_000_000_000,
    });
    expect(snap?.windows[1]).toMatchObject({
      key: "weekly",
      displayName: "Weekly (7d)",
      usedPercent: 41,
    });
  });

  it("reads as absent once the reading is stale", () => {
    recordMuseSubscription({
      window: { resets_at: 0, used_percent: 10, window_duration_mins: 300 },
    });
    const later = Date.now() + MUSE_QUOTA_MAX_AGE_MS + 1;
    expect(getMuseQuotaSnapshot(later)).toBeNull();
  });

  it("ignores a malformed event instead of clearing the reading", () => {
    recordMuseSubscription({
      window: { resets_at: 0, used_percent: 55, window_duration_mins: 300 },
    });
    recordMuseSubscription({ nonsense: true });
    recordMuseSubscription(null);
    expect(getMuseQuotaSnapshot()?.windows[0]?.usedPercent).toBe(55);
  });

  it("clamps an out-of-range percentage", () => {
    recordMuseSubscription({
      window: { resets_at: 0, used_percent: 140, window_duration_mins: 300 },
    });
    expect(getMuseQuotaSnapshot()?.windows[0]?.usedPercent).toBe(100);
  });
});
