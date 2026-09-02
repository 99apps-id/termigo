import { describe, expect, it } from "vitest";
import { normalizeAskUserInput } from "./elicitation";

describe("normalizeAskUserInput", () => {
  it("trims an over-long option to the cap instead of rejecting the call", () => {
    // The exact failure from the log: a model stuffed a full rationale
    // (well past 140 chars) into the first option, strict validation threw,
    // and the run looked like it looped on the question.
    const long =
      "Ikuti invariant saja: multi-tenant (company_id + FK komposit) DENGAN ledger produk tunggal yang sudah terbukti (stock_qty via trg_movements_ai). Cepat ke Langkah 2 API. — REKOMENDASI";
    expect(long.length).toBeGreaterThan(140);
    const out = normalizeAskUserInput({
      question: "Sejauh mana cakupan desain skema barunya?",
      options: [long, "Kembalikan ke skema lama"],
    }) as { options: string[] };
    expect(out.options[0].length).toBeLessThanOrEqual(140);
    expect(out.options[0].endsWith("…")).toBe(true);
    expect(out.options[1]).toBe("Kembalikan ke skema lama");
  });

  it("parses options sent as a JSON-array string", () => {
    const out = normalizeAskUserInput({
      question: "Pick",
      options: '["A","B","C"]',
    }) as { options: string[] };
    expect(out.options).toEqual(["A", "B", "C"]);
  });

  it("splits a newline-delimited options string", () => {
    const out = normalizeAskUserInput({
      question: "Pick",
      options: "A\nB\nC",
    }) as { options: string[] };
    expect(out.options).toEqual(["A", "B", "C"]);
  });

  it("drops empty options and caps the list at 6", () => {
    const out = normalizeAskUserInput({
      question: "Pick",
      options: ["A", "", "  ", "B", "C", "D", "E", "F", "G", "H"],
    }) as { options: string[] };
    expect(out.options.length).toBeLessThanOrEqual(6);
    expect(out.options).toContain("A");
    expect(out.options).not.toContain("");
  });

  it("de-duplicates identical options", () => {
    const out = normalizeAskUserInput({
      question: "Pick",
      options: ["A", "A", "B"],
    }) as { options: string[] };
    expect(out.options).toEqual(["A", "B"]);
  });

  it("passes a valid input through unchanged", () => {
    const input = { question: "Ok?", options: ["Yes", "No"] };
    expect(normalizeAskUserInput(input)).toEqual(input);
  });

  it("leaves a non-object input untouched (still errors downstream)", () => {
    expect(normalizeAskUserInput("not json at all")).toBe("not json at all");
    expect(normalizeAskUserInput(42)).toBe(42);
  });
});
