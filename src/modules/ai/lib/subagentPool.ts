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
      return () => {
        if (!released) {
          released = true;
          this.active--;
          this.dequeue();
        }
      };
    }

    return new Promise<() => void>((resolve, reject) => {
      let aborted = false;

      const run = () => {
        if (aborted) return;
        signal?.removeEventListener("abort", onAbort);
        let released = false;
        resolve(() => {
          if (!released) {
            released = true;
            this.active--;
            this.dequeue();
          }
        });
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
        this.active++;
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
