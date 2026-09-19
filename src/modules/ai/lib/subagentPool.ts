/**
 * Global concurrency limiter for subagent model runs.
 */

export const MAX_GLOBAL_SUBAGENTS = 4;

export class SubagentConcurrencyPool {
  private active = 0;
  private readonly maxConcurrent: number;
  private readonly queue: Array<() => void> = [];

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

    if (this.active < this.maxConcurrent) {
      this.active++;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          this.active--;
          this.dequeue();
        }
      };
      return release;
    }

    return new Promise<() => void>((resolve, reject) => {
      let aborted = false;
      let released = false;
      let release: (() => void) | null = null;

      const run = () => {
        if (aborted) return;
        signal?.removeEventListener("abort", onAbort);
        this.active++;
        release = () => {
          if (!released) {
            released = true;
            this.active--;
            this.dequeue();
          }
        };
        resolve(release);
      };

      const onAbort = () => {
        aborted = true;
        const idx = this.queue.indexOf(run);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }
        reject(new Error("Aborted waiting for subagent slot"));
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(run);
    });
  }

  private dequeue(): void {
    if (this.active < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        // No increment here: the waiter counts its own slot in `run()`.
        // Incrementing in both places double-counts every queued grant,
        // halving the effective pool and letting `active` exceed the max.
        next();
      }
    }
  }

  reset(): void {
    this.active = 0;
    this.queue.length = 0;
  }
}

export const globalSubagentPool = new SubagentConcurrencyPool();
