/**
 * OpenAI prompt-cache routing key.
 *
 * OpenAI's prefix cache is automatic, but `prompt_cache_key` is the field that
 * tells the router to keep requests sharing a stable prefix on the same cache
 * shard (documented for the GPT-5-era models). Without it, a long agent run can
 * scatter across shards and miss a cache that exists.
 *
 * The key is derived from the model plus the stable prefix (the system prompt,
 * or the Responses `instructions`), so every step of one conversation hashes to
 * the same key while a different workspace or model gets its own. Kept pure so
 * the body injection is unit-testable.
 *
 * Only applied to `api.openai.com`: the API accepts the field, while the Codex
 * subscription backend has its own caching and is left untouched.
 */

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** FNV-1a, 32-bit, hex. Fast, stable, and dependency-free. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Text of the first system/developer message, for the cache-key seed. */
function firstSystemText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (const message of messages) {
    if (!isObject(message)) continue;
    const role = message.role;
    if (role !== "system" && role !== "developer") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          isObject(part) && typeof part.text === "string" ? part.text : "",
        )
        .join("");
    }
    return "";
  }
  return "";
}

export function injectPromptCacheKey(bodyText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!isObject(parsed)) return bodyText;
  if (typeof parsed.prompt_cache_key === "string") return bodyText;

  const model = typeof parsed.model === "string" ? parsed.model : "";
  const seed =
    typeof parsed.instructions === "string"
      ? parsed.instructions
      : firstSystemText(parsed.messages);
  if (!model && !seed) return bodyText;

  const key = `termigo-${fnv1a(`${model}\u0000${seed}`)}`;
  return JSON.stringify({ ...parsed, prompt_cache_key: key });
}

const OPENAI_API_HOST = /(^|\.)api\.openai\.com$/i;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** `fetch` wrapper injecting `prompt_cache_key` on `api.openai.com` requests. */
export function createOpenAiCacheFetch(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url =
      input instanceof URL
        ? input.toString()
        : typeof input === "string"
          ? input
          : input.url;
    if (!OPENAI_API_HOST.test(hostOf(url)) || typeof init?.body !== "string") {
      return base(input, init);
    }
    const body = injectPromptCacheKey(init.body);
    if (body === init.body) return base(input, init);
    return base(input, { ...init, body });
  };
}
