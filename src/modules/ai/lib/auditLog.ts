// Audit entries for the host to append.
//
// With no approval gates, the audit log is what makes the posture defensible
// afterwards: it is the record an operator reads to answer "what did it actually
// run". So it is deliberately dull (tool, status, a redacted argument summary, a
// timestamp) and it never throws: a tool call must not fail because its observer
// could not write a line.
//
// The write happens in Rust (`audit_append`) because the log directory is in the
// write deny-list, which is the part that makes the record trustworthy.
import { native } from "./native";
import { redactSensitive } from "./redact";

export type AuditStatus = "ok" | "error" | "refused";

export type AuditInput = {
  tool: string;
  args?: unknown;
  status?: AuditStatus;
  detail?: string;
  /** Unix ms. Injectable so a test can pin the timestamp. */
  at?: number;
};

/** Enough of a value to reconstruct what happened, bounded so one call cannot
 *  dominate a day of log. */
const MAX_FIELD = 2000;

export function summarize(value: unknown): string {
  let text: string;
  try {
    if (typeof value === "string") {
      text = value;
    } else {
      text = JSON.stringify(value ?? null) ?? String(value);
    }
  } catch {
    text = "[unserializable]";
  }
  const redacted = redactSensitive(text);
  return redacted.length > MAX_FIELD
    ? `${redacted.slice(0, MAX_FIELD)}...`
    : redacted;
}

/** The wall's own wording, so a refusal is recognizable wherever it surfaces. */
export function isRefusal(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.includes("Refused:");
}

/**
 * A refusal is worth telling apart from a failure: the wall said no, the tool did
 * not break. Conservative about what counts as an error, because a false "error"
 * on a successful call makes the log worse than useless.
 */
export function statusOfResult(result: unknown): AuditStatus {
  const error = errorOf(result);
  if (!error) return "ok";
  return error.includes("Refused:") ? "refused" : "error";
}

export function detailOfResult(result: unknown): string | undefined {
  return errorOf(result) ?? undefined;
}

function errorOf(result: unknown): string | null {
  if (result && typeof result === "object" && "error" in result) {
    const value = (result as { error?: unknown }).error;
    if (typeof value === "string" && value.trim()) return value;
  }
  if (typeof result === "string" && result.startsWith("Refused:"))
    return result;
  return null;
}

export function buildAuditEntry(
  input: AuditInput,
  now = Date.now(),
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    at: input.at ?? now,
    tool: input.tool,
    status: input.status ?? "ok",
    args: summarize(input.args),
  };
  if (input.detail) entry.detail = summarize(input.detail);
  return entry;
}

/**
 * The day part of the file name. The host crate carries no calendar dependency,
 * so it is derived here and validated there: anything that is not `YYYY-MM-DD`
 * falls back to one shared file rather than steering the write.
 */
export function isoDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Fire-and-forget by design: the caller is a tool wrapper on the hot path. */
export function auditToolEvent(input: AuditInput): void {
  void appendEntry(buildAuditEntry(input));
}

async function appendEntry(entry: Record<string, unknown>): Promise<void> {
  try {
    await native.auditAppend(entry, isoDate(Number(entry.at)));
  } catch {
    // Observation, not enforcement.
  }
}
