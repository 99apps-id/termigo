import { describe, expect, it } from "vitest";
import {
  AG_CLI_VERSION,
  AG_MAX_OUTPUT_TOKENS,
  agUserAgent,
  agWireModel,
  buildAntigravityBody,
  type JsonObject,
  newSessionId,
  projectIdFrom,
  unwrapAntigravitySseLine,
} from "./antigravityProtocol";
import { GEMINI_SAFETY_SETTINGS } from "./googleSafety";

function parse(text: string): JsonObject {
  return JSON.parse(text) as JsonObject;
}

describe("buildAntigravityBody", () => {
  it("wraps a Gemini body in the Cloud Code envelope", () => {
    const envelope = parse(
      buildAntigravityBody(
        JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { maxOutputTokens: 100000 },
          systemInstruction: { parts: [{ text: "sys" }] },
        }),
        "proj-1",
        "12345",
        "gemini-3.8-flash-medium",
      ),
    );
    expect(envelope.project).toBe("proj-1");
    expect(envelope.model).toBe("gemini-3.8-flash-medium");
    expect(envelope.userAgent).toBe("antigravity");
    expect(String(envelope.requestId)).toMatch(/^agent\//);

    const request = envelope.request as JsonObject;
    expect(request.sessionId).toBe("12345");
    expect(request.contents).toHaveLength(1);
    const generation = request.generationConfig as JsonObject;
    expect(generation.maxOutputTokens).toBe(AG_MAX_OUTPUT_TOKENS);
    expect(generation.thinkingConfig).toEqual({
      thinkingLevel: "medium",
      includeThoughts: true,
    });
    expect((request.systemInstruction as JsonObject).role).toBe("user");
  });

  it("sends permissive safety settings so code/security prompts are not blocked", () => {
    const envelope = parse(
      buildAntigravityBody('{"contents":[]}', "p", "1", "gemini-pro-agent"),
    );
    const request = envelope.request as JsonObject;
    expect(request.safetySettings).toEqual(GEMINI_SAFETY_SETTINGS);
  });

  it("cleans unsupported tool-schema keywords and prunes required", () => {
    const envelope = parse(
      buildAntigravityBody(
        JSON.stringify({
          contents: [],
          tools: [
            {
              functionDeclarations: [
                {
                  name: "a".repeat(80),
                  parameters: {
                    type: "object",
                    additionalProperties: false,
                    anyOf: [{ type: "string" }],
                    exclusiveMinimum: 0,
                    properties: {
                      title: { type: "string", additionalProperties: false },
                      path: { type: ["string", "null"] },
                      count: { type: "number", minimum: 1, maximum: 100 },
                      tags: {
                        type: ["null", "boolean", "array"],
                        items: {},
                      },
                      notArray: {
                        type: "boolean",
                        items: { type: "string" },
                      },
                      notObject: {
                        type: "string",
                        properties: { a: { type: "string" } },
                      },
                    },
                    required: ["path", "missing"],
                  },
                },
              ],
            },
          ],
        }),
        "p",
        "1",
        "gemini-pro-agent",
      ),
    );
    const request = envelope.request as JsonObject;
    const tools = request.tools as JsonObject[];
    const declaration = (tools[0].functionDeclarations as JsonObject[])[0];
    expect(declaration.name).toBe("a".repeat(64));
    const parameters = declaration.parameters as JsonObject;
    expect(parameters.additionalProperties).toBeUndefined();
    expect(parameters.anyOf).toBeUndefined();
    expect(parameters.exclusiveMinimum).toBeUndefined();
    const properties = parameters.properties as JsonObject;
    expect(properties.title).toEqual({ type: "string" });
    expect(properties.path).toEqual({ type: "string", nullable: true });
    expect(properties.count).toEqual({ type: "number" });
    expect(properties.tags).toEqual({
      type: "array",
      nullable: true,
      items: { type: "string" },
    });
    expect(properties.notArray).toEqual({ type: "boolean" });
    expect(properties.notObject).toEqual({ type: "string" });
    expect(parameters.required).toEqual(["path"]);
  });
});

