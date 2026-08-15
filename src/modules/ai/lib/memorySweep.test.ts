import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  MAX_FACTS_PER_SWEEP,
  MIN_MESSAGES_TO_SWEEP,
  parseFacts,
  shouldSweep,
  transcriptText,
} from "./memorySweep";

function msg(role: "user" | "assistant", text: string): UIMessage {
  return {
    id: Math.random().toString(36).slice(2),
    role,
    parts: [{ type: "text", text }],
  } as UIMessage;
}

function conversation(n: number): UIMessage[] {
  return Array.from({ length: n }, (_, i) =>
    msg(i % 2 === 0 ? "user" : "assistant", `turn ${i}`),
  );
}

describe("shouldSweep", () => {
  // The whole point of "Ask every time" is that nothing touches the workspace
  // without a click, and a background sweep has no click to offer.
  it("never sweeps in ask mode, however long the session", () => {
    expect(shouldSweep(conversation(50), "ask")).toBe(false);
  });

  it("sweeps in the delegating modes once there is enough conversation", () => {
    expect(shouldSweep(conversation(MIN_MESSAGES_TO_SWEEP), "edits")).toBe(true);
    expect(shouldSweep(conversation(MIN_MESSAGES_TO_SWEEP), "all")).toBe(true);
  });

  it("skips a short exchange, which is a question rather than a source of facts", () => {
    expect(shouldSweep(conversation(MIN_MESSAGES_TO_SWEEP - 1), "all")).toBe(
      false,
    );
  });
});

describe("transcriptText", () => {
  it("labels speakers and keeps only text", () => {
    const text = transcriptText([
      msg("user", "how do I build?"),
      msg("assistant", "pnpm tauri build"),
    ]);
    expect(text).toBe("user: how do I build?\nassistant: pnpm tauri build");
  });

  it("keeps the tail of a long session, where the conclusions are", () => {
    const text = transcriptText([
      msg("user", "x".repeat(20_000)),
      msg("assistant", "the decision we reached"),
    ]);
    expect(text.length).toBeLessThanOrEqual(12_000);
    expect(text.endsWith("the decision we reached")).toBe(true);
  });

  it("ignores messages with no text, such as a lone tool call", () => {
    const toolOnly = {
      id: "t1",
      role: "assistant",
      parts: [{ type: "tool-bash_run", state: "output-available" }],
    } as unknown as UIMessage;
    expect(transcriptText([toolOnly])).toBe("");
  });
});

describe("parseFacts", () => {
  it("treats NONE as nothing worth keeping", () => {
    expect(parseFacts("NONE")).toEqual([]);
    expect(parseFacts("  none  ")).toEqual([]);
  });

  it("strips list markers the model adds despite being told not to", () => {
    expect(parseFacts("- Uses pnpm.\n* Never npm.\n1. Rust is stable.")).toEqual(
      ["Uses pnpm.", "Never npm.", "Rust is stable."],
    );
  });

  it("caps how much one sweep can add", () => {
    const many = Array.from({ length: 20 }, (_, i) => `fact ${i}`).join("\n");
    expect(parseFacts(many)).toHaveLength(MAX_FACTS_PER_SWEEP);
  });

  it("drops blank lines rather than storing empty facts", () => {
    expect(parseFacts("Uses pnpm.\n\n\nNever npm.")).toEqual([
      "Uses pnpm.",
      "Never npm.",
    ]);
  });
});
