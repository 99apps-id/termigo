import { describe, expect, it } from "vitest";

import { injectPromptCacheKey } from "./promptCacheKey";

function keyOf(body: object): string {
  return JSON.parse(injectPromptCacheKey(JSON.stringify(body)))
    .prompt_cache_key as string;
}

describe("injectPromptCacheKey", () => {
  it("adds a stable key seeded by model and system prompt", () => {
    const body = {
      model: "gpt-5.6",
      messages: [
        { role: "system", content: "You are Termigo." },
        { role: "user", content: "hi" },
      ],
    };
    const a = keyOf(body);
    const b = keyOf(body);
    expect(a).toMatch(/^termigo-[0-9a-f]{8}$/);
    expect(a).toBe(b);
  });

  it("gives different prefixes different keys", () => {
    const base = {
      model: "gpt-5.6",
      messages: [{ role: "system", content: "A" }],
    };
    expect(keyOf(base)).not.toBe(keyOf({ ...base, model: "gpt-5.5" }));
    expect(
      keyOf({ ...base, messages: [{ role: "system", content: "B" }] }),
    ).not.toBe(keyOf(base));
  });

  it("keys a Responses body from its instructions", () => {
    const key = keyOf({ model: "gpt-5.6", instructions: "You are Termigo." });
    expect(key).toMatch(/^termigo-[0-9a-f]{8}$/);
  });

  it("keeps a key the caller already set", () => {
    const body = JSON.stringify({
      model: "gpt-5.6",
      messages: [{ role: "system", content: "A" }],
      prompt_cache_key: "custom",
    });
    expect(injectPromptCacheKey(body)).toBe(body);
  });

  it("leaves malformed or empty bodies untouched", () => {
    expect(injectPromptCacheKey("not json")).toBe("not json");
    expect(injectPromptCacheKey("{}")).toBe("{}");
  });
});
