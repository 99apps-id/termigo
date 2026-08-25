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
  if (!output || !output.trim()) {
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
      if (!isNaN(num)) lineNums.add(num);
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
