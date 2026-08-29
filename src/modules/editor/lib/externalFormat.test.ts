import { describe, expect, it } from "vitest";
import { resolveFormatter } from "./externalFormat";

const prefs = (
  global: Parameters<typeof resolveFormatter>[1]["editorFormatter"],
  byLang: Record<string, never> | Record<string, "ruff" | "prettier"> = {},
) => ({ editorFormatter: global, editorFormatterByLang: byLang });

describe("resolveFormatter", () => {
  it("explicit override wins over the global default", () => {
    expect(resolveFormatter("py", prefs("biome", { py: "ruff" }))).toBe("ruff");
  });

  it("global external applies only to languages it understands", () => {
    expect(resolveFormatter("ts", prefs("biome"))).toBe("biome");
    expect(resolveFormatter("py", prefs("biome"))).toBe("lsp");
    expect(resolveFormatter("rs", prefs("prettier"))).toBe("lsp");
    expect(resolveFormatter("svelte", prefs("prettier"))).toBe("prettier");
  });

  it("lsp and custom globals always apply", () => {
    expect(resolveFormatter("py", prefs("lsp"))).toBe("lsp");
    expect(resolveFormatter("py", prefs("custom"))).toBe("custom");
  });

  it("unknown language falls back to lsp for external globals", () => {
    expect(resolveFormatter(null, prefs("biome"))).toBe("lsp");
  });

  it("built-in Prettier applies to web languages, falls back to lsp elsewhere", () => {
    expect(resolveFormatter("ts", prefs("prettier-builtin"))).toBe(
      "prettier-builtin",
    );
    expect(resolveFormatter("css", prefs("prettier-builtin"))).toBe(
      "prettier-builtin",
    );
    // rust/python aren't web languages Prettier handles → language server.
    expect(resolveFormatter("rs", prefs("prettier-builtin"))).toBe("lsp");
    expect(resolveFormatter("py", prefs("prettier-builtin"))).toBe("lsp");
  });
});
