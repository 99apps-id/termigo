const CHUNK_BUDGET = 2;
const BUFFER_BUDGET = 2 * 1024 * 1024;

export interface PtyOutputCredit {
  readonly bytesSent: number;
  readonly bytesAcknowledged: number;
  readonly inFlightChunks: number;
  readonly inFlightBytes: number;
  readonly canSend: boolean;
  recordSent(bytes: number): void;
  acknowledge(bytes: number): void;
}

export class PtyOutputReceiver implements PtyOutputCredit {
  private chunks: number[] = [];
  private sent = 0;
  private acknowledged = 0;

  get bytesSent(): number {
    return this.sent;
  }
  get bytesAcknowledged(): number {
    return this.acknowledged;
  }
  get inFlightChunks(): number {
    return this.chunks.length;
  }
  get inFlightBytes(): number {
    return this.sent - this.acknowledged;
  }
  get canSend(): boolean {
    return this.chunks.length < CHUNK_BUDGET;
  }

  recordSent(bytes: number): void {
    if (bytes <= 0)
      throw new Error(`pty_ack_output: invalid recordSent bytes=${bytes}`);
    if (!this.canSend)
      throw new Error(`pty_ack_output: back-pressure window exhausted`);
    if (this.sent - this.acknowledged + bytes > BUFFER_BUDGET) {
      throw new Error("pty_ack_output: buffered bytes exceed budget");
    }
    this.sent += bytes;
    this.chunks.push(this.sent);
  }

  acknowledge(bytes: number): void {
    if (bytes <= this.acknowledged) return;
    const index = this.chunks.findIndex((chunk) => chunk === bytes);
    if (index < 0) throw new Error("pty_ack_output: invalid output boundary");
    this.chunks.splice(0, index + 1);
    this.acknowledged = bytes;
  }
}

export class PtyOutputReceiverMock implements PtyOutputCredit {
  private _sent = 0;
  private _acknowledged = 0;
  private _chunks: number[] = [];

  get bytesSent(): number {
    return this._sent;
  }
  get bytesAcknowledged(): number {
    return this._acknowledged;
  }
  get inFlightChunks(): number {
    return this._chunks.length;
  }
  get inFlightBytes(): number {
    return this._sent - this._acknowledged;
  }
  get canSend(): boolean {
    return this._chunks.length < CHUNK_BUDGET;
  }

  recordSent(bytes: number): void {
    if (bytes <= 0)
      throw new Error(`pty_ack_output: invalid recordSent bytes=${bytes}`);
    if (!this.canSend)
      throw new Error("pty_ack_output: back-pressure window exhausted");
    if (this._sent - this._acknowledged + bytes > BUFFER_BUDGET) {
      throw new Error("pty_ack_output: buffered bytes exceed budget");
    }
    this._sent += bytes;
    this._chunks.push(this._sent);
  }

  acknowledge(bytes: number): void {
    if (bytes <= this._acknowledged) return;
    const index = this._chunks.findIndex((chunk) => chunk === bytes);
    if (index < 0) throw new Error("pty_ack_output: invalid output boundary");
    this._chunks.splice(0, index + 1);
    this._acknowledged = bytes;
  }

  mockFlush(bytes: number): void {
    this.acknowledge(bytes);
  }
}
