/**
 * Terminal Transcript Capture & Deterministic Replay Harness
 *
 * Inspired by Orca's PTY transcript capture harness:
 * Captures live terminal streams with raw ANSI escapes, scrubs sensitive credentials,
 * and allows deterministic replay for regression testing of CLI spinners,
 * output parsers, and prompt readiness scanners without spawning child processes.
 */

export interface TranscriptFrame {
  offsetMs: number;
  data: string;
}

export interface TerminalTranscript {
  id: string;
  command?: string;
  recordedAt: number;
  totalDurationMs: number;
  frames: TranscriptFrame[];
}

const SENSITIVE_PATTERNS = [
  /ghp_[a-zA-Z0-9]{36}/g,
  /sk-ant-[a-zA-Z0-9_\-]{40,}/g,
  /sk-[a-zA-Z0-9]{40,}/g,
  /Bearer\s+[a-zA-Z0-9_\-\.]{20,}/gi,
  /password\s*[:=]\s*[^\s]+/gi,
];

/**
 * Scrubs API keys, passwords, and authorization tokens from terminal output.
 */
export function scrubSensitiveOutput(raw: string): string {
  let cleaned = raw;
  for (const pattern of SENSITIVE_PATTERNS) {
    cleaned = cleaned.replace(pattern, "[REDACTED_SECRET]");
  }
  return cleaned;
}

export class TranscriptRecorder {
  private startTime: number;
  private frames: TranscriptFrame[] = [];
  private command?: string;

  constructor(command?: string) {
    this.command = command;
    this.startTime = Date.now();
  }

  /**
   * Append raw output received from the terminal or PTY.
   */
  public recordChunk(data: string, timestamp = Date.now()): void {
    const offsetMs = Math.max(0, timestamp - this.startTime);
    const scrubbed = scrubSensitiveOutput(data);
    this.frames.push({ offsetMs, data: scrubbed });
  }

  /**
   * Completes the recording and serializes the transcript.
   */
  public finish(endTime = Date.now()): TerminalTranscript {
    const totalDurationMs = Math.max(0, endTime - this.startTime);
    return {
      id: `transcript-${Math.random().toString(36).slice(2, 9)}`,
      command: this.command,
      recordedAt: this.startTime,
      totalDurationMs,
      frames: [...this.frames],
    };
  }
}

/**
 * Deterministically replays a recorded terminal transcript through an output handler.
 * If instant = true, emits all frames synchronously without sleeping.
 */
export async function replayTranscript(
  transcript: TerminalTranscript,
  onChunk: (data: string, frameIndex: number) => void | Promise<void>,
  opts: { instant?: boolean; timeScale?: number } = {}
): Promise<void> {
  const instant = opts.instant ?? true;
  const scale = opts.timeScale ?? 1.0;

  let lastOffset = 0;
  for (let i = 0; i < transcript.frames.length; i++) {
    const frame = transcript.frames[i];
    if (!instant) {
      const waitMs = Math.max(0, (frame.offsetMs - lastOffset) / scale);
      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs));
      }
      lastOffset = frame.offsetMs;
    }
    await onChunk(frame.data, i);
  }
}

/**
 * Utility to extract plain text without ANSI escape sequences.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}
