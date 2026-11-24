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
export const AG_MAX_OUTPUT_TOKENS = 65_536;
export const AG_CONSUMER_PROJECT = "aicode-consumers";

/**
 * The Antigravity client this app presents as. Cloud Code gates models on it:
 * `fetchAvailableModels` lists the Gemini 4 family (Neon, Hydrogen, Argon,
 * Carbon) only for the Antigravity CLI 1.5.15 identity with its paired
 * changelist (`cl=1027820220`), matching termixgo (`internal/provider/antigravity.go`).
 * The Rust token exchange (oauth.rs `ag_user_agent`) and the Go companion pin
 * the same identity.
 */
export const AG_CLI_VERSION = "1.5.15";
export const AG_CLI_CHANGELIST = "1027820220";
export const AG_CLIENT = `antigravity/cli/${AG_CLI_VERSION}`;

export function agUserAgent(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  let osType = "linux";
  let arch = "amd64";
  if (/Windows/i.test(ua)) {
    osType = "windows";
    arch = /ARM64|aarch64/i.test(ua) ? "arm64" : "amd64";
  } else if (/Macintosh|Mac OS/i.test(ua)) {
    osType = "darwin";
    arch = "arm64";
  } else if (/aarch64|arm64/i.test(ua)) {
    arch = "arm64";
  }
  return `antigravity/cli/${AG_CLI_VERSION} (aidev_client; os_type=${osType}; arch=${arch}; cl=${AG_CLI_CHANGELIST}; auth_method=consumer)`;
}

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

/** Gemini 4 families the Antigravity CLI 1.5.15 backend serves. */
const GEMINI4_FAMILIES = ["neon", "hydrogen", "argon", "carbon"] as const;
type Gemini4Family = (typeof GEMINI4_FAMILIES)[number];

/** Levels each family takes, lowest first, as the CLI names its wire ids. */
const GEMINI4_LEVELS: Record<Gemini4Family, readonly string[]> = {
  neon: ["low", "medium", "high", "xhigh"],
  hydrogen: ["low", "medium", "high", "xhigh"],
  argon: ["low", "medium", "high"],
  carbon: ["low", "medium", "high"],
};

const AG_MODEL_ENUMS: Record<string, string> = {
  "gemini-4-argon-low": "MODEL_PLACEHOLDER_M419",
  "gemini-4-argon-medium": "MODEL_PLACEHOLDER_M418",
  "gemini-4-argon-high": "MODEL_PLACEHOLDER_M417",
  "gemini-3.8-flash-low": "MODEL_PLACEHOLDER_M320",
  "gemini-3.8-flash-medium": "MODEL_PLACEHOLDER_M319",
  "gemini-3.8-flash-high": "MODEL_PLACEHOLDER_M318",
};

/** `neon`, `hydrogen`, `argon` or `carbon` for a Gemini 4 id, prefixed or not. */
export function gemini4Family(model: string): Gemini4Family | null {
  const id = model.replace(/^antigravity-/, "");
  const rest = id.startsWith("gemini-4-") ? id.slice("gemini-4-".length) : "";
  const family = rest.split("-")[0];
  const known = GEMINI4_FAMILIES.find((f) => f === family);
  return known ?? null;
}

/**
 * The wire id the Cloud Code backend expects for a Gemini 4 pick.
 *
 * The backend names each tier `gemini-4-<family>-<level>`, so a bare
 * `gemini-4-argon` is rejected as an unknown model. An id that already ends in
 * a level the family takes is kept; otherwise "high" is appended, which is the
 * models' own default. Any other id is returned unchanged.
 */
export function agWireModel(modelId: string): string {
  const family = gemini4Family(modelId);
  if (!family) return modelId;
  const id = modelId.replace(/^antigravity-/, "");
  const base = `gemini-4-${family}`;
  const levels = GEMINI4_LEVELS[family];
  if (id.startsWith(`${base}-`)) {
    const suffix = id.slice(base.length + 1);
    if (levels.includes(suffix)) return id;
  }
  return `${base}-high`;
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
  // JSON schema constraints unsupported by Gemini protobuf Schema:
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minimum",
  "maximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
]);

