import { describe, expect, it } from "vitest";

import {
  GEMINI_SAFETY_SETTINGS,
  injectSafetySettings,
} from "./googleSafety";

describe("GEMINI_SAFETY_SETTINGS", () => {
  it("unlocks the four adjustable categories and skips civic integrity", () => {
    const categories = GEMINI_SAFETY_SETTINGS.map((s) => s.category);
    expect(categories).toContain("HARM_CATEGORY_DANGEROUS_CONTENT");
    expect(categories).toContain("HARM_CATEGORY_HARASSMENT");
    // Google rejects BLOCK_NONE for civic integrity, so it must not be sent.
    expect(categories).not.toContain("HARM_CATEGORY_CIVIC_INTEGRITY");
    expect(GEMINI_SAFETY_SETTINGS.every((s) => s.threshold === "BLOCK_NONE")).toBe(
      true,
    );
  });
});

describe("injectSafetySettings", () => {
  it("adds the settings when the body carries none", () => {
    const out = JSON.parse(
      injectSafetySettings('{"contents":[{"role":"user","parts":[]}]}'),
    );
    expect(out.safetySettings).toEqual(GEMINI_SAFETY_SETTINGS);
    expect(out.contents).toHaveLength(1);
  });

  it("keeps settings the caller already provided", () => {
    const body = '{"safetySettings":[{"category":"HARM_CATEGORY_HARASSMENT"}]}';
    expect(injectSafetySettings(body)).toBe(body);
  });

  it("leaves malformed JSON untouched", () => {
    expect(injectSafetySettings("not json")).toBe("not json");
  });
});
