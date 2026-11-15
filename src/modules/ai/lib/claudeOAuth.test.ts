import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CODE_IDENTITY,
  CLAUDE_OAUTH_BETA,
  CLAUDE_PDF_BETA,
  buildClaudeOAuthBetaHeader,
  claudeCliUserAgent,
  createClaudeOAuthFetch,
  extractClaudeCodeMinVersion,
  rewriteClaudeOAuthUrl,
  setClaudeCliVersionForTests,
  withClaudeCodeIdentity,
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
    expect(toolNames).toContain("Bash");
    expect(toolNames).not.toContain("read_file");
    const messages = body.messages as Array<{
      content: Array<{ name?: string }>;
    }>;
    expect(messages[0].content[0].name).toBe("read_file_ide");
    const streamed = await res.text();
    expect(streamed).toContain('"name":"read_file"');
    expect(streamed).not.toContain("read_file_ide");
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
      claudeCliUserAgent("2.1.325"),
    );
    expect(seenHeaders[0].get("x-app")).toBe("cli");
    expect(seenHeaders[0].get("x-stainless-runtime")).toBe("node");
    expect(seenHeaders[1].get("authorization")).toBe("Bearer tok-new");
    expect(seenHeaders[2].get("user-agent")).toBe(
      claudeCliUserAgent("2.1.400"),
    );
    expect((seenBodies[0].system as Array<{ text: string }>)[0].text).toBe(
      CLAUDE_CODE_IDENTITY,
    );
    setClaudeCliVersionForTests(null);
  });
});
