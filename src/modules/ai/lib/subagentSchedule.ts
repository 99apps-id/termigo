/**
 * Planning and readiness for a batch of subagents.
 *
 * Kept apart from the tool that runs them, and free of any import, because
 * this is the half that can go quietly wrong: a dependency cycle that never
 * settles hangs the run forever, and a task whose dependency failed must not
 * start with a hole where its context should be.
 *
 * Nothing here spawns anything. It answers two questions - which tasks can
 * never run, and which can run now - and leaves execution to the caller.
 */

/** Only the field the schedule cares about. */
export type ScheduledTask = {
  /** 0-based indices of other tasks this one waits for. */
  depends_on?: readonly number[];
};

export type PlanProblem = {
  index: number;
  reason: string;
};

export type BatchPlan = {
  /** Cleaned dependency lists, one per task, in input order. */
  deps: number[][];
  /** Tasks that can never run, and why. Reported, never silently dropped. */
  unrunnable: PlanProblem[];
  /**
   * Edges pointing at a task that does not exist. The task still runs, but
   * without that context - so the caller has to say so rather than let the
   * model trust a summary it never received.
   */
  droppedEdges: { index: number; target: number }[];
};

/**
 * Validate a batch before anything starts.
 *
 * Self-references and cycles are rejected rather than run: a task waiting on
 * itself, directly or through a ring, is never ready, and a scheduler that
 * simply waits for readiness would spin on it until the process died.
 */
export function planSubagentBatch(tasks: readonly ScheduledTask[]): BatchPlan {
  const deps: number[][] = [];
  const unrunnable: PlanProblem[] = [];
  const droppedEdges: { index: number; target: number }[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const raw = tasks[i].depends_on ?? [];
    const cleaned: number[] = [];
    for (const d of raw) {
      if (!Number.isInteger(d)) continue;
      if (d === i) {
        unrunnable.push({ index: i, reason: "depends on itself" });
        continue;
      }
      if (d < 0 || d >= tasks.length) {
        // Out of range rather than fatal: the task can still do its own work,
        // and saying the edge was ignored is more useful than refusing.
        droppedEdges.push({ index: i, target: d });
        continue;
      }
      if (!cleaned.includes(d)) cleaned.push(d);
    }
    deps.push(cleaned);
  }

  for (const i of findCycles(deps)) {
    unrunnable.push({ index: i, reason: "cycle in dependencies" });
  }

  return { deps, unrunnable, droppedEdges };
}

/**
 * Indices that sit on a dependency cycle.
 *
 * Depth-first, marking a node as finished on the way out. Without that, a node
 * still on the stack from an earlier branch is mistaken for a cycle when a
 * later sibling reaches it - which reports tasks as unrunnable that were only
 * shared.
 */
function findCycles(deps: readonly number[][]): number[] {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Array<number>(deps.length).fill(WHITE);
  const onCycle = new Set<number>();

  const walk = (node: number, stack: number[]): void => {
    colour[node] = GREY;
    stack.push(node);
    for (const next of deps[node]) {
      if (colour[next] === GREY) {
        // Everything from `next` to the top of the stack is in the ring.
        const from = stack.indexOf(next);
        for (let k = from; k < stack.length; k++) onCycle.add(stack[k]);
        continue;
      }
      if (colour[next] === WHITE) walk(next, stack);
    }
    stack.pop();
    colour[node] = BLACK;
  };

  for (let i = 0; i < deps.length; i++) {
    if (colour[i] === WHITE) walk(i, []);
  }
  return [...onCycle].sort((a, b) => a - b);
}

export type TaskState = {
  /** Finished, one way or another. */
  settled: boolean;
  /** Settled without a usable summary: failed, skipped, or never ran. */
  bad: boolean;
  /** Currently executing. */
  running: boolean;
};

/**
 * Which tasks may start right now, capped by the free concurrency slots.
 *
 * A task is ready when every dependency has settled successfully. One that
 * depends on a failure is not ready and never will be - `cascadeSkip` is what
 * settles those, and without it the caller waits on a task that can never
 * become ready.
 */