describe("unwrapAntigravitySseLine", () => {
  it("unwraps the Cloud Code response envelope", () => {
    const line =
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}\n';
    expect(unwrapAntigravitySseLine(line)).toBe(
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n',
    );
  });

  it("leaves a bare candidate event and non-data lines untouched", () => {
    expect(unwrapAntigravitySseLine('data: {"candidates":[]}\n')).toBe(
      'data: {"candidates":[]}\n',
    );
    expect(unwrapAntigravitySseLine("\n")).toBe("\n");
    expect(unwrapAntigravitySseLine("event: ping\n")).toBe("event: ping\n");
  });

  it("preserves CRLF endings", () => {
    expect(unwrapAntigravitySseLine('data: {"response":{"x":1}}\r\n')).toBe(
      'data: {"x":1}\r\n',
    );
  });
});

describe("newSessionId", () => {
  it("is a non-negative decimal integer string", () => {
    const id = newSessionId();
    expect(id).toMatch(/^\d+$/);
    expect(BigInt(id) >= 0n).toBe(true);
    expect(BigInt(id) <= 0x7fffffffffffffffn).toBe(true);
  });
});

describe("projectIdFrom", () => {
  it("reads both the string and object shapes", () => {
    expect(projectIdFrom("projects/abc")).toBe("abc");
    expect(projectIdFrom({ projectId: "xyz" })).toBe("xyz");
    expect(projectIdFrom({ id: "projects/klm" })).toBe("klm");
    expect(projectIdFrom(null)).toBe("");
  });
});

describe("agUserAgent", () => {
  it("names the Antigravity CLI 1.5.9 client the backend catalogues Gemini 4 under", () => {
    const ua = agUserAgent();
    expect(ua.startsWith("antigravity/cli/1.5.9 ")).toBe(true);
    expect(ua).toMatch(/ (windows|darwin|linux)\/(x64|arm64)$/);
  });

  // Cloud Code lists Gemini 4 only for the Antigravity CLI identity; the IDE
  // identity got 404 "Requested entity was not found" for Hydrogen and Argon.
  it("presents as the current Antigravity CLI", () => {
    expect(agUserAgent()).toMatch(
      new RegExp(`^antigravity/cli/${AG_CLI_VERSION.replace(/\./g, "\\.")} `),
    );
    expect(AG_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("agWireModel", () => {
  it("appends the level the Cloud Code backend names each Gemini 4 tier by", () => {
    expect(agWireModel("gemini-4-argon")).toBe("gemini-4-argon-high");
    expect(agWireModel("antigravity-gemini-4-argon")).toBe(
      "gemini-4-argon-high",
    );
    expect(agWireModel("gemini-4-carbon")).toBe("gemini-4-carbon-high");
    expect(agWireModel("gemini-4-hydrogen")).toBe("gemini-4-hydrogen-high");
  });

  it("keeps a level the family actually takes", () => {
    expect(agWireModel("gemini-4-hydrogen-xhigh")).toBe(
      "gemini-4-hydrogen-xhigh",
    );
    expect(agWireModel("gemini-4-carbon-low")).toBe("gemini-4-carbon-low");
  });

  it("caps a level the family does not take at its top tier", () => {
    // Argon stops at high, so the CLI's Hydrogen-only xhigh is not a valid id.
    expect(agWireModel("gemini-4-argon-xhigh")).toBe("gemini-4-argon-high");
  });

  it("leaves every other model id alone", () => {
    expect(agWireModel("gemini-3.8-flash-medium")).toBe(
      "gemini-3.8-flash-medium",
    );
    expect(agWireModel("claude-sonnet-5-5-medium")).toBe(
      "claude-sonnet-5-5-medium",
    );
  });
});