function reduceTypeList(names: readonly unknown[]): {
  type: string;
  nullable: boolean;
} {
  let chosen = "";
  let nullable = false;
  const strings = names.filter((n): n is string => typeof n === "string");
  const lower = strings.map((s) => s.toLowerCase());
  if (lower.includes("null")) nullable = true;
  // When reducing a type union, prefer structured types so schema properties
  // or items are preserved rather than orphaned.
  if (lower.includes("array")) chosen = "array";
  else if (lower.includes("object")) chosen = "object";
  else if (lower.includes("string")) chosen = "string";
  else if (lower.includes("number")) chosen = "number";
  else if (lower.includes("integer")) chosen = "integer";
  else if (lower.includes("boolean")) chosen = "boolean";
  else chosen = strings[0] || "string";
  return { type: chosen, nullable };
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

  // Gemini Schema protobuf structural invariants:
  // 1. "items" is strictly valid only when type is "array".
  if (out.items !== undefined && out.type !== "array") {
    delete out.items;
  }
  // 2. An "array" type must provide "items" with a concrete type.
  if (out.type === "array") {
    if (!isObject(out.items) || !out.items.type) {
      out.items = { type: "string" };
    }
  }
  // 3. "properties" is strictly valid only when type is "object".
  if (out.properties !== undefined && out.type !== "object") {
    delete out.properties;
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

export function sanitizeFunctionName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  const prefixed =
    cleaned.length > 0 && /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
  const trimmed = prefixed || "_unknown";
  return trimmed.length > 64 ? trimmed.slice(0, 64) : trimmed;
}

function cleanFunctionDeclaration(declaration: JsonObject): JsonObject {
  const name =
    typeof declaration.name === "string"
      ? sanitizeFunctionName(declaration.name)
      : declaration.name;
  if (!("parameters" in declaration)) return { ...declaration, name };
  return {
    ...declaration,
    name,
    parameters: pruneUndefinedRequired(stripSchemaKeys(declaration.parameters)),
  };
}

function cleanTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!isObject(tool) || !Array.isArray(tool.functionDeclarations))
      return tool;
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

export function newUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const hex = randomHex(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function modelStepCount(contents: readonly unknown[]): number {
  let steps = 0;
  for (const item of contents) {
    if (isObject(item) && item.role === "model") steps += 1;
  }
  return steps;
}

function antigravityLabels(
  wireModel: string,
  steps: number,
  cascadeId: string,
  trajectoryId: string,
): Record<string, string> {
  const labels: Record<string, string> = {
    cascade_id: cascadeId,
    last_step_index: String(steps),
    request_id: `${trajectoryId}-${steps}`,
    root_cascade_id: cascadeId,
    trajectory_id: trajectoryId,
    used_claude: String(wireModel.startsWith("claude-")),
    used_claude_conservative: "false",
    used_non_gemini_model: String(!wireModel.startsWith("gemini-")),
  };
  const modelEnum = AG_MODEL_ENUMS[wireModel];
  if (modelEnum) labels.model_enum = modelEnum;
  return labels;
}

/** Wraps a Gemini generateContent body in the Cloud Code envelope. */
export function buildAntigravityBody(
  bodyText: string,
  project: string,
  session: string,
  modelId: string,
  ids?: { cascadeId: string; trajectoryId: string },
): string {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = null;
  }
  const original = isObject(parsed) ? parsed : {};
  const contents = Array.isArray(original.contents) ? original.contents : [];
  const steps = modelStepCount(contents);
  const cascadeId = ids?.cascadeId || newUuid();
  const trajectoryId = ids?.trajectoryId || newUuid();
  const request: JsonObject = {
    ...original,
    sessionId: session,
    labels: antigravityLabels(modelId, steps, cascadeId, trajectoryId),
  };
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
  // With tools but no explicit choice, keep caller-set toolConfig only.
  if (
    Array.isArray(request.tools) &&
    request.tools.length > 0 &&
    !isObject(request.toolConfig)
  ) {
    request.toolConfig = {
      functionCallingConfig: { mode: "VALIDATED" },
    };
  }
  // The Cloud Code backend wants the system instruction as a user Content; the
  // Google provider omits the role, so add it the way the Go client does.
  if (
    isObject(request.systemInstruction) &&
    !("role" in request.systemInstruction)
  ) {
    request.systemInstruction = { role: "user", ...request.systemInstruction };
  }
  const envelope: JsonObject = {
    project,
    model: modelId,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: `agent/${cascadeId}/${Date.now()}/${trajectoryId}/${steps + 1}`,
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
