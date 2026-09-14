/**
 * Multi-Provider Rate-Limit Tracking & Key/Model Hot-Swapping
 *
 * Inspired by Orca's usage tracking and hot-swapping:
 * When an AI provider or model hits a rate limit (HTTP 429 / Quota Exceeded),
 * this module tracks its cooldown backoff and automatically selects a healthy
 * fallback provider/key to prevent interrupted agent workflows.
 */

export interface ProviderHealth {
  providerId: string;
  consecutiveFailures: number;
  rateLimitedUntil: number | null;
  lastError?: string;
  lastFailureTime?: number;
}

const providerRegistry = new Map<string, ProviderHealth>();

const DEFAULT_COOLDOWN_MS = 60_000; // 60 seconds

/**
 * Checks whether an error indicates rate limiting or quota exhaustion.
 */
export function isRateLimitError(error: unknown): boolean {
  if (!error) return false;

  const errStr =
    typeof error === "string"
      ? error.toLowerCase()
      : error instanceof Error
        ? `${error.name} ${error.message}`.toLowerCase()
        : JSON.stringify(error).toLowerCase();

  return (
    errStr.includes("429") ||
    errStr.includes("rate_limit") ||
    errStr.includes("rate limit") ||
    errStr.includes("quota exceeded") ||
    errStr.includes("insufficient_quota") ||
    errStr.includes("resource_exhausted") ||
    errStr.includes("tokens per min") ||
    errStr.includes("too many requests")
  );
}

/**
 * Records a successful response from a provider, clearing its backoff.
 */
export function recordProviderSuccess(providerId: string): void {
  const existing = providerRegistry.get(providerId);
  if (existing) {
    existing.consecutiveFailures = 0;
    existing.rateLimitedUntil = null;
    existing.lastError = undefined;
  }
}

/**
 * Records a failure or rate-limit event for a provider.
 */
export function recordProviderError(
  providerId: string,
  error: unknown,
  customCooldownMs?: number
): ProviderHealth {
  let record = providerRegistry.get(providerId);
  if (!record) {
    record = {
      providerId,
      consecutiveFailures: 0,
      rateLimitedUntil: null,
    };
    providerRegistry.set(providerId, record);
  }

  record.consecutiveFailures += 1;
  record.lastFailureTime = Date.now();
  record.lastError = error instanceof Error ? error.message : String(error);

  if (isRateLimitError(error)) {
    const cooldown = customCooldownMs ?? DEFAULT_COOLDOWN_MS;
    record.rateLimitedUntil = Date.now() + cooldown;
  }

  return { ...record };
}

/**
 * Checks whether a given provider is currently healthy and not rate-limited.
 */
export function isProviderAvailable(providerId: string, now = Date.now()): boolean {
  const record = providerRegistry.get(providerId);
  if (!record) return true;

  if (record.rateLimitedUntil && record.rateLimitedUntil > now) {
    return false;
  }

  // Also throttle if excessive consecutive general failures occurred (> 5)
  if (record.consecutiveFailures >= 5) {
    const timeSinceLastFailure = now - (record.lastFailureTime ?? 0);
    return timeSinceLastFailure > DEFAULT_COOLDOWN_MS;
  }

  return true;
}

/**
 * Returns the remaining cooldown in milliseconds for a rate-limited provider.
 * Returns 0 if the provider is currently available.
 */
export function getRemainingCooldownMs(providerId: string, now = Date.now()): number {
  const record = providerRegistry.get(providerId);
  if (!record || !record.rateLimitedUntil) return 0;
  return Math.max(0, record.rateLimitedUntil - now);
}

/**
 * Selects the optimal active provider from a candidate list with prioritized fallbacks.
 * If all candidates are throttled, returns the one with the earliest cooldown expiry.
 */
export function selectActiveProvider(
  primaryCandidates: string[],
  fallbackCandidates: string[] = [],
  now = Date.now()
): {
  selectedProvider: string;
  isFallback: boolean;
  cooldownRemainingMs: number;
} {
  const allCandidates = [...primaryCandidates, ...fallbackCandidates];
  if (allCandidates.length === 0) {
    throw new Error("No candidate providers provided.");
  }

  // 1. Try first available primary candidate
  for (const p of primaryCandidates) {
    if (isProviderAvailable(p, now)) {
      return { selectedProvider: p, isFallback: false, cooldownRemainingMs: 0 };
    }
  }

  // 2. Try first available fallback candidate
  for (const fb of fallbackCandidates) {
    if (isProviderAvailable(fb, now)) {
      return { selectedProvider: fb, isFallback: true, cooldownRemainingMs: 0 };
    }
  }

  // 3. All throttled: find candidate with minimum remaining cooldown
  let bestCandidate = allCandidates[0];
  let minCooldown = Infinity;

  for (const c of allCandidates) {
    const cd = getRemainingCooldownMs(c, now);
    if (cd < minCooldown) {
      minCooldown = cd;
      bestCandidate = c;
    }
  }

  const isFallback = !primaryCandidates.includes(bestCandidate);
  return {
    selectedProvider: bestCandidate,
    isFallback,
    cooldownRemainingMs: minCooldown === Infinity ? 0 : minCooldown,
  };
}

/**
 * Clears provider health registry (for test setup/teardown).
 */
export function resetProviderRegistry(): void {
  providerRegistry.clear();
}
