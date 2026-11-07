import { describe, expect, it } from "vitest";
import {
  buildContinuationNudge,
  CONTINUATION_NUDGE_PREFIX,
  continuationDecision,
  continuationOverlapLength,
  dedupeResumedSeams,
  EMPTY_REPLY_NUDGE,
  isContinuationNudgeParts,
  isTruncatedFinish,
  MAX_EMPTY_REPLY_CONTINUATIONS,
  MAX_PROMISED_ACTION_CONTINUATIONS,
  MAX_TRUNCATION_CONTINUATIONS,
  MIN_CONTINUATION_OVERLAP,
  newContinuationState,
  OUTPUT_LIMIT_NUDGE,
  PROMISED_ACTION_NUDGE,
  promisesNextAction,
  recordContinuation,
  trailingContinueIntent,
} from "./turnContinuation";

type Part = { type: string; text?: string };
type Msg = { role: string; parts: Part[] };

function assistant(text: string): Msg {
  return { role: "assistant", parts: [{ type: "text", text }] };
}
function user(text: string): Msg {
  return { role: "user", parts: [{ type: "text", text }] };
}
function nudge(text: string): Msg {
  return {
    role: "user",
    parts: [{ type: "text", text: `${CONTINUATION_NUDGE_PREFIX} ${text}` }],
  };
}

const SEAM =
  "The build failed because the module was not registered in the workspace.";

describe("promisesNextAction", () => {
  it("detects an announced next step at the tail", () => {
    for (const text of [
      "Next I'll inspect the exact security-relevant modules.",
      "I'm switching to targeted reads now. Next I'll read approval.rs.",
      "Saya lanjut audit repo ini dengan fokus ke bug berpotensi.",
      "Setelah itu saya lanjut ke area lain seperti path traversal.",
      "Let me check the approval module now.",
      "Mari saya periksa bagian canonicalization.",
    ]) {
      expect(promisesNextAction(text), text).toBe(true);
    }
  });

  it("does not mistake a finished answer for a promise", () => {
    for (const text of [
      "",
      "Done. The bug is in approval.rs:260 and the fix is applied.",
      "Laporan selesai: tidak ada masalah yang ditemukan.",
      "Let me know if you need anything else.",
      "The next step is documented in the README; the work is complete.",
    ]) {
      expect(promisesNextAction(text), text).toBe(false);
    }
  });

  it("ignores a very long answer", () => {
    expect(promisesNextAction(`${"x".repeat(3_000)} Next I'll read it.`)).toBe(
      false,
    );
  });
});

describe("isTruncatedFinish", () => {
  it("recognises the output-ceiling reasons", () => {
    expect(isTruncatedFinish("length")).toBe(true);
    expect(isTruncatedFinish("maxTokens")).toBe(true);
    expect(isTruncatedFinish("max_tokens")).toBe(true);
  });

  it("does not treat a normal or failed finish as truncation", () => {
    expect(isTruncatedFinish("stop")).toBe(false);
    expect(isTruncatedFinish("tool-calls")).toBe(false);
    expect(isTruncatedFinish("error")).toBe(false);
    expect(isTruncatedFinish(undefined)).toBe(false);
  });
});

