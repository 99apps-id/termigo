import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CODE_IDENTITY,
  createClaudeOAuthFetch,
  withClaudeCodeIdentity,
} from "./claudeOAuthFetch";

const identity = { type: "text", text: CLAUDE_CODE_IDENTITY };

describe("withClaudeCodeIdentity", () => {
  // Anthropic answers 429 rate_limit_error "Error" to a subscription request
  // whose first system block is anything but the bare identity.
  it("moves the identity ahead of a profile prelude", () => {
    expect(
      withClaudeCodeIdentity([
        { type: "text", text: "Plan briefly." },
        identity,
        { type: "text", text: "Stable", cache_control: { type: "ephemeral" } },
      ]),
    ).toEqual([
      identity,
      { type: "text", text: "Plan briefly." },
      { type: "text", text: "Stable", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("adds the identity when the prompt has none", () => {
    expect(withClaudeCodeIdentity([{ type: "text", text: "Rules" }])).toEqual([
      identity,
      { type: "text", text: "Rules" },
    ]);
    expect(withClaudeCodeIdentity(undefined)).toEqual([identity]);
  });

  it("splits a string system prompt so the identity stands alone", () => {
    expect(withClaudeCodeIdentity(`${CLAUDE_CODE_IDENTITY}\n\nRules`)).toEqual([
      identity,
      { type: "text", text: "Rules" },
    ]);
    expect(withClaudeCodeIdentity("Rules")).toEqual([
      identity,
      { type: "text", text: "Rules" },
    ]);
  });

  it("drops a cache marker from the identity block", () => {
    const out = withClaudeCodeIdentity([
      { ...identity, cache_control: { type: "ephemeral" } },
    ]);
    expect(out).toEqual([identity]);
  });
});

describe("createClaudeOAuthFetch", () => {
  it("rewrites the system of a Messages request", async () => {
    const inner = vi.fn(async () => new Response("{}"));
    const wrapped = createClaudeOAuthFetch(inner as unknown as typeof fetch);
    await wrapped("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "m",
        system: [{ type: "text", text: "x" }],
      }),
    });
    const sent = JSON.parse(
      (inner.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(sent.system[0]).toEqual(identity);
    expect(sent.system[1]).toEqual({ type: "text", text: "x" });
  });

  it("passes other requests through untouched", async () => {
    const inner = vi.fn(async () => new Response("{}"));
    const wrapped = createClaudeOAuthFetch(inner as unknown as typeof fetch);
    const init = { method: "POST", body: "{}" };
    await wrapped("https://api.anthropic.com/v1/messages/count_tokens", init);
    expect(inner).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages/count_tokens",
      init,
    );
  });
});
