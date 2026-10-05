import { describe, expect, it } from "vitest";

import {
  AG_MAX_OUTPUT_TOKENS,
  buildAntigravityBody,
  newSessionId,
  projectIdFrom,
  unwrapAntigravitySseLine,
  type JsonObject,
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

  it("cleans unsupported tool-schema keywords and prunes required", () => {
    const envelope = parse(
      buildAntigravityBody(
        JSON.stringify({
          contents: [],
          tools: [
            {
              functionDeclarations: [
                {
                  name: "read_file",
                  parameters: {
                    type: "object",
                    additionalProperties: false,
                    anyOf: [{ type: "string" }],
                    properties: {
                      title: { type: "string", additionalProperties: false },
                      path: { type: ["string", "null"] },
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
    const parameters = declaration.parameters as JsonObject;
    expect(parameters.additionalProperties).toBeUndefined();
    expect(parameters.anyOf).toBeUndefined();
    const properties = parameters.properties as JsonObject;
    expect(properties.title).toEqual({ type: "string" });
    expect(properties.path).toEqual({ type: "string", nullable: true });
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
