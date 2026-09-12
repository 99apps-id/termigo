// Answering an `ask_user` question from free text.
//
// The field bug this prevents: the agent asked which game to build, the user
// typed "tidak ada dulu game yang dibuat" instead of tapping a button, and the
// reply was queued as a NEW task while the question waited forever. Only /stop
// released it - the run had been parked 4m58s and then answered all three queued
// messages at once. Typing is the natural way to answer a question, so the text
// has to reach the question.

import { describe, expect, it } from "vitest";
import { matchElicitationAnswer } from "./telegramHelpers";

const OPTIONS = [
  "Terminal Snake/2048",
  "Browser Tower Defense single-file",
  "Multiplayer quiz battle pakai Next.js",
];

describe("matchElicitationAnswer", () => {
  it("selects an option by its 1-based number", () => {
    // Telegram shows them in order, so a bare "2" is a natural reply.
    expect(matchElicitationAnswer("1", OPTIONS)).toBe("Terminal Snake/2048");
    expect(matchElicitationAnswer("2", OPTIONS)).toBe(
      "Browser Tower Defense single-file",
    );
    expect(matchElicitationAnswer("3", OPTIONS)).toBe(
      "Multiplayer quiz battle pakai Next.js",
    );
  });

  it("tolerates whitespace around the number", () => {
    expect(matchElicitationAnswer("  2\n", OPTIONS)).toBe(
      "Browser Tower Defense single-file",
    );
  });

  it("ignores an out-of-range number and passes it through as text", () => {
    // Better the model sees "0" / "9" than the answer silently becoming an
    // option the user never chose.
    expect(matchElicitationAnswer("0", OPTIONS)).toBe("0");
    expect(matchElicitationAnswer("9", OPTIONS)).toBe("9");
  });

  it("passes a sentence through verbatim", () => {
    // The real reply from the field: a model reads this far better than being
    // forced onto a button.
    const text = "tidak ada dulu game yang dibuat";
    expect(matchElicitationAnswer(text, OPTIONS)).toBe(text);
  });

  it("keeps a multi-line answer intact", () => {
    const text = "jangan game dulu\n\nlanjutkan audit telegram";
    expect(matchElicitationAnswer(text, OPTIONS)).toBe(text);
  });

  it("trims surrounding whitespace from a free-text answer", () => {
    expect(matchElicitationAnswer("  lanjut audit  ", OPTIONS)).toBe(
      "lanjut audit",
    );
  });

  it("works with no options offered", () => {
    expect(matchElicitationAnswer("5", [])).toBe("5");
    expect(matchElicitationAnswer("do this instead", [])).toBe(
      "do this instead",
    );
  });
});
