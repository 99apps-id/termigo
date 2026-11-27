import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CODE_IDENTITY,
  CLAUDE_OAUTH_BETA,
  CLAUDE_OAUTH_DEFAULT_CLI_VERSION,
  CLAUDE_PDF_BETA,
  buildClaudeOAuthBetaHeader,
  claudeBillingHeader,
  claudeCliUserAgent,
  claudeFingerprint,
  claudeFingerprintText,
  cloakClaudeToolNames,
  createClaudeOAuthFetch,
  dropEmptyTurns,
  extractClaudeCodeMinVersion,
  isThinkingRejection,
  rewriteClaudeOAuthUrl,
  setClaudeCliVersionForTests,
  stripThinking,
  withClaudeCodeIdentity,
  withoutEmptyTurns,
} from "./claudeOAuth";

describe("claudeOAuth", () => {
  it("prepends Claude Code identity first without cache_control and strips duplicates", () => {
    const blocks = withClaudeCodeIdentity([
      {
        type: "text",
        text: "You are Termigo.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      {
        type: "text",
        text: CLAUDE_CODE_IDENTITY,
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(blocks).toEqual([
      { type: "text", text: CLAUDE_CODE_IDENTITY },
      {
        type: "text",
        text: "You are Termigo.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
  });

  it("rewrites /v1/messages to include ?beta=true", () => {
    expect(rewriteClaudeOAuthUrl("https://api.anthropic.com/v1/messages")).toBe(
      "https://api.anthropic.com/v1/messages?beta=true",
    );
    expect(
      rewriteClaudeOAuthUrl("https://api.anthropic.com/v1/messages?beta=true"),
    ).toBe("https://api.anthropic.com/v1/messages?beta=true");
  });

  it("builds beta header with all OAuth flags and pdfs beta when needed", () => {
    const plain = buildClaudeOAuthBetaHeader(null, false);
    expect(plain).toBe(CLAUDE_OAUTH_BETA);
    const withPdf = buildClaudeOAuthBetaHeader(
      "fine-grained-tool-streaming-2025-05-14",
      true,
    );
    expect(withPdf).toContain(CLAUDE_PDF_BETA);
    expect(withPdf).toContain("fine-grained-tool-streaming-2025-05-14");
  });

  it("extracts minimum required CLI version from claude_code_version_too_old", () => {
    expect(
      extractClaudeCodeMinVersion(
        '{"error":{"type":"claude_code_version_too_old","message":"Please upgrade to at least 2.2.10"}}',
      ),
    ).toBe("2.2.10");
    expect(extractClaudeCodeMinVersion("some other error 2.2.10")).toBeNull();
  });

  it("injects metadata.user_id and cloaks tool names in both directions", async () => {
    const seenBodies: Array<Record<string, unknown>> = [];
    const baseFetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file_ide","input":{}}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    );
    const wrapped = createClaudeOAuthFetch(
      baseFetch as unknown as typeof fetch,
      "tok-meta",
      async () => null,
    );
    const res = await wrapped("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-5",
        system: "You are Termigo.",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_0", name: "read_file", input: {} },
            ],
          },
        ],
        tools: [
          {
            name: "read_file",
            description: "Read a file.",
            input_schema: { type: "object", properties: {} },
          },
        ],
      }),
    });
    const body = seenBodies[0];
    const metadata = body.metadata as { user_id?: string };
    const userId = JSON.parse(metadata?.user_id ?? "{}") as Record<
      string,
      string
    >;
    expect(userId.device_id).toMatch(/^[0-9a-f]{64}$/);
    expect(userId.account_uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(userId.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const toolNames = (body.tools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    expect(toolNames).toContain("read_file_ide");
    expect(toolNames).not.toContain("Bash");
    expect(toolNames).not.toContain("read_file");
    const messages = body.messages as Array<{
      content: Array<{ name?: string }>;
    }>;
    expect(messages[0].content[0].name).toBe("read_file_ide");
    const streamed = await res.text();
    expect(streamed).toContain('"name":"read_file"');
    expect(streamed).not.toContain("read_file_ide");
  });

  it("sanitizes dotted and slashed tool names Anthropic would reject", async () => {
    const seenBodies: Array<Record<string, unknown>> = [];
    const baseFetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"mcp_files_read_ide","input":{}}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    );
    const wrapped = createClaudeOAuthFetch(
      baseFetch as unknown as typeof fetch,
      "tok-meta",
      async () => null,
    );
    const res = await wrapped("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-5",
        system: "You are Termigo.",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_0",
                name: "mcp/files.read",
                input: {},
              },
            ],
          },
        ],
        tools: [
          {
            name: "mcp/files.read",
            description: "Read via MCP.",
            input_schema: { type: "object", properties: {} },
          },
          {
            name: "mcp files.read",
            description: "Same after sanitizing; must not collide.",
            input_schema: { type: "object", properties: {} },
          },
        ],
      }),
    });
    const body = seenBodies[0];
    const toolNames = (body.tools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    for (const name of toolNames) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
    }
    expect(new Set(toolNames).size).toBe(toolNames.length);
    const messages = body.messages as Array<{
      content: Array<{ name?: string }>;
    }>;
    expect(messages[0].content[0].name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
    const streamed = await res.text();
    expect(streamed).toContain('"name":"mcp/files.read"');
  });

  it("injects identity, headers, refreshes on 401, and upgrades CLI version once", async () => {
    setClaudeCliVersionForTests(null);
    const seenHeaders: Array<Headers> = [];
    const seenBodies: Array<Record<string, unknown>> = [];
    let call = 0;

    const baseFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        call += 1;
        expect(String(input)).toBe(
          "https://api.anthropic.com/v1/messages?beta=true",
        );
        seenHeaders.push(new Headers(init?.headers));
        seenBodies.push(JSON.parse(String(init?.body)));
        if (call === 1) {
          return new Response("unauthorized", { status: 401 });
        }
        if (call === 2) {
          return new Response(
            '{"error":{"type":"claude_code_version_too_old","message":"minimum required version is 2.1.400"}}',
            { status: 400 },
          );
        }
        return new Response('{"id":"msg_1"}', { status: 200 });
      },
    );

    const wrapped = createClaudeOAuthFetch(
      baseFetch as unknown as typeof fetch,
      "tok-old",
      async () => "tok-new",
    );

    const res = await wrapped("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "user-agent": "ai-sdk/anthropic/3.0.0",
        "x-api-key": "should-be-removed",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        system: "You are Termigo.",
        messages: [],
      }),
    });

    expect(res.status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(3);
    expect(seenHeaders[0].get("authorization")).toBe("Bearer tok-old");
    expect(seenHeaders[0].has("x-api-key")).toBe(false);
    expect(seenHeaders[0].get("user-agent")).toBe(
      claudeCliUserAgent(CLAUDE_OAUTH_DEFAULT_CLI_VERSION),
    );
    expect(seenHeaders[0].get("x-client-request-id")).toMatch(/^[\w-]{8,}$/);
    expect(seenHeaders[1].get("x-client-request-id")).not.toBe(
      seenHeaders[0].get("x-client-request-id"),
    );
    expect(seenHeaders[0].get("x-app")).toBe("cli");
    expect(seenHeaders[0].get("x-stainless-runtime")).toBe("node");
    expect(seenHeaders[1].get("authorization")).toBe("Bearer tok-new");
    expect(seenHeaders[2].get("user-agent")).toBe(
      claudeCliUserAgent("2.1.400"),
    );
    // The billing block leads, then the exact identity, as the CLI sends them.
    const sentSystem = seenBodies[0].system as Array<{ text: string }>;
    expect(sentSystem[0].text).toMatch(
      /^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[0-9a-f]{3}; cc_entrypoint=cli;$/,
    );
    expect(sentSystem[1].text).toBe(CLAUDE_CODE_IDENTITY);
    // The retry runs under the learned version, so the header must follow it.
    expect((seenBodies[2].system as Array<{ text: string }>)[0].text).toContain(
      "cc_version=2.1.400.",
    );
    setClaudeCliVersionForTests(null);
  });

  it("retries once without thinking when the endpoint refuses a thinking block", async () => {
    setClaudeCliVersionForTests(null);
    const seen: Array<Record<string, unknown>> = [];
    let call = 0;
    const baseFetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        call += 1;
        seen.push(JSON.parse(String(init?.body)));
        if (call === 1) {
          return new Response(
            '{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block"}}',
            { status: 400 },
          );
        }
        return new Response('{"id":"msg_1"}', { status: 200 });
      },
    );
    const wrapped = createClaudeOAuthFetch(
      baseFetch as unknown as typeof fetch,
      "tok",
      async () => null,
    );
    const res = await wrapped("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        thinking: { type: "adaptive", display: "summarized" },
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "x", signature: "bad" },
              { type: "tool_use", id: "t1", name: "get_time", input: {} },
            ],
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(2);
    expect(seen[0].thinking).toBeDefined();
    expect(seen[1].thinking).toBeUndefined();
    const retried = seen[1].messages as Array<{ content: unknown }>;
    expect(JSON.stringify(retried[1].content)).not.toContain("thinking");
    expect(JSON.stringify(retried[1].content)).toContain("tool_use");
  });

  it("does not retry a 400 that is not about thinking", async () => {
    const baseFetch = vi.fn(
      async () =>
        new Response(
          '{"type":"error","error":{"type":"invalid_request_error","message":"messages: Input should be a valid list"}}',
          { status: 400 },
        ),
    );
    const wrapped = createClaudeOAuthFetch(
      baseFetch as unknown as typeof fetch,
      "tok",
      async () => null,
    );
    const res = await wrapped("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [] }),
    });
    expect(res.status).toBe(400);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("strips thinking blocks and keeps a turn from going empty", () => {
    const body: Record<string, unknown> = {
      thinking: { type: "adaptive" },
      context_management: { edits: [] },
      messages: [
        { role: "assistant", content: [{ type: "thinking", signature: "s" }] },
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "d" },
            { type: "text", text: "kept" },
          ],
        },
        { role: "user", content: "plain string is left alone" },
      ],
    };
    expect(stripThinking(body)).toBe(true);
    expect(body.thinking).toBeUndefined();
    expect(body.context_management).toBeUndefined();
    const messages = body.messages as Array<{ content: unknown }>;
    expect(messages[0].content).toEqual([
      { type: "text", text: "(thinking omitted)" },
    ]);
    expect(messages[1].content).toEqual([{ type: "text", text: "kept" }]);
    expect(messages[2].content).toBe("plain string is left alone");
    expect(stripThinking({ messages: [] })).toBe(false);
  });

  it("recognises a thinking rejection by wording, not by status alone", () => {
    expect(
      isThinkingRejection(
        '{"error":{"type":"invalid_request_error","message":"Invalid `signature` in `thinking` block"}}',
      ),
    ).toBe(true);
    expect(
      isThinkingRejection(
        '{"error":{"type":"invalid_request_error","message":"max_tokens: 128001 > 128000"}}',
      ),
    ).toBe(false);
    expect(isThinkingRejection("thinking")).toBe(false);
  });

  it("drops a turn the endpoint would refuse, and nothing else", () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: "user", content: "hi" },
        // An empty STRING is what the SDK turns into an empty text block.
        { role: "assistant", content: "" },
        { role: "user", content: "   " },
        { role: "assistant", content: [{ type: "text", text: "" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "  " },
            { type: "tool_use", id: "t1", name: "get_time", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "" },
            { type: "text", text: "" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "", signature: "s" }],
        },
        { role: "user", content: "Reply with the single word OK." },
      ],
    };
    expect(dropEmptyTurns(body)).toBe(true);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    // The tool call survives with its blank sibling removed, the tool result
    // survives with its blank sibling removed, and a thinking block is kept.
    expect(messages[1].content).toEqual([
      { type: "tool_use", id: "t1", name: "get_time", input: {} },
    ]);
    expect(messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "" },
    ]);
    expect((messages[3].content as Array<{ type: string }>)[0].type).toBe(
      "thinking",
    );
    expect(
      dropEmptyTurns({ messages: [{ role: "user", content: "ok" }] }),
    ).toBe(false);
    expect(dropEmptyTurns({})).toBe(false);
  });

  it("sends no empty turn through either fetch wrapper", async () => {
    const sentBodies: Array<{ messages: Array<{ content: unknown }> }> = [];
    const base = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentBodies.push(JSON.parse(String(init?.body)));
        return new Response('{"id":"msg"}', { status: 200 });
      },
    ) as unknown as typeof fetch;
    const payload = JSON.stringify({
      model: "claude-sonnet-5-5",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "" },
        { role: "user", content: "go" },
      ],
    });

    await createClaudeOAuthFetch(
      base,
      "tok",
      async () => null,
    )("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: payload,
    });
    await withoutEmptyTurns(base)("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: payload,
    });
    // A body that is not JSON passes through untouched.
    await withoutEmptyTurns(base)("https://example.test/x", {
      method: "POST",
      body: "not json",
    }).catch(() => {});

    expect(sentBodies).toHaveLength(2);
    for (const sent of sentBodies) {
      expect(JSON.stringify(sent.messages)).not.toContain('""');
      expect(sent.messages).toHaveLength(2);
    }
  });

  it("computes the fingerprint the Claude Code client advertises", async () => {
    // Recorded from the client's own header: 2.1.325 + "say hi" -> 382.
    expect(await claudeFingerprint("say hi", "2.1.325")).toBe("382");
    expect(
      await claudeBillingHeader(
        [{ role: "user", content: "say hi" }],
        "2.1.325",
      ),
    ).toBe(
      "x-anthropic-billing-header: cc_version=2.1.325.382; cc_entrypoint=cli;",
    );
  });

  it("fingerprints the prompt, not the harness env block", () => {
    expect(
      claudeFingerprintText([
        { role: "assistant", content: "x" },
        { role: "user", content: [{ type: "text", text: "  " }] },
        {
          role: "user",
          content: [{ type: "text", text: "say hi\n<env>\ncwd: /x\n</env>" }],
        },
      ]),
    ).toBe("say hi");
    expect(claudeFingerprintText("nope")).toBe("");
  });

  it("offers only the client's own tools, never decoys", () => {
    const body: Record<string, unknown> = {
      tools: [{ name: "read_file", input_schema: { type: "object" } }],
      messages: [],
    };
    const aliases = cloakClaudeToolNames(body);
    expect((body.tools as Array<{ name: string }>).map((t) => t.name)).toEqual([
      "read_file_ide",
    ]);
    expect(aliases.get("read_file_ide")).toBe("read_file");
  });
});
