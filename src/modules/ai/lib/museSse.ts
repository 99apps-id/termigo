/**
 * Muse (Meta) streams OpenAI-compatible SSE, but its final events can omit
 * `choices` (a usage-only tail) or send `choices: null`. The AI SDK's chunk
 * schema is a union of `{ choices: [...] }` and `{ error: { message } }`, so a
 * chunk that is neither fails validation and the whole turn reports
 * `invalid_union` even though the text already streamed. This normalises such a
 * line to `choices: []` so the SDK reads any `usage` and ignores the rest.
 *
 * Kept pure and free of Tauri so it is unit-testable. The fetch wiring lives in
 * `museStream.ts`.
 */

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rewrites one SSE line, injecting an empty `choices` array when a non-error
 * chunk lacks one. A chunk that carries `error`, or an already-valid `choices`
 * array, is returned untouched so real errors still surface.
 */
export function sanitizeMuseSseLine(line: string): string {
  const terminated = line.endsWith("\n");
  const withoutNewline = terminated ? line.slice(0, -1) : line;
  const carriage = withoutNewline.endsWith("\r");
  const core = carriage ? withoutNewline.slice(0, -1) : withoutNewline;
  if (!core.startsWith("data:")) return line;
  const payload = core.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") return line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return line;
  }
  if (!isObject(parsed)) return line;
  if ("error" in parsed) return line;
  if (Array.isArray(parsed.choices)) return line;
  const ending = `${carriage ? "\r" : ""}${terminated ? "\n" : ""}`;
  return `data: ${JSON.stringify({ ...parsed, choices: [] })}${ending}`;
}
