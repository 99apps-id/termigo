/**
 * Gemini safety settings.
 *
 * Google's default thresholds block a fair amount of legitimate developer work
 * with the "This request was blocked by Gemini's filters" false positive:
 * security tooling, exploit write-ups, malware analysis, biology and medical
 * text. `BLOCK_NONE` is the documented opt-out for the four adjustable
 * categories, and it is what a coding terminal should send.
 *
 * `HARM_CATEGORY_CIVIC_INTEGRITY` is deliberately omitted: Google does not
 * allow `BLOCK_NONE` for it and rejects the whole request if you try. The
 * thresholds here therefore sit at the loosest setting the API accepts, not an
 * absolute "off" - an account- or policy-level block still wins.
 *
 * Kept pure so the body injection is unit-testable without a network.
 */

export type GoogleSafetySetting = { category: string; threshold: string };

export const GEMINI_SAFETY_SETTINGS: readonly GoogleSafetySetting[] = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Adds the permissive safety settings to a Gemini generateContent body when it
 * carries none. A body the caller already customised is left alone.
 */
export function injectSafetySettings(bodyText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!isObject(parsed)) return bodyText;
  const existing = parsed.safetySettings;
  if (Array.isArray(existing) && existing.length > 0) return bodyText;
  return JSON.stringify({
    ...parsed,
    safetySettings: GEMINI_SAFETY_SETTINGS,
  });
}

/** The Gemini generate endpoints a safety injection applies to. */
const GOOGLE_GENERATE_HOST = /generativelanguage\.googleapis\.com/;
const GENERATE_PATH = /:(?:streamGenerateContent|generateContent)\b/;

/**
 * `fetch` wrapper for the plain Google provider: injects the permissive safety
 * settings into every generateContent request, so a fresh call site cannot
 * forget them. Non-generate calls and non-strings pass through untouched.
 */
export function createGoogleSafetyFetch(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url =
      input instanceof URL
        ? input.toString()
        : typeof input === "string"
          ? input
          : input.url;
    if (
      !GOOGLE_GENERATE_HOST.test(url) ||
      !GENERATE_PATH.test(url) ||
      typeof init?.body !== "string"
    ) {
      return base(input, init);
    }
    const body = injectSafetySettings(init.body);
    if (body === init.body) return base(input, init);
    return base(input, { ...init, body });
  };
}
