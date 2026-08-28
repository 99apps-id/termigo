// Turn a raw provider/SDK error into a short, actionable sentence.
//
// The agent used to surface the provider's raw string (or, when it was empty,
// nothing at all), so "your credits ran out" arrived as a blank stop or an
// opaque 429. This maps the failures users actually hit to plain guidance,
// while leaving anything unrecognised untouched.

export function humanizeModelError(raw: string | null | undefined): string {
  const msg = (raw ?? "").trim();
  const l = msg.toLowerCase();

  // Context window exceeded.
  if (
    l.includes("maximum context length") ||
    l.includes("context length") ||
    l.includes("context_length_exceeded") ||
    l.includes("too many tokens") ||
    (l.includes("token") && l.includes("exceed"))
  ) {
    return "This conversation is too long for the model's context window. History has been trimmed — press Continue to retry, switch to a larger-context model, or start a new chat.";
  }

  // Quota / billing / credits exhausted.
  if (
    l.includes("insufficient_quota") ||
    l.includes("insufficient quota") ||
    l.includes("exceeded your current quota") ||
    l.includes("out of credit") ||
    l.includes("no credit") ||
    l.includes("billing") ||
    l.includes("payment required") ||
    l.includes("status 402")
  ) {
    return "Your API key is out of quota or credits. Add credits with your provider, or switch provider/model in Settings → Providers.";
  }

  // Rate limited.
  if (
    l.includes("rate limit") ||
    l.includes("rate_limit") ||
    l.includes("too many requests") ||
    l.includes("status 429") ||
    l.includes("429")
  ) {
    return "The provider rate-limited this request. Wait a few seconds and press Continue, or switch to another model.";
  }

  // Auth / key problems.
  if (
    l.includes("invalid api key") ||
    l.includes("incorrect api key") ||
    l.includes("invalid_api_key") ||
    l.includes("unauthorized") ||
    l.includes("authentication") ||
    l.includes("status 401") ||
    l.includes("status 403")
  ) {
    return "The provider rejected the API key. Check it in Settings → Providers.";
  }

  // Network reachability.
  if (
    l.includes("failed to fetch") ||
    l.includes("network error") ||
    l.includes("enotfound") ||
    l.includes("econnrefused") ||
    l.includes("timed out") ||
    l.includes("timeout")
  ) {
    return "Couldn't reach the provider. Check your internet connection and try again.";
  }

  // No first token within the watchdog window.
  if (l.includes("did not respond within")) {
    return "The model stopped responding before producing anything. Press Continue to retry, or switch models.";
  }

  return (
    msg || "The request failed for an unknown reason. Press Continue to retry."
  );
}
