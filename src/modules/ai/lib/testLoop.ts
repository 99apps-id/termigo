/**
 * Autonomous Continuous Test-Fix Loop Helper
 *
 * Distills verbose compiler and test runner output to extract
 * actionable panic stack traces, type errors, and failing test assertions.
 */

export type ErrorSummary = {
  kind: "compile_error" | "test_failure" | "lint_error" | "runtime_error" | "unknown";
  conciseMessage: string;
  failingFiles: string[];
  lineNumbers: number[];
  distilledOutput: string;
};

/**
 * Distill raw test runner or compiler output into a concise error summary.
 * Filters out noise, success lines, and irrelevant log banners.
 */
export function distillTestOutput(output: string): ErrorSummary {
  if (!output?.trim()) {
    return {
      kind: "unknown",
      conciseMessage: "Command failed with empty output",
      failingFiles: [],
      lineNumbers: [],
      distilledOutput: "",
    };
  }

  const lines = output.split("\n");
  const failingLines: string[] = [];
  const files = new Set<string>();
  const lineNums = new Set<number>();

  let detectedKind: ErrorSummary["kind"] = "test_failure";

  // Regex patterns for TypeScript/Rust/Go/Python errors
  const fileLinePattern = /(?:^|[\s(])([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+):(\d+)(?::(\d+))?/;
  const errorIndicatorPattern = /(?:FAIL|FAILED|error\[E\d+\]|Error:|panic:|AssertionError|SyntaxError|TypeError)/i;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (errorIndicatorPattern.test(trimmed)) {
      failingLines.push(trimmed);
      if (trimmed.toLowerCase().includes("syntaxerror") || trimmed.includes("error[E")) {
        detectedKind = "compile_error";
      } else if (trimmed.toLowerCase().includes("lint")) {
        detectedKind = "lint_error";
      }
    }

    const match = trimmed.match(fileLinePattern);
    if (match) {
      files.add(match[1]);
      const num = parseInt(match[2], 10);
      if (!Number.isNaN(num)) lineNums.add(num);
      failingLines.push(trimmed);
    }
  }

  const conciseLines = failingLines.length > 0 ? failingLines.slice(0, 25) : lines.slice(-20);
  const distilledOutput = conciseLines.join("\n");

  return {
    kind: detectedKind,
    conciseMessage: conciseLines[0] || "Unknown test or build failure",
    failingFiles: Array.from(files),
    lineNumbers: Array.from(lineNums),
    distilledOutput,
  };
}

/**
 * Determine if a test run should be auto-retried based on error kind and retry limits.
 */
export function shouldRetryTest(opts: {
  attempt: number;
  maxRetries: number;
  exitCode: number;
}): boolean {
  if (opts.exitCode === 0) return false;
  return opts.attempt < opts.maxRetries;
}

/**
 * Build the retry guidance shown to the model after a focused test run, so the
 * test-fix loop is capped and the model is told when to stop instead of
 * re-running the same failing test forever.
 */
export function retryGuidance(opts: {
  attempt: number;
  maxRetries: number;
  exitCode: number;
}): { shouldRetry: boolean; guidance: string } {
  if (opts.exitCode === 0) {
    return { shouldRetry: false, guidance: "Tests passed. No retry needed." };
  }
  if (shouldRetryTest(opts)) {
    return {
      shouldRetry: true,
      guidance: `Attempt ${opts.attempt}/${opts.maxRetries}. Read distilled_error, fix the reported files, then call test_file again.`,
    };
  }
  return {
    shouldRetry: false,
    guidance: `Attempt ${opts.attempt}/${opts.maxRetries} reached the retry limit. Stop re-running the same test; summarize the remaining failure and ask the user how to proceed.`,
  };
}

/**
 * Track per-file test attempts so the fix->re-run loop is bounded. Keyed by an
 * opaque string (typically `sessionId:filePath`). A passing run resets the
 * counter for that key; a failing run increments it.
 */
export class TestAttemptTracker {
  private attempts = new Map<string, number>();

  constructor(private readonly maxRetries: number) {}

  /** Record a run and return the 1-based attempt number for this key. */
  record(key: string, exitCode: number): number {
    if (exitCode === 0) {
      this.attempts.set(key, 0);
      return 0;
    }
    const next = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, next);
    return next;
  }

  /** Current attempt count for a key without recording a new run. */
  peek(key: string): number {
    return this.attempts.get(key) ?? 0;
  }

  get max(): number {
    return this.maxRetries;
  }

  /** Forget all tracked attempts (e.g. when a chat session ends). */
  reset(): void {
    this.attempts.clear();
  }
}
