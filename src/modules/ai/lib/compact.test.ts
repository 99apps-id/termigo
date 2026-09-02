import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { compactModelMessages, compactModelMessagesDetailed } from "./compact";

const BIG = "x".repeat(2000);

function readCall(id: string, path: string): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: id,
        toolName: "read_file",
        input: { path },
      },
    ],
  } as unknown as ModelMessage;
}

function readResult(id: string, value: string): ModelMessage {
  return {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: id, output: { type: "text", value } },
    ],
  } as unknown as ModelMessage;
}

function writeCall(id: string, path: string): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: id,
        toolName: "write_file",
        input: { path },
      },
    ],
  } as unknown as ModelMessage;
}

function writeCallWithContent(id: string, path: string, content: string) {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: id,
        toolName: "write_file",
        input: { path, content },
      },
    ],
  } as unknown as ModelMessage;
}

function outputOf(message: ModelMessage): { __elided?: boolean } {
  const parts = message.content as Array<{ output?: { __elided?: boolean } }>;
  return parts[0].output ?? {};
}

function isElided(message: ModelMessage): boolean {
  return outputOf(message).__elided === true;
}

describe("compactModelMessagesDetailed", () => {
  it("returns the input untouched when it fits the context budget", () => {
    const messages = [{ role: "user", content: "hi" }] as ModelMessage[];
    const result = compactModelMessagesDetailed(messages, 1000);
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("elides a read result once its file has been written", () => {
    const messages = [
      readCall("c1", "/a.txt"),
      readResult("c1", BIG),
      writeCall("c2", "/a.txt"),
      { role: "user", content: BIG } as ModelMessage,
    ];
    const result = compactModelMessagesDetailed(messages, 1000);
    expect(result.compacted).toBe(true);
    expect(isElided(result.messages[1])).toBe(true);
  });

  it("keeps the latest read of a path and elides the superseded one", () => {
    const messages = [
      readCall("c1", "/a.txt"),
      readResult("c1", BIG),
      readCall("c2", "/a.txt"),
      readResult("c2", BIG),
      { role: "user", content: BIG } as ModelMessage,
    ];
    const result = compactModelMessagesDetailed(messages, 1000);
    expect(isElided(result.messages[1])).toBe(true);
    expect(isElided(result.messages[3])).toBe(false);
  });

  it("does not elide superseded reads while under the budget", () => {
    const messages = [
      readCall("c1", "/a.txt"),
      readResult("c1", "tiny"),
      readCall("c2", "/a.txt"),
      readResult("c2", "tiny"),
    ];
    const result = compactModelMessagesDetailed(messages, 100_000);
    expect(result.compacted).toBe(false);
    expect(isElided(result.messages[1])).toBe(false);
  });

  it("is idempotent: re-running does not re-elide an already-elided result", () => {
    const messages = [
      readCall("c1", "/a.txt"),
      readResult("c1", BIG),
      writeCall("c2", "/a.txt"),
      { role: "user", content: BIG } as ModelMessage,
    ];
    const once = compactModelMessagesDetailed(messages, 1000);
    const twice = compactModelMessagesDetailed(once.messages, 1000);
    expect(twice.compacted).toBe(false);
    expect(isElided(twice.messages[1])).toBe(true);
  });
});

describe("compactModelMessagesDetailed hard cap", () => {
  // A crude estimate mirroring the module's chars/3.5.
  const estTokens = (msgs: ModelMessage[]) => {
    let chars = 0;
    for (const m of msgs) {
      if (typeof m.content === "string") chars += m.content.length;
      else if (Array.isArray(m.content)) {
        for (const p of m.content as Array<{
          type: string;
          output?: unknown;
        }>) {
          chars += JSON.stringify(p.output ?? "").length + 32;
        }
      }
    }
    return chars / 3.5;
  };

  it("trims a huge tail down to fit the budget", () => {
    // 40 turns of big tool output — the bulk sits in the last 24 (the tail the
    // normal passes protect), so only the final hard cap can bring it under.
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push(readCall(`c${i}`, `/f${i}.txt`));
      messages.push(readResult(`c${i}`, "y".repeat(3000)));
    }
    const limit = 20_000;
    const before = estTokens(messages);
    const result = compactModelMessagesDetailed(messages, limit);
    expect(before).toBeGreaterThan(limit); // precondition: it overflowed
    expect(result.compacted).toBe(true);
    // After compaction the estimate must be under the window.
    expect(estTokens(result.messages)).toBeLessThan(limit);
  });
});

describe("compactModelMessagesDetailed floor", () => {
  const estTokens = (msgs: ModelMessage[]) => {
    let chars = 0;
    for (const m of msgs) {
      if (typeof m.content === "string") chars += m.content.length;
      else if (Array.isArray(m.content)) {
        for (const p of m.content as Array<{
          type: string;
          output?: unknown;
        }>) {
          chars += JSON.stringify(p.output ?? "").length + 32;
        }
      }
    }
    return chars / 3.5;
  };

  // The unbreakable-loop case: a single tool result larger than the whole
  // window sits in the KEEP_MIN_TAIL the hard cap protects. Without the floor
  // pass no budget reduction can make it fit, so every overflow retry fails.
  it("trims a single giant tool result in the protected tail", () => {
    const messages: ModelMessage[] = [
      readCall("c0", "/big.txt"),
      readResult("c0", "z".repeat(80_000)),
    ];
    const limit = 10_000;
    expect(estTokens(messages)).toBeGreaterThan(limit);
    const result = compactModelMessagesDetailed(messages, limit);
    expect(result.compacted).toBe(true);
    expect(estTokens(result.messages)).toBeLessThan(limit);
  });

  // A huge string-content message (a giant paste) is invisible to the
  // array-only passes; the floor must still bring it under the window.
  it("truncates a huge string-content message", () => {
    const messages = [
      { role: "user", content: "q".repeat(80_000) },
    ] as ModelMessage[];
    const limit = 10_000;
    const result = compactModelMessagesDetailed(messages, limit);
    expect(result.compacted).toBe(true);
    expect(estTokens(result.messages)).toBeLessThan(limit);
  });
});

describe("compactModelMessagesDetailed tool-call inputs", () => {
  // A build transcript (an app scaffold: many write_file calls) is dominated by
  // the file bodies carried in the CALL input, not the results. Eliding the
  // result alone leaves the whole body on the wire — which is how a "compacted"
  // request still arrived over the provider's body-size cap (HTTP 413).
  it("shrinks a superseded write_file's content input, keeping its shape", () => {
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(
        writeCallWithContent(`c${i}`, `/f${i}.txt`, "w".repeat(4000)),
      );
      messages.push(readResult(`r${i}`, "ok"));
    }
    messages.push({ role: "user", content: "done?" } as ModelMessage);
    const limit = 20_000;
    const result = compactModelMessagesDetailed(messages, limit);
    expect(result.compacted).toBe(true);
    // A pre-tail call must have had its content truncated...
    const firstCall = (
      result.messages[0].content as Array<{
        input?: { content?: string; path?: string };
        type: string;
      }>
    )[0];
    expect(firstCall.type).toBe("tool-call");
    expect(firstCall.input?.path).toBe("/f0.txt"); // keys survive
    expect((firstCall.input?.content ?? "").length).toBeLessThan(1000);
    // ...and the whole transcript must fit the budget.
    const est = (msgs: ModelMessage[]) => {
      let chars = 0;
      for (const m of msgs) {
        if (typeof m.content === "string") chars += m.content.length;
        else if (Array.isArray(m.content))
          for (const p of m.content as Array<Record<string, unknown>>)
            chars += JSON.stringify(p.input ?? p.output ?? "").length + 32;
      }
      return chars / 2.6;
    };
    expect(est(result.messages)).toBeLessThan(limit);
  });

  it("keeps the newest tool-call inputs in the tail intact", () => {
    const messages: ModelMessage[] = [
      writeCallWithContent("c0", "/old.txt", "w".repeat(20_000)),
      readResult("r0", "ok"),
      { role: "user", content: "now write another" } as ModelMessage,
      writeCallWithContent("c1", "/new.txt", "v".repeat(20_000)),
    ];
    const limit = 20_000;
    const result = compactModelMessagesDetailed(messages, limit);
    const untouched = (
      result.messages[3].content as Array<{
        input?: { content?: string };
      }>
    )[0].input?.content;
    expect(untouched).toBe("v".repeat(20_000));
  });
});

