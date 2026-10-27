// Per-tool usage counters for MCP tools.
//
// The settings panel can already disable a noisy or dangerous tool; what it
// cannot do is say which tools deserve attention. These counters answer "used
// N times, failed M times" per server tool, which is the input for usage
// sorting and disable suggestions.
//
// In-memory only, by design: usage is operational telemetry, not user data,
// and persisting every call to disk would trade a settings-panel nicety for
// write churn on every agent run. A restart resets the counts.

export type McpUsageEntry = {
  server: string;
  tool: string;
  calls: number;
  errors: number;
  lastUsedAt: number;
};

const usage = new Map<string, McpUsageEntry>();

function key(server: string, tool: string): string {
  return `${server}__${tool}`;
}

/** Record one completed call. Never throws: telemetry must not break tools. */
export function recordMcpUsage(
  server: string,
  tool: string,
  ok: boolean,
  now = Date.now(),
): void {
  try {
    const k = key(server, tool);
    const prev = usage.get(k);
    usage.set(k, {
      server,
      tool,
      calls: (prev?.calls ?? 0) + 1,
      errors: (prev?.errors ?? 0) + (ok ? 0 : 1),
      lastUsedAt: now,
    });
  } catch {
    // Telemetry is best-effort by contract.
  }
}

/** Snapshot sorted by most-called first. */
export function getMcpUsage(): McpUsageEntry[] {
  return [...usage.values()].sort((a, b) => b.calls - a.calls);
}

/** Usage for one server, most-called first. Empty when never called. */
export function getMcpUsageForServer(server: string): McpUsageEntry[] {
  return getMcpUsage().filter((e) => e.server === server);
}

/** Reset all counters. For tests and for a fresh measurement window. */
export function clearMcpUsage(): void {
  usage.clear();
}
