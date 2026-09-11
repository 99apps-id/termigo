// Invariants that keep the Bot API from rejecting a message outright.
//
// Telegram fails the WHOLE sendMessage when any callback_data exceeds 64 bytes
// or the keyboard carries more than 100 buttons. For a model picker or an
// approval prompt that means the user has no control surface at all, so the
// keyboard is filtered rather than sent and rejected.

import { describe, expect, it } from "vitest";
import {
  type InlineButton,
  sanitizeInlineKeyboard,
  splitTelegramText,
  TELEGRAM_MAX_CALLBACK_DATA_BYTES,
  TELEGRAM_MAX_INLINE_BUTTONS,
} from "./telegramApi";

const button = (callback_data: string, text = "x"): InlineButton => ({
  text,
  callback_data,
});

describe("sanitizeInlineKeyboard", () => {
  it("keeps buttons that already fit", () => {
    const keyboard = [
      [button("ap:approve:q-abc", "Approve"), button("ap:deny:q-abc", "Deny")],
    ];
    expect(sanitizeInlineKeyboard(keyboard)).toEqual(keyboard);
  });

  it("drops an over-long callback_data without losing its neighbours", () => {
    // This is the approval-prompt case: one oversized button must not take
    // Approve and Deny down with it.
    const keyboard = [
      [button("ap:approve:q-1", "Approve"), button("ap:deny:q-1", "Deny")],
      [
        button("ap:session:q-1", "Allow session"),
        button(`ap:always:${"z".repeat(80)}`, "Allow always"),
      ],
    ];
    const clean = sanitizeInlineKeyboard(keyboard);
    expect(clean).toEqual([
      [button("ap:approve:q-1", "Approve"), button("ap:deny:q-1", "Deny")],
      [button("ap:session:q-1", "Allow session")],
    ]);
  });

  it("drops a row that becomes empty", () => {
    const clean = sanitizeInlineKeyboard([
      [button(`ms:${"y".repeat(90)}`, "Huge")],
      [button("ms:gpt-5.4-mini", "GPT-5.4 mini")],
    ]);
    expect(clean).toEqual([[button("ms:gpt-5.4-mini", "GPT-5.4 mini")]]);
  });

  it("counts bytes, not UTF-16 code units", () => {
    // Telegram's limit is in bytes. A 2-byte char reaches the limit at 32.
    const twoByte = "é".repeat(TELEGRAM_MAX_CALLBACK_DATA_BYTES / 2);
    const overByOne = "é".repeat(TELEGRAM_MAX_CALLBACK_DATA_BYTES / 2 + 1);
    expect(sanitizeInlineKeyboard([[button(twoByte)]]).length).toBe(1);
    expect(sanitizeInlineKeyboard([[button(overByOne)]])).toEqual([]);
  });

  it("counts a surrogate pair as 4 bytes", () => {
    const emoji = "🙂".repeat(TELEGRAM_MAX_CALLBACK_DATA_BYTES / 4);
    const overByOne = `${emoji}🙂`;
    expect(sanitizeInlineKeyboard([[button(emoji)]]).length).toBe(1);
    expect(sanitizeInlineKeyboard([[button(overByOne)]])).toEqual([]);
  });

  it("accepts exactly the limit and rejects one byte over", () => {
    const exact = "a".repeat(TELEGRAM_MAX_CALLBACK_DATA_BYTES);
    expect(sanitizeInlineKeyboard([[button(exact)]])).toEqual([
      [button(exact)],
    ]);
    expect(sanitizeInlineKeyboard([[button(`${exact}a`)]])).toEqual([]);
  });

  it("caps the total number of buttons", () => {
    const rows = Array.from({ length: TELEGRAM_MAX_INLINE_BUTTONS + 20 }, (_, i) => [
      button(`ms:m-${i}`),
    ]);
    const total = sanitizeInlineKeyboard(rows).reduce(
      (n, row) => n + row.length,
      0,
    );
    expect(total).toBe(TELEGRAM_MAX_INLINE_BUTTONS);
  });

  it("drops a button with no callback_data", () => {
    expect(sanitizeInlineKeyboard([[button("")]])).toEqual([]);
  });

  it("clamps an over-long button label but keeps the button", () => {
    const clean = sanitizeInlineKeyboard([
      [button("ms:gpt-5.6", "L".repeat(200))],
    ]);
    expect(clean[0]).toHaveLength(1);
    expect(clean[0][0].text.length).toBeLessThanOrEqual(64);
    expect(clean[0][0].callback_data).toBe("ms:gpt-5.6");
  });

  it("returns an empty keyboard for an empty input", () => {
    expect(sanitizeInlineKeyboard([])).toEqual([]);
  });
});

describe("splitTelegramText", () => {
  it("leaves a short message alone", () => {
    expect(splitTelegramText("hello")).toEqual(["hello"]);
  });

  it("splits a long message without dropping content", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const chunks = splitTelegramText(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
    // Every original line survives, in order.
    expect(chunks.join("\n")).toContain("line 0");
    expect(chunks.join("\n")).toContain("line 399");
  });
});
