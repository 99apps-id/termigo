import { describe, expect, it } from "vitest";
import { traceEager } from "../../scripts/eager-graph.mjs";

// Locks the startup-bundle invariant: the heavy editor / AI / markdown stacks
// must stay out of the eager graph of both window entries so they load only
// when the user opens those surfaces. A static import that re-introduces any of
// these (e.g. a barrel re-export of chat runtime, or a `cn`-style util getting
// absorbed into a feature chunk) will fail here. xterm and motion are
// intentionally eager (terminal-first shell) and are not asserted against.
const HEAVY = ["@ai-sdk", "ai", "streamdown", "@codemirror", "@uiw"];

function heavyEagerHits(entry: string): string[] {
  const { hits } = traceEager(entry, HEAVY);
  return [...hits.entries()].map(([pkg, info]) => `${pkg} <- ${info.file}`);
}

describe("startup bundle budget", () => {
  // These trace the WHOLE eager import graph, which is synchronous file I/O over
  // ~900 files. That is ~0.7s idle but well past the 5s default when the rest of
  // the suite runs in parallel on a loaded machine - it timed out at 8s in a full
  // run and passed on every isolated run, turning a correct assertion into an
  // intermittent red. The budget is the assertion; the timeout was just too tight.
  const TRACE_TIMEOUT_MS = 30_000;

  it("main window does not eagerly pull editor/AI/markdown stacks", () => {
    expect(heavyEagerHits("src/main.tsx")).toEqual([]);
  }, TRACE_TIMEOUT_MS);

  it("settings window does not eagerly pull editor/AI/markdown stacks", () => {
    expect(heavyEagerHits("src/settings/main.tsx")).toEqual([]);
  }, TRACE_TIMEOUT_MS);
});
