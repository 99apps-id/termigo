/**
 * Muse subscription quota, termixgo's muse_usage shape: there is no usage
 * endpoint on the Muse surface, so the reading rides the response stream
 * itself -- the last event of a Responses reply is
 * `response.subscription_usage`, carrying the short window (5 hours unless
 * Meta says another length) and the weekly one with used percentage and
 * reset time. Every real turn refreshes the reading for free; a snapshot
 * older than 15 minutes is stale and reads as absent.
 */

export type MuseQuotaWindow = {
  key: string;
  displayName: string;
  usedPercent: number;
  /** Epoch milliseconds, or null when Meta sent no reset time. */
  resetsAt: number | null;
};

export type MuseQuotaSnapshot = {
  tier: string | null;
  windows: MuseQuotaWindow[];
  fetchedAt: number;
};

export const MUSE_QUOTA_MAX_AGE_MS = 15 * 60 * 1000;

let snapshot: MuseQuotaSnapshot | null = null;
const listeners = new Set<() => void>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function formatMinutes(minutes: number): string {
  const total = Math.trunc(minutes);
  if (total >= 60 && total % 60 === 0) return `${total / 60}h`;
  return `${total}m`;
}

function toWindow(
  raw: unknown,
  key: string,
  displayName: string,
): MuseQuotaWindow | null {
  if (!isObject(raw)) return null;
  const resetsAt = Number(raw.resets_at ?? 0);
  return {
    key,
    displayName,
    usedPercent: clampPercent(Number(raw.used_percent ?? 0)),
    resetsAt: resetsAt > 0 ? Math.trunc(resetsAt) * 1000 : null,
  };
}

/**
 * Record the subscription object of a `response.subscription_usage`
 * event. Defensive by design: a malformed event leaves the previous
 * reading untouched rather than clearing the gauge.
 */
export function recordMuseSubscription(raw: unknown): void {
  if (!isObject(raw)) return;
  const windows: MuseQuotaWindow[] = [];
  if (isObject(raw.window)) {
    const duration = Number(raw.window.window_duration_mins ?? 0);
    if (duration === 0 || duration === 300) {
      const w = toWindow(raw.window, "session", "Session (5h)");
      if (w) windows.push(w);
    } else {
      const w = toWindow(
        raw.window,
        `window_${formatMinutes(duration)}`,
        `Window (${formatMinutes(duration)})`,
      );
      if (w) windows.push(w);
    }
  }
  const weekly = toWindow(raw.weekly, "weekly", "Weekly (7d)");
  if (weekly) windows.push(weekly);
  if (windows.length === 0) return;
  snapshot = {
    tier: typeof raw.tier === "string" && raw.tier ? raw.tier : null,
    windows,
    fetchedAt: Date.now(),
  };
  for (const listener of listeners) listener();
}

/** The latest reading, or null when none arrived yet or it went stale. */
export function getMuseQuotaSnapshot(
  now: number = Date.now(),
): MuseQuotaSnapshot | null {
  if (!snapshot) return null;
  if (now - snapshot.fetchedAt > MUSE_QUOTA_MAX_AGE_MS) return null;
  return snapshot;
}

export function onMuseQuotaChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