export function readyTasks(
  deps: readonly number[][],
  state: readonly TaskState[],
  freeSlots: number,
): number[] {
  if (freeSlots <= 0) return [];
  const ready: number[] = [];
  for (let i = 0; i < deps.length && ready.length < freeSlots; i++) {
    const s = state[i];
    if (s.settled || s.running) continue;
    if (deps[i].some((d) => !state[d].settled || state[d].bad)) continue;
    ready.push(i);
  }
  return ready;
}

/**
 * Settle everything downstream of a task that did not succeed.
 *
 * Transitive on purpose. A task depending on a task depending on a failure is
 * just as stuck as the first one, and leaving it unsettled is how a batch
 * stops making progress without ever finishing.
 */
export function cascadeSkip(
  deps: readonly number[][],
  state: TaskState[],
  failedIndex: number,
): { index: number; reason: string }[] {
  const skipped: { index: number; reason: string }[] = [];
  const queue = [failedIndex];

  while (queue.length > 0) {
    const source = queue.shift() as number;
    for (let i = 0; i < deps.length; i++) {
      if (state[i].settled || !deps[i].includes(source)) continue;
      state[i].settled = true;
      state[i].bad = true;
      state[i].running = false;
      skipped.push({
        index: i,
        reason: `dependency #${source} did not succeed`,
      });
      queue.push(i);
    }
  }
  return skipped;
}

/** Only the fields the conflict detector reads from a task. */
export type ConflictTask = {
  /** The file paths the task's prompt mentions, if any. */
  paths?: readonly string[];
};

/** A pair of batch tasks that both mention the same file path. */
export type PathConflict = {
  indexA: number;
  indexB: number;
  path: string;
};

/**
 * Heuristically pull file paths out of a task prompt.
 *
 * Matches `src/...`, `lib/...`, `packages/...`, bare `*.ts` / `*.rs` / `*.py`
 * tokens and quoted paths. Purely lexical — no filesystem access — so the
 * detector stays pure and testable, and a miss only means the conflict is not
 * reported, never that a false one is.
 */
export function pathsInPrompt(prompt: string): string[] {
  const text = String(prompt ?? "");
  const out = new Set<string>();
  const patterns = [
    // Path-like: src/foo.ts, ./lib/x, packages/a/b
    /\b(?:[A-Za-z0-9_@./-]+\.(?:tsx?|jsx?|rs|py|go|css|scss|json|html|md|vue|svelte))\b/g,
    // Directory-ish tokens that often mean a whole folder
    /\b(?:src|lib|packages|apps|components|hooks|utils|api|tests?|__tests__)\b(?:\/[A-Za-z0-9_.-]+)?/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const v = m[0].trim();
      if (v.length >= 2 && v.length <= 200) out.add(v);
    }
  }
  return [...out];
}

/**
 * Find tasks in a batch that both mention the same file path.
 *
 * Two subagents editing the same file concurrently is the batch's version of a
 * merge conflict: each sees the other's starting point, both write, the second
 * overwrites the first, and nobody notices until review. Detecting the overlap
 * up front lets the caller warn (or serialize via depends_on) instead of
 * discovering it after the fact. Runs before anything spawns.
 */
export function detectBatchConflicts(
  tasks: readonly ConflictTask[],
): PathConflict[] {
  const byPath = new Map<string, number[]>();
  tasks.forEach((t, i) => {
    for (const p of t.paths ?? []) {
      const key = p.replace(/^\.\//, "").replace(/[\\/]+$/, "");
      if (!key) continue;
      const list = byPath.get(key) ?? [];
      if (!list.includes(i)) list.push(i);
      byPath.set(key, list);
    }
  });
  const out: PathConflict[] = [];
  for (const [path, indices] of byPath) {
    if (indices.length < 2) continue;
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        out.push({ indexA: indices[a], indexB: indices[b], path });
      }
    }
  }
  // Stable order by first index, then second, then path.
  out.sort(
    (x, y) =>
      x.indexA - y.indexA ||
      x.indexB - y.indexB ||
      x.path.localeCompare(y.path),
  );
  return out;
}
