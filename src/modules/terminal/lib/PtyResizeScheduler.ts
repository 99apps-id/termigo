const RESIZE_DEBOUNCE_MS = 16;

export class PtyResizeScheduler {
  private pending = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly resize: (cols: number, rows: number) => void) {}

  schedule(cols: number, rows: number): void {
    if (this.pending) {
      // `timer` is nullable, so it needs the same guard `cancel()` uses.
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.pending = false;
        this.resize(cols, rows);
      }, RESIZE_DEBOUNCE_MS);
      return;
    }
    this.pending = true;
    this.timer = setTimeout(() => {
      this.pending = false;
      this.resize(cols, rows);
    }, RESIZE_DEBOUNCE_MS);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.pending = false;
  }
}
