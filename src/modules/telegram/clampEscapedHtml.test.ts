import { describe, expect, it } from "vitest";
import { escapePlainTextToHtml } from "./progressFormat";
import { clampEscapedHtml, TELEGRAM_MAX_MESSAGE_CHARS } from "./telegramApi";

// The bug this pins, seen from the user's side: a long answer containing `&`
// took the plain-text fallback, the escaped form was sliced mid-entity, and
// Telegram rejected the message for an invalid entity - so the reply that the
// fallback exists to deliver was never delivered. `2>&1` in a shell transcript
// is enough to hit it.
//
// Input is built with the REAL escaper, because `clampEscapedHtml` assumes its
// argument is already escaped: feeding it raw text would contain bare `&` that
// are not entities, and the property below would be asserting the wrong thing.
describe("clampEscapedHtml", () => {
  it("leaves text under the limit untouched", () => {
    expect(clampEscapedHtml("short &amp; fine", 100)).toBe("short &amp; fine");
  });

  it("never returns more than the limit", () => {
    const long = "&amp;".repeat(2000);
    expect(clampEscapedHtml(long, 4096).length).toBeLessThanOrEqual(4096);
  });

  // The regression. A plain slice at 4096 of this string lands inside `&amp;`
  // and produces a dangling fragment.
  it("does not leave a half-written entity at the cut", () => {
    const long = `${"x".repeat(4090)}&amp;${"y".repeat(50)}`;
    const out = clampEscapedHtml(long, 4096);

    // No unclosed entity: every `&` must be followed by a `;`.
    const lastAmp = out.lastIndexOf("&");
    if (lastAmp !== -1) {
      expect(out.slice(lastAmp)).toContain(";");
    }
    expect(out.length).toBeLessThanOrEqual(4096);
  });

  // Stated as the property that actually matters, so the test does not depend on
  // how the helper happens to achieve it. The channel input is exactly the kind
  // of text that triggers the fallback: shell commands with `2>&1`, `&&`.
  it("every ampersand in the result starts a complete entity", () => {
    const escaped = escapePlainTextToHtml(
      "cmd 2>&1 && echo a & b < c > d ".repeat(400),
    );
    const out = clampEscapedHtml(escaped, TELEGRAM_MAX_MESSAGE_CHARS);

    for (const fragment of out.split("&").slice(1)) {
      // An entity is `&` + name/number + `;`, all within 8 chars here.
      expect(fragment).toMatch(/^[a-zA-Z#0-9]{1,8};/);
    }
  });

  it("keeps a complete entity that ends before the cut", () => {
    // Cuts at max-1, matching `clampText`, so 19 characters survive.
    const text = `a&amp;b${"c".repeat(100)}`;
    expect(clampEscapedHtml(text, 20)).toBe(`a&amp;b${"c".repeat(12)}`);
  });

  // Backing off must not run away to nothing when the cut lands on an entity.
  it("still returns the text before the entity that was cut", () => {
    const text = `${"x".repeat(10)}${"&amp;".repeat(10)}`;
    expect(clampEscapedHtml(text, 12)).toBe("x".repeat(10));
  });

  it("handles a cut at position 0 without throwing", () => {
    expect(clampEscapedHtml("&amp;hello", 1)).toBe("");
  });
});