describe("continuationDecision", () => {
  const base = {
    lastStepText: "",
    finishReason: "stop" as string | undefined,
    usedToolsThisRun: true,
    state: newContinuationState(),
  };

  it("asks to resume when the output budget cut the answer", () => {
    expect(
      continuationDecision({
        ...base,
        lastStepText: "half an answer",
        finishReason: "length",
      }),
    ).toBe("truncation");
  });

  // A cut can land inside reasoning, leaving no text. Reading that as an empty
  // reply would ask for a final answer instead of resuming the cut work.
  it("prefers truncation over empty-reply when the cut left no text", () => {
    expect(
      continuationDecision({
        ...base,
        lastStepText: "",
        finishReason: "length",
      }),
    ).toBe("truncation");
  });

  it("asks for the answer when a step produced only reasoning", () => {
    expect(continuationDecision(base)).toBe("empty-reply");
  });

  it("asks for the promised action when a step only announced it", () => {
    expect(
      continuationDecision({
        ...base,
        lastStepText: "Next I'll read approval.rs.",
      }),
    ).toBe("promised-action");
  });

  it("leaves a clean final answer alone", () => {
    expect(
      continuationDecision({ ...base, lastStepText: "All done, tests pass." }),
    ).toBeNull();
  });

  it("never nudges an error, a content filter, or a tool-calls stop", () => {
    for (const finishReason of ["error", "content-filter", "tool-calls"]) {
      expect(
        continuationDecision({ ...base, finishReason }),
        finishReason,
      ).toBeNull();
      expect(
        continuationDecision({
          ...base,
          lastStepText: "Next I'll read it.",
          finishReason,
        }),
        finishReason,
      ).toBeNull();
    }
  });

  it("bounds each kind so a stuck model cannot spin", () => {
    let state = newContinuationState();
    for (let i = 0; i < MAX_TRUNCATION_CONTINUATIONS; i++) {
      expect(continuationDecision({ ...base, finishReason: "length" })).toBe(
        "truncation",
      );
      state = recordContinuation(state, "truncation");
    }
    expect(
      continuationDecision({ ...base, state, finishReason: "length" }),
    ).toBeNull();

    let state2 = newContinuationState();
    for (let i = 0; i < MAX_EMPTY_REPLY_CONTINUATIONS; i++) {
      expect(continuationDecision({ ...base, state: state2 })).toBe(
        "empty-reply",
      );
      state2 = recordContinuation(state2, "empty-reply");
    }
    expect(continuationDecision({ ...base, state: state2 })).toBeNull();

    let state3 = newContinuationState();
    for (let i = 0; i < MAX_PROMISED_ACTION_CONTINUATIONS; i++) {
      expect(
        continuationDecision({
          ...base,
          state: state3,
          lastStepText: "Next I'll do it.",
        }),
      ).toBe("promised-action");
      state3 = recordContinuation(state3, "promised-action");
    }
    expect(
      continuationDecision({
        ...base,
        state: state3,
        lastStepText: "Next I'll do it.",
      }),
    ).toBeNull();
  });
});

describe("buildContinuationNudge", () => {
  it("prefixes every nudge so it can be told from a user task", () => {
    for (const kind of [
      "truncation",
      "empty-reply",
      "promised-action",
    ] as const) {
      const text = buildContinuationNudge(kind, "Next I'll read it.");
      expect(text.startsWith(CONTINUATION_NUDGE_PREFIX)).toBe(true);
      expect(isContinuationNudgeParts([{ type: "text", text }])).toBe(true);
    }
  });

  it("uses a distinct body per kind and quotes the announcement", () => {
    const trunc = buildContinuationNudge("truncation", "");
    expect(trunc).toContain(OUTPUT_LIMIT_NUDGE);
    expect(buildContinuationNudge("empty-reply", "")).toContain(
      EMPTY_REPLY_NUDGE,
    );
    const promised = buildContinuationNudge(
      "promised-action",
      "Next I'll read approval.rs.",
    );
    expect(promised).toContain(PROMISED_ACTION_NUDGE);
    expect(promised).toContain("Next I'll read approval.rs.");
  });

  it("clips a very long announcement", () => {
    const long = `Next I'll ${"x".repeat(2_000)}`;
    const promised = buildContinuationNudge("promised-action", long);
    expect(promised.length).toBeLessThan(long.length);
  });
});

describe("isContinuationNudgeParts", () => {
  it("recognises its own nudges only", () => {
    expect(
      isContinuationNudgeParts([
        { type: "text", text: `${CONTINUATION_NUDGE_PREFIX} x` },
      ]),
    ).toBe(true);
    expect(isContinuationNudgeParts([])).toBe(false);
    expect(isContinuationNudgeParts([{ type: "text", text: "hello" }])).toBe(
      false,
    );
    expect(
      isContinuationNudgeParts([
        { type: "text", text: `${CONTINUATION_NUDGE_PREFIX} x` },
        { type: "text", text: "more" },
      ]),
    ).toBe(false);
    expect(
      isContinuationNudgeParts([
        { type: "file", text: `${CONTINUATION_NUDGE_PREFIX} x` },
      ]),
    ).toBe(false);
    expect(isContinuationNudgeParts([{ type: "text" }])).toBe(false);
  });
});

