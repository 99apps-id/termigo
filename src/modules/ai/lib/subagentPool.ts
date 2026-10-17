/**
 * Global concurrency limiter for subagent model runs.
 */

export const MAX_GLOBAL_SUBAGENTS = 4;

export class SubagentConcurrencyPool {
  private active = 0;
  private generation = 0;
  private readonly maxConcurrent: number;
  private readonly queue: Array<{
    run: () => void;
    cancel: () => void;
  }> = [];

  constructor(maxConcurrent = MAX_GLOBAL_SUBAGENTS) {
    this.maxConcurrent = maxConcurrent;
  }

  get activeCount(): number {
    return this.active;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new Error("Aborted before acquiring subagent slot");
    }

    const gen = this.generation;
    if (this.active < this.maxConcurrent) {
      this.active++;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          if (this.generation === gen && this.active > 0) {
            this.active--;
            this.dequeue();
          }
        }
      };
      return release;
    }

    return new Promise<() => void>((resolve, reject) => {
      let aborted = false;
      let released = false;

      const run = () => {
        if (aborted) {
          this.dequeue();
          return;
        }
        signal?.removeEventListener("abort", onAbort);
        const runGen = this.generation;
        this.active++;
        const release = () => {
          if (!released) {
            released = true;
            if (this.generation === runGen && this.active > 0) {
              this.active--;
              this.dequeue();
            }
          }
        };
        resolve(release);
      };

      const cancel = () => {
        if (aborted) return;
        aborted = true;
        signal?.removeEventListener("abort", onAbort);
        reject(new Error("Aborted waiting for subagent slot"));
      };

      const entry = { run, cancel };

      const onAbort = () => {
        aborted = true;
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }
        reject(new Error("Aborted waiting for subagent slot"));
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  private dequeue(): void {
    if (this.active < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        // No increment here: the waiter counts its own slot in `run()`.
        // Incrementing in both places double-counts every queued grant,
        // halving the effective pool and letting `active` exceed the max.
        next.run();
      }
    }
  }

  reset(): void {
    this.generation++;
    this.active = 0;
    const pending = this.queue.splice(0, this.queue.length);
    for (const item of pending) {
      item.cancel();
    }
  }
}

export const globalSubagentPool = new SubagentConcurrencyPool();
