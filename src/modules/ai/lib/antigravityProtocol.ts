import { GEMINI_SAFETY_SETTINGS } from "./googleSafety";

/**
 * Pure protocol helpers for Google Antigravity's Cloud Code backend.
 *
 * Kept free of any Tauri/network dependency so the wire transforms can be
 * unit-tested directly. The fetch wiring lives in `antigravity.ts`; both mirror
 * the termixgo client (cli/internal/provider/antigravity.go).
 */

export const AG_HOST = "https://daily-cloudcode-pa.googleapis.com";
export const AG_HOST_FALLBACK = "https://cloudcode-pa.googleapis.com";
export const AG_USER_AGENT = "antigravity/ide/2.11.0 darwin/arm64";
export const AG_MAX_OUTPUT_TOKENS = 64_000;

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Cloud Code requires a non-negative, numeric session id, not an opaque token.
// The Go client masks a random 64-bit value to 63 bits for the same reason.
export function newSessionId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  value &= 0x7fffffffffffffffn;
  return value.toString();
}

export function platformCode(): number {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Windows/i.test(ua)) return 5;
  if (/Macintosh|Mac OS/i.test(ua)) return 2;
  return 1;
}

/** Reads a project id from the string or object shapes Cloud Code returns. */
export function projectIdFrom(raw: unknown): string {
  if (typeof raw === "string") return raw.trim().replace(/^projects\//, "");
  if (isObject(raw)) {
    for (const key of ["id", "projectId", "project", "name"]) {
      const value = raw[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim().replace(/^projects\//, "");
      }
    }
  }
  return "";
}

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "$comment",
  "definitions",
  "additionalProperties",
  "propertyNames",
  "patternProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependentRequired",
  "dependentSchemas",
  "default",
  "examples",
  "title",
  "optional",
  "deprecated",
  "readOnly",
  "writeOnly",
  "uniqueItems",
  "const",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
]);

function reduceTypeList(names: readonly unknown[]): {
  type: string;
  nullable: boolean;
} {
  let chosen = "";
  let nullable = false;
  for (const name of names) {
    if (typeof name !== "string") continue;
    if (name.toLowerCase() === "null") {
      nullable = true;
      continue;
    }
    if (!chosen) chosen = name;
  }
  return { type: chosen || "string", nullable };
}

function stripSchemaKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSchemaKeys);
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key) || key.startsWith("x-")) continue;
    // Inside "properties" the keys are property names, not keywords: a tool is
    // free to name one "title" or "required", and filtering it would delete the
    // property and leave a dangling required entry Gemini rejects.
    if (key === "properties" && isObject(entry)) {
      const properties: JsonObject = {};
      for (const [name, property] of Object.entries(entry)) {
        properties[name] = stripSchemaKeys(property);
      }
      out[key] = properties;
      continue;
    }
    // Gemini wants one type string plus `nullable`, never a type union.
    if (key === "type" && Array.isArray(entry)) {
      const reduced = reduceTypeList(entry);
      out.type = reduced.type;
      if (reduced.nullable) out.nullable = true;
      continue;
    }
    out[key] = stripSchemaKeys(entry);
  }
  return out;
}

function pruneUndefinedRequired(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneUndefinedRequired);
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = pruneUndefinedRequired(entry);
  }
  const required = out.required;
  if (Array.isArray(required)) {
    const properties = isObject(out.properties) ? out.properties : {};
    const kept = required.filter(
      (name): name is string =>
        typeof name === "string" && Object.hasOwn(properties, name),
    );
    if (kept.length > 0) out.required = kept;
    else delete out.required;
  }
  return out;
}

function cleanFunctionDeclaration(declaration: JsonObject): JsonObject {
  if (!("parameters" in declaration)) return { ...declaration };
  return {
    ...declaration,
    parameters: pruneUndefinedRequired(stripSchemaKeys(declaration.parameters)),
  };
}

function cleanTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!isObject(tool) || !Array.isArray(tool.functionDeclarations)) return tool;
    return {
      ...tool,
      functionDeclarations: tool.functionDeclarations.map((declaration) =>
        isObject(declaration)
          ? cleanFunctionDeclaration(declaration)
          : declaration,
      ),
    };
  });
}

function buildGenerationConfig(existing: unknown): JsonObject {
  const config: JsonObject = isObject(existing) ? { ...existing } : {};
  const requested = config.maxOutputTokens;
  if (
    typeof requested !== "number" ||
    requested <= 0 ||
    requested > AG_MAX_OUTPUT_TOKENS
  ) {
    config.maxOutputTokens = AG_MAX_OUTPUT_TOKENS;
  }
  // Gemini 3 cannot disable thinking; ask for a thought summary so the
  // transcript shows the reasoning instead of dropping it.
  config.thinkingConfig = { thinkingLevel: "medium", includeThoughts: true };
  return config;
}

function antigravityRequestId(messageCount: number): string {
  const step = Math.max(1, messageCount * 2 - 1);
  return `agent/${randomHex(16)}/${Date.now()}/${randomHex(16)}/${step}`;
}

/** Wraps a Gemini generateContent body in the Cloud Code envelope. */
export function buildAntigravityBody(
  bodyText: string,
  project: string,
  session: string,
  modelId: string,
): string {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = null;
  }
  const original = isObject(parsed) ? parsed : {};
  const contents = Array.isArray(original.contents) ? original.contents : [];
  const request: JsonObject = { ...original, sessionId: session };
  request.tools = cleanTools(request.tools);
  request.generationConfig = buildGenerationConfig(request.generationConfig);
  // Unlock the permissive Gemini safety thresholds so legitimate security /
  // biology / coding prompts are not falsely blocked. Skips a caller-set list.
  if (
    !Array.isArray(request.safetySettings) ||
    request.safetySettings.length === 0
  ) {
    request.safetySettings = GEMINI_SAFETY_SETTINGS;
  }
  // With tools but no explicit choice, the Go client asks the backend to
  // validate every call (mode VALIDATED). A forced tool choice the SDK already
  // set is kept: override it and the agent loses ANY/allowedFunctionNames.
  if (Array.isArray(request.tools) && request.tools.length > 0 && !isObject(request.toolConfig)) {
    request.toolConfig = {
      functionCallingConfig: { mode: "VALIDATED" },
    };
  }
  // The Cloud Code backend wants the system instruction as a user Content; the
  // Google provider omits the role, so add it the way the Go client does.
  if (isObject(request.systemInstruction) && !("role" in request.systemInstruction)) {
    request.systemInstruction = { role: "user", ...request.systemInstruction };
  }
  const envelope: JsonObject = {
    project,
    model: modelId,
    userAgent: "antigravity",
    requestId: antigravityRequestId(contents.length),
    request,
  };
  return JSON.stringify(envelope);
}

/** Rewrites one SSE line, unwrapping the `{"response": {...}}` envelope. */
export function unwrapAntigravitySseLine(line: string): string {
  const terminated = line.endsWith("\n");
  const withoutNewline = terminated ? line.slice(0, -1) : line;
  const carriage = withoutNewline.endsWith("\r");
  const core = carriage ? withoutNewline.slice(0, -1) : withoutNewline;
  if (!core.startsWith("data:")) return line;
  const payload = core.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") return line;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (isObject(parsed) && "response" in parsed) {
      const ending = `${carriage ? "\r" : ""}${terminated ? "\n" : ""}`;
      return `data: ${JSON.stringify(parsed.response)}${ending}`;
    }
  } catch {
    // Not JSON; leave the line untouched for the SDK to report.
  }
  return line;
}
