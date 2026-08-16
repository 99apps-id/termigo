import { describe, expect, it } from "vitest";
import { appendEnvTurn, truncateProjectMemory } from "./transport";

const LIMIT = 10 * 1024;

describe("truncateProjectMemory", () => {
  it("leaves a document that already fits", () => {
    const doc = "# Project\n\nSmall enough.\n";
    expect(truncateProjectMemory(doc)).toBe(doc);
  });

  it("keeps the top of the document, which is where the overview is", () => {
    const doc = `# Overview\nthe important part\n${"x".repeat(LIMIT * 2)}`;
    const out = truncateProjectMemory(doc);
    expect(out.startsWith("# Overview\nthe important part")).toBe(true);
  });

  it("says it was cut, so the agent knows the rest exists", () => {
    const doc = `line\n`.repeat(LIMIT);
    expect(truncateProjectMemory(doc)).toMatch(/truncated here/);
  });

  // A blind slice ends mid-sentence, which reads as a fact that stops halfway
  // rather than a document that was cut short.
  it("cuts on a line boundary rather than mid-sentence", () => {
    const doc = `${"a".repeat(100)}\n`.repeat(LIMIT);
    const out = truncateProjectMemory(doc).replace(/\n\n\[TERMIGO.*$/s, "");
    for (const line of out.split("\n")) {
      expect(line === "" || line.length === 100).toBe(true);
    }
  });

  it("stays close to the budget rather than growing past it", () => {
    const out = truncateProjectMemory("y".repeat(LIMIT * 3));
    expect(out.length).toBeLessThan(LIMIT + 200);
  });

  it("still cuts a file with no line breaks at all", () => {
    const out = truncateProjectMemory("z".repeat(LIMIT * 2));
    expect(out.length).toBeLessThan(LIMIT + 200);
    expect(out).toMatch(/truncated here/);
  });
});

// Providers cache on an exact token prefix. The env block used to be merged
// into the last user message on the outgoing copy only, so the message that
// carried it on one turn arrived without it on the next — and the difference
// landed at the first user message, invalidating everything after it.
describe("appendEnvTurn", () => {
  const user = (id: string, text: string) =>
    ({ id, role: "user", parts: [{ type: "text", text }] }) as never;
  const assistant = (id: string, text: string) =>
    ({ id, role: "assistant", parts: [{ type: "text", text }] }) as never;

  const textOf = (m: { parts: unknown }) =>
    (m.parts as { type: string; text?: string }[])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");

  it("leaves every stored message untouched", () => {
    const history = [user("u1", "first"), assistant("a1", "reply")];
    const out = appendEnvTurn(history, "<env>\ncwd: /x\n</env>");
    expect(out.slice(0, 2)).toEqual(history);
  });

  it("puts the env last, where a change costs nothing", () => {
    const out = appendEnvTurn([user("u1", "hi")], "<env>\ncwd: /x\n</env>");
    expect(out).toHaveLength(2);
    expect(textOf(out[1])).toContain("<env>");
  });

  // The regression this exists to prevent: turn N+1 must repeat turn N's
  // history exactly, or the provider's cache starts from scratch every time.
  it("keeps the prefix identical from one turn to the next", () => {
    const env1 = "<env>\ncwd: /x\n</env>";
    const env2 = "<env>\ncwd: /y\n</env>";

    const turnN = appendEnvTurn([user("u1", "first")], env1);
    const turnNext = appendEnvTurn(
      [user("u1", "first"), assistant("a1", "reply"), user("u2", "second")],
      env2,
    );

    // Everything turn N sent before its env block reappears unchanged.
    expect(turnNext[0]).toEqual(turnN[0]);
  });

  it("does not fold the env into the user's own text", () => {
    const out = appendEnvTurn([user("u1", "selamat malam")], "<env>\ncwd: /x\n</env>");
    expect(textOf(out[0])).toBe("selamat malam");
  });
});
