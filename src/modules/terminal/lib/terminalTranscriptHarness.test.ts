import { describe, expect, it } from "vitest";
import {
  replayTranscript,
  scrubSensitiveOutput,
  stripAnsi,
  TranscriptRecorder,
} from "./terminalTranscriptHarness";

describe("terminalTranscriptHarness", () => {
  it("scrubs secrets such as api keys and bearer tokens", () => {
    const raw = "export ANTHROPIC_API_KEY=sk-ant-api03-1234567890abcdef1234567890abcdef12345678";
    const scrubbed = scrubSensitiveOutput(raw);
    expect(scrubbed).not.toContain("sk-ant-api03");
    expect(scrubbed).toContain("[REDACTED_SECRET]");

    const bearer = "Authorization: Bearer my-secret-jwt-token-value-here";
    expect(scrubSensitiveOutput(bearer)).toContain("[REDACTED_SECRET]");
  });

  it("records chunks into timestamped frames and strips ANSI correctly", () => {
    const recorder = new TranscriptRecorder("npm test");
    const t0 = 1000;

    recorder.recordChunk("\x1b[32mPASS\x1b[0m src/app.test.ts\n", t0);
    recorder.recordChunk("\x1b[33mWarning:\x1b[0m deprecated API\n", t0 + 50);

    const transcript = recorder.finish(t0 + 100);
    expect(transcript.command).toBe("npm test");
    expect(transcript.frames).toHaveLength(2);
    expect(transcript.frames[0].data).toContain("PASS");

    // Strips ANSI escape codes
    const plain = stripAnsi(transcript.frames[0].data);
    expect(plain).toBe("PASS src/app.test.ts\n");
  });

  it("deterministically replays transcript through callback", async () => {
    const recorder = new TranscriptRecorder();
    recorder.recordChunk("frame-1\n");
    recorder.recordChunk("frame-2\n");
    const transcript = recorder.finish();

    const emitted: string[] = [];
    await replayTranscript(transcript, (chunk) => {
      emitted.push(chunk);
    });

    expect(emitted).toEqual(["frame-1\n", "frame-2\n"]);
  });
});
