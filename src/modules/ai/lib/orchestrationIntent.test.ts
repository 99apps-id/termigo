import { describe, expect, it } from "vitest";
import { wantsForcedFanout } from "./orchestrationIntent";
import { latestUserRequest } from "./agent";

describe("wantsForcedFanout", () => {
  it("fires on a study verb with a breadth cue", () => {
    for (const t of [
      "audit the entire codebase for security issues",
      "explore the whole repo and tell me how auth works",
      "trace how requests flow across the system",
      "telusuri seluruh proyek ini",
      "pelajari arsitektur aplikasi secara menyeluruh",
      "petakan semua modul yang menyentuh SSH",
    ]) {
      expect(wantsForcedFanout(t), t).toBe(true);
    }
  });

  // The comment in the module calls this the biggest latency complaint: a fan-out
  // for single-file work is slower than just reading the file.
  it("does not fire on a study verb alone", () => {
    for (const t of [
      "explain this line",
      "analyze this function",
      "pahami fungsi ini",
      "tinjau perubahan di file ini",
      "understand what this does",
    ]) {
      expect(wantsForcedFanout(t), t).toBe(false);
    }
  });

  it("fires when subagents are asked for by name", () => {
    for (const t of [
      "use subagents for this",
      "pakai sub-agent untuk mengerjakannya",
      "orchestrate this across a few workers",
    ]) {
      expect(wantsForcedFanout(t), t).toBe(true);
    }
  });

  // Talking about the feature is not asking for it. Without the negation guard
  // both of these ran the very thing they were declining or asking about.
  it("does not fire on a negated or interrogative mention", () => {
    for (const t of [
      "don't use subagents for this",
      "do this without subagents",
      "jangan pakai subagent",
      "tanpa subagen ya",
      "why did that subagent fail?",
      "kenapa subagent tadi gagal?",
    ]) {
      expect(wantsForcedFanout(t), t).toBe(false);
    }
  });

  // "whole" is breadth, except when it modifies a single unit.
  it("reads 'whole' by what it modifies", () => {
    expect(wantsForcedFanout("audit the whole codebase")).toBe(true);
    expect(wantsForcedFanout("analyze the whole file")).toBe(false);
    expect(wantsForcedFanout("explain the whole function")).toBe(false);
  });

  // The env block carries the workspace path, and this one literally contains
  // "project" - without stripping it first, every single turn looked broad.
  it("ignores breadth words coming from the injected env block", () => {
    const env = "<env>\nworkspace_root: C:/project/termigo\n</env>";
    expect(wantsForcedFanout(`${env}\n\nexplain this line`)).toBe(false);
    expect(wantsForcedFanout(`${env}\n\npahami fungsi ini`)).toBe(false);
    // A real request still gets through with the block present.
    expect(wantsForcedFanout(`${env}\n\naudit seluruh proyek`)).toBe(true);
  });

  it("is not fooled by breadth words hiding inside other words", () => {
    for (const t of [
      "analyze the reporting module",
      "study the projected totals",
      "telusuri proyeksi penjualan",
    ]) {
      expect(wantsForcedFanout(t), t).toBe(false);
    }
  });

  it("treats an empty message as nothing to fan out", () => {
    expect(wantsForcedFanout("")).toBe(false);
    expect(wantsForcedFanout("   ")).toBe(false);
  });
});

// The env block travels as a user turn of its own now, so the newest user
// message is `<env>…</env>` rather than anything typed. Reading that one would
// test the workspace path for breadth words instead of the request.
describe("latestUserRequest", () => {
  const user = (text: string) => ({ role: "user" as const, content: text });
  const assistant = (text: string) => ({
    role: "assistant" as const,
    content: text,
  });
  const ENV = "<env>\nworkspace_root: C:/project/termigo\n</env>";

  it("skips a trailing env turn to find the real request", () => {
    expect(
      latestUserRequest([user("pahami fungsi ini"), user(ENV)]),
    ).toBe("pahami fungsi ini");
  });

  it("takes the newest request when several turns exist", () => {
    expect(
      latestUserRequest([
        user("first"),
        assistant("reply"),
        user("second"),
        user(ENV),
      ]),
    ).toBe("second");
  });

  it("reads text out of a parts array", () => {
    expect(
      latestUserRequest([
        {
          role: "user",
          content: [
            { type: "text", text: "audit seluruh proyek" },
          ] as never,
        },
        user(ENV),
      ]),
    ).toBe("audit seluruh proyek");
  });

  it("returns empty when there is nothing but env", () => {
    expect(latestUserRequest([user(ENV)])).toBe("");
    expect(latestUserRequest([])).toBe("");
  });

  // The two put together: a narrow request must stay narrow even though the
  // env block right after it contains the word "project".
  it("keeps a narrow request narrow despite the env block", () => {
    const text = latestUserRequest([user("explain this line"), user(ENV)]);
    expect(wantsForcedFanout(text)).toBe(false);
  });
});
