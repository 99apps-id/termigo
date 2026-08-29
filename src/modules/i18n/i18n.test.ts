import { describe, expect, it } from "vitest";
import { en } from "./catalogs/en";
import { id } from "./catalogs/id";
import { translate } from "./index";

describe("catalog parity", () => {
  it("the Indonesian catalog covers every English key", () => {
    for (const key of Object.keys(en)) {
      expect(id, `missing id key: ${key}`).toHaveProperty(key);
    }
  });

  it("has no empty translations", () => {
    for (const [k, v] of Object.entries(id)) {
      expect(v.trim(), `empty id value: ${k}`).not.toBe("");
    }
  });
});

describe("translate", () => {
  it("returns the string for the chosen language", () => {
    expect(translate("en", "common.export")).toBe("Export…");
    expect(translate("id", "common.export")).toBe("Ekspor…");
  });

  it("interpolates {var} placeholders", () => {
    expect(translate("en", "settings.backup.restored", { count: 3 })).toBe(
      "Restored 3 setting(s)",
    );
    expect(
      translate("id", "settings.backup.exportFailed", { error: "boom" }),
    ).toBe("Ekspor gagal: boom");
  });

  it("leaves an unmatched placeholder intact", () => {
    // Missing var → the token stays, rather than becoming "undefined".
    expect(translate("en", "settings.backup.exportFailed")).toBe(
      "Export failed: {error}",
    );
  });

  it("falls back to English for a language that lacks a key at runtime", () => {
    // Simulated by casting: the type system normally guarantees parity, but a
    // hand-edited catalog shouldn't crash the UI.
    const brokenLang = "xx" as "en";
    expect(translate(brokenLang, "common.export")).toBe("Export…");
  });
});