describe("compactModelMessagesDetailed performance", () => {
  // Regression: the passes used to re-measure the WHOLE transcript
  // (JSON.stringify over every message) inside each trim step's break check —
  // O(N^2). A 959-message session froze the app for eight minutes between
  // "runAgentStream: enter" and the model call. Sizes are now measured once
  // per message and updated by delta, so a large transcript compacts in ms.
  it("compacts a 1000-message transcript quickly", () => {
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 500; i++) {
      messages.push(readCall(`c${i}`, `/f${i}.txt`));
      messages.push(readResult(`c${i}`, "z".repeat(1500)));
    }
    const limit = 40_000;
    const t0 = performance.now();
    const result = compactModelMessagesDetailed(messages, limit, 12_000);
    const elapsed = performance.now() - t0;
    expect(result.compacted).toBe(true);
    // Generous ceiling: the quadratic version needed minutes here; the linear
    // one lands well under a second even on a slow CI.
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("compactModelMessagesDetailed body-size cap", () => {
  // A provider gateway can cap the HTTP BODY independently of the token
  // window (413 "Request body size exceeds maximum allowed size"). A build
  // transcript of big write_file payloads fit the token estimate and still
  // crossed the wire cap, so the compactor now enforces a byte ceiling too.
  it("shrinks a transcript that fits the token budget but not the body cap", () => {
    const messages: ModelMessage[] = [];
    // ~2 MB of tool results — under any real token budget's eye at a huge
    // limit, but over the 1.2 MB body ceiling.
    for (let i = 0; i < 100; i++) {
      messages.push(readCall(`c${i}`, `/f${i}.txt`));
      messages.push(readResult(`c${i}`, "b".repeat(20_000)));
    }
    const result = compactModelMessagesDetailed(messages, 10_000_000);
    expect(result.compacted).toBe(true);
    let bytes = 0;
    for (const m of result.messages) {
      for (const p of m.content as Array<Record<string, unknown>>) {
        bytes += JSON.stringify(p.input ?? p.output ?? "").length;
      }
    }
    expect(bytes).toBeLessThan(1_200_000);
  });

  // The standing per-call cap: an oversized write_file body is truncated on
  // EVERY request, even a small transcript well inside its budget — this is
  // the payload a gateway 413s, and waiting for the budget to trip is too
  // late. The newest message stays intact so work in progress is safe.
  it("caps oversized tool-call inputs even when the transcript fits", () => {
    const messages: ModelMessage[] = [
      writeCallWithContent("c0", "/big.txt", "w".repeat(100_000)),
      readResult("r0", "ok"),
      { role: "user", content: "next" } as ModelMessage,
    ];
    const result = compactModelMessagesDetailed(messages, 1_000_000);
    const input = (
      result.messages[0].content as Array<{
        input?: { content?: string; path?: string };
      }>
    )[0].input;
    expect((input?.content ?? "").length).toBeLessThan(70_000);
    expect(input?.path).toBe("/big.txt");
  });
});

describe("compactModelMessages", () => {
  it("returns the messages array from the detailed result", () => {
    const messages = [{ role: "user", content: "hi" }] as ModelMessage[];
    expect(compactModelMessages(messages, 1000)).toBe(messages);
  });
});