describe("continuationOverlapLength", () => {
  it("is zero when the continuation does not repeat", () => {
    const previous =
      "The quick brown fox jumps over the lazy dog and keeps running.";
    const continuation =
      "A completely different sentence starts here without repetition.";
    expect(continuationOverlapLength(previous, continuation)).toBe(0);
  });

  it("detects the repeated seam", () => {
    const previous = `First paragraph. ${SEAM}`;
    const continuation = `${SEAM} So I fixed it.`;
    const overlap = continuationOverlapLength(previous, continuation);
    expect(overlap).toBeGreaterThanOrEqual(MIN_CONTINUATION_OVERLAP);
    expect(overlap).toBe(SEAM.length);
  });

  it("ignores tiny repeats", () => {
    expect(continuationOverlapLength("ok", "ok then, continue")).toBe(0);
  });

  it("handles multibyte text", () => {
    const seam =
      "proses build gagal karena modul belum terdaftar di workspace.";
    const previous = `Ringkasan: ${seam}`;
    const continuation = `${seam} Lalu saya perbaiki.`;
    const merged =
      previous +
      continuation.slice(continuationOverlapLength(previous, continuation));
    expect(merged.match(/modul belum terdaftar/g)).toHaveLength(1);
    expect(merged.endsWith("Lalu saya perbaiki.")).toBe(true);
  });

  it("refuses a boundary inside a surrogate pair", () => {
    const seam = "aaa😀bbbccc";
    const previous = `prefix ${seam}`;
    // Continuation starting mid-emoji: the boundary lands on a low surrogate.
    const lowIndex = previous.indexOf("\u{1f600}") + 1;
    const continuation = previous.slice(lowIndex);
    const overlap = continuationOverlapLength(previous, continuation);
    expect(continuation.slice(overlap)).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(Number.isInteger(overlap)).toBe(true);
  });

  it("stays linear on a long transcript", () => {
    const previous = "y".repeat(400_000);
    const continuation = `${"y".repeat(200_000)} tail`;
    const t0 = performance.now();
    continuationOverlapLength(previous, continuation);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("dedupeResumedSeams", () => {
  it("drops the repeated tail from the answer that resumed a cut", () => {
    const messages = [
      assistant(`First paragraph. ${SEAM}`),
      nudge(OUTPUT_LIMIT_NUDGE),
      assistant(`${SEAM} So I fixed it.`),
    ];
    const out = dedupeResumedSeams(messages);
    expect(out).not.toBe(messages);
    expect(out[2].parts[0].text).toBe(" So I fixed it.");
    // The input is not mutated.
    expect(messages[2].parts[0].text).toBe(`${SEAM} So I fixed it.`);
  });

  it("leaves history without the pattern untouched", () => {
    const messages = [user("hi"), assistant("hello")];
    expect(dedupeResumedSeams(messages)).toEqual(messages);
  });

  it("ignores a nudge that is not a truncation resume", () => {
    const messages = [
      assistant(`First paragraph. ${SEAM}`),
      nudge(EMPTY_REPLY_NUDGE),
      assistant(`${SEAM} So I fixed it.`),
    ];
    expect(dedupeResumedSeams(messages)).toEqual(messages);
  });

  it("requires an assistant turn after the nudge", () => {
    const messages = [
      assistant(SEAM),
      nudge(OUTPUT_LIMIT_NUDGE),
      user("thanks"),
    ];
    expect(dedupeResumedSeams(messages)).toEqual(messages);
  });

  it("handles several resumes in one history", () => {
    const seam2 = "A second paragraph that was also cut off mid sentence.";
    const messages = [
      assistant(`One. ${SEAM}`),
      nudge(OUTPUT_LIMIT_NUDGE),
      assistant(`${SEAM} Two. ${seam2}`),
      nudge(OUTPUT_LIMIT_NUDGE),
      assistant(`${seam2} Three.`),
    ];
    const out = dedupeResumedSeams(messages);
    expect(out[2].parts[0].text).toBe(` Two. ${seam2}`);
    expect(out[4].parts[0].text).toBe(" Three.");
  });
});

describe("trailingContinueIntent", () => {
  it("recognises a bare carry-on", () => {
    for (const text of [
      "continue",
      "Continue.",
      " lanjut ",
      "Lanjutkan!",
      "go on",
      "resume",
    ]) {
      expect(trailingContinueIntent(text), text).toBe(true);
    }
  });

  it("does not treat an instruction as a carry-on", () => {
    for (const text of [
      "",
      "continue the refactor of the storage layer",
      "lanjutkan migrasi database",
      "what did you mean by that?",
      "next steps please",
    ]) {
      expect(trailingContinueIntent(text), text).toBe(false);
    }
  });
});
