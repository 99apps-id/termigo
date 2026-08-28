type ErrorDetails = {
  code: string | null;
  message: string;
};

const MAX_ERROR_LENGTH = 800;
const FALLBACK_ERROR =
  "The AI provider rejected the request. Check the selected model and provider settings, then try again.";

export function formatAiError(error: unknown): string {
  const details = extractErrorDetails(error);
  if (!details) return FALLBACK_ERROR;
  const message = sanitizeErrorMessage(details.message);
  if (!message) return FALLBACK_ERROR;
  const prefix = errorPrefix(details.code, message);
  return prefix ? `${prefix}: ${message}` : message;
}

function extractErrorDetails(
  value: unknown,
  depth = 0,
  seen = new Set<unknown>(),
): ErrorDetails | null {
  if (depth > 5 || value == null || seen.has(value)) return null;
  if (typeof value === "string") {
    const parsed = parseJson(value);
    if (parsed !== null) return extractErrorDetails(parsed, depth + 1, seen);
    return { code: null, message: value };
  }
  if (typeof value !== "object") return null;
  seen.add(value);

  const record = value as Record<string, unknown>;
  const code = stringValue(record.code);
  for (const key of ["error", "responseBody", "body", "data", "cause"]) {
    const nested = extractErrorDetails(record[key], depth + 1, seen);
    if (nested) return { code: nested.code ?? code, message: nested.message };
  }
  const message = stringValue(record.message);
  return message ? { code, message } : null;
}

function parseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function sanitizeErrorMessage(message: string): string {
  const redacted = message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(?:sk-(?:ant-|proj-)?|xai-|gsk_)[A-Za-z0-9_-]{8,}\b/g,
      "[redacted]",
    )
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length <= MAX_ERROR_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_ERROR_LENGTH - 3)}...`;
}

function errorPrefix(code: string | null, message: string): string | null {
  switch (code?.toLowerCase()) {
    case "model_not_found":
    case "not_found_error":
      return "Model unavailable";
    case "invalid_api_key":
    case "authentication_error":
      return "Authentication failed";
    case "insufficient_quota":
      return "Quota exceeded";
    case "rate_limit_exceeded":
    case "rate_limit_error":
      return "Rate limit reached";
  }
  return /\bmodel\b.*\b(?:limited preview|not available|not found)\b/i.test(
    message,
  )
    ? "Model unavailable"
    : null;
}

/** A network / connectivity failure: the provider (or the route to it) is
 *  unreachable. Recoverable once the connection is back. */
export function isConnectivityError(message: string): boolean {
  const m = String(message ?? "").toLowerCase();
  return (
    /cannot connect to api/i.test(m) ||
    /unreachable host/.test(m) ||
    /tcp connect error/.test(m) ||
    /socket operation was attempted to an unreachable/i.test(m) ||
    /failed to fetch|fetch failed|networkerror/i.test(m) ||
    /econnrefused|enetunreach|enetdown|ehostunreach|eai_again|etimedout|econnreset/i.test(
      m,
    ) ||
    /connection (?:refused|reset|reset by peer|timed out|closed)/i.test(m) ||
    /name or service not known|getaddrinfo/i.test(m) ||
    /no internet|internet connection|offline/i.test(m)
  );
}

/** The provider says the account's quota / credits are exhausted (or billing
 *  failed). Recoverable once the user tops up. */
export function isQuotaError(message: string): boolean {
  const m = String(message ?? "").toLowerCase();
  return (
    /\binsufficient_quota\b|quota|billing|credit|balance|payment required/i.test(
      m,
    ) ||
    /out of (?:credits|quota|tokens)/i.test(m) ||
    /exceeded.*(?:quota|limit)/i.test(m)
  );
}

/** The provider throttled the request (rate limit / 429). Recoverable after a
 *  short wait. */
export function isRateLimitError(message: string): boolean {
  const m = String(message ?? "").toLowerCase();
  return (
    /rate[-_]?limit|429|too many requests|throttl/i.test(m)
  );
}
