/**
 * Frontend half of the PTY output credit.
 *
 * Counts the bytes handed to the terminal so the bridge can tell the backend
 * how much of its in-flight window to release. The backend stops sending once
 * `MAX_IN_FLIGHT_CHUNKS` chunks are unacknowledged, so this mark has to advance
 * as the terminal actually consumes output: that is what stops a backed-up
 * renderer from letting the backend run ahead of it.
 */
export class PtyOutputReceiver {
  private total = 0;

  /** Cumulative bytes handed to the terminal so far. */
  get bytesConsumed(): number {
    return this.total;
  }

  /** Record `bytes` delivered to the terminal. */
  consume(bytes: number): void {
    if (bytes > 0) this.total += bytes;
  }
}
