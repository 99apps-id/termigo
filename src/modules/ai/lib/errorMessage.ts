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

  // A "thinking mode" endpoint refused a forced tool choice (the fan-out pin
  // or a synthesis pin). Deterministic for the pin, but the pin is optional —
  // the run learns to drop it (toolChoiceLearning), so pressing Try again /
  // Continue after the auto-retry normally just works.
  if (l.includes("tool_choice") || l.includes("tool choice")) {
    return "This model doesn't support forcing a specific tool call. Termigo stopped forcing it automatically — press Continue or Try again to carry on.";
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

  // Provider-side content moderation. DashScope / Qwen-compatible endpoints
  // (and others) run an input filter that rejects a request outright with
  // `data_inspection_failed` / "inappropriate content". It is deterministic -
  // the same text fails every retry - so "Try again" only repeats it. Checked
  // before the auth branch: these rejections can ride a 4xx status, and the
  // filter message - not the key - is what the user has to act on.
  if (
    l.includes("data_inspection_failed") ||
    l.includes("inappropriate content") ||
    l.includes("content policy") ||
    l.includes("content_filter") ||
    (l.includes("content") && l.includes("inspection"))
  ) {
    return "The provider's content filter rejected this request (it flagged the text as inappropriate). This is not a bug and retrying the same request will fail again. Rephrase the task to avoid the flagged wording, or switch to a model without that filter in Settings → Providers.";
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
