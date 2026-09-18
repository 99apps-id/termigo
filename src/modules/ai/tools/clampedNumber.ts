import { z } from "zod";

/**
 * Creates a resilient integer Zod schema that clamps inputs within [min, max]
 * instead of failing schema validation.
 *
 * Models often guess values outside schema boundaries (e.g. timeout_secs: 900
 * when the limit is 300) or pass numeric strings (e.g. "60"). A strict schema
 * throws a fatal Type validation error at the AI SDK layer, crashing the entire
 * conversation run. Preprocessing ensures the value is parsed, clamped, and
 * passed safely to tool execution.
 */
export function clampedInt(min: number, max: number, defaultValue?: number) {
  const inner = z.number().int().min(min).max(max);
  const base = z.preprocess((v) => {
    if (v === undefined || v === null || v === "") return defaultValue;
    const num =
      typeof v === "string"
        ? parseInt(v, 10)
        : typeof v === "number"
          ? v
          : undefined;
    return typeof num === "number" && !Number.isNaN(num)
      ? Math.min(Math.max(min, Math.floor(num)), max)
      : v;
  }, inner.optional());
  return defaultValue !== undefined
    ? base.default(defaultValue)
    : base.optional();
}
