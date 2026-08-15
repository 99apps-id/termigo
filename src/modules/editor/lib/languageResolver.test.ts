import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { resolveDisplayName, resolveLanguage } from "./languageResolver";

describe("resolveDisplayName", () => {
  it("resolves real extensions", () => {
    expect(resolveDisplayName("App.tsx")).toBe("TypeScript React");
    expect(resolveDisplayName("main.go")).toBe("Go");
    expect(resolveDisplayName("README.md")).toBe("Markdown");
    expect(resolveDisplayName("query.sql")).toBe("SQL");
    expect(resolveDisplayName("Component.svelte")).toBe("Svelte");
  });

  it("strips directories before resolving", () => {
    expect(resolveDisplayName("/Users/foo/src/index.ts")).toBe("TypeScript");
    expect(resolveDisplayName("C:\\proj\\Dockerfile.prod")).toBe("Dockerfile");
  });

  it("matches fixed filenames", () => {
    expect(resolveDisplayName("Dockerfile")).toBe("Dockerfile");
    expect(resolveDisplayName(".env")).toBe("Dotenv");
    expect(resolveDisplayName(".eslintrc")).toBe("JSON");
  });

  // Regression: removing isDockerfileLike dropped highlighting for Dockerfile
  // variants. The name-scoped prefix fallback restores it generically.
  it("resolves filename-prefix variants of name-based languages", () => {
    expect(resolveDisplayName("Dockerfile.web")).toBe("Dockerfile");
    expect(resolveDisplayName("Dockerfile.dev")).toBe("Dockerfile");
    expect(resolveDisplayName("web.dockerfile")).toBe("Dockerfile");
    expect(resolveDisplayName(".env.local")).toBe("Dotenv");
    expect(resolveDisplayName(".env.production.local")).toBe("Dotenv");
    expect(resolveDisplayName("example.env")).toBe("Dotenv");
  });

  // `resolveLanguage` dynamically imports a CodeMirror language package, so the
  // two cases below pay a cold transform + import cost. Each finishes in well
  // under a second on its own, but under the full suite's parallel load the
  // Svelte one exceeded vitest's 5s default and failed the run. Budget them
  // explicitly rather than raising the global timeout, which would also hide
  // genuine hangs in tests that ought to be fast.
  const LANGUAGE_LOAD_TIMEOUT_MS = 30_000;

  it(
    "loads dotenv files with their language mode",
    async () => {
      const result = await resolveLanguage("/project/.env.local");
      expect(result?.name).toBe("Dotenv");
      expect(result?.id).toBe("env");
      expect(result?.ext).toBeTruthy();
    },
    LANGUAGE_LOAD_TIMEOUT_MS,
  );

  // `.svelte` used to resolve to HTML, which left blocks and directives as
  // plain text and made the svelte-ls preset unreachable (langId drives both).
  it(
    "loads Svelte files with their dedicated language mode",
    async () => {
      const result = await resolveLanguage("/project/Component.svelte");
      if (!result) throw new Error("Svelte language failed to load");

      expect(result.name).toBe("Svelte");
      expect(result.id).toBe("svelte");

      const state = EditorState.create({
        doc: "{#if ready}<button on:click={run}>{label}</button>{/if}",
        extensions: [result.ext],
      });
      // ensureSyntaxTree, not syntaxTree: the latter returns whatever the
      // parser managed inside its time budget, so under the full suite's
      // parallel load it stopped after `IfBlock` and never reached the
      // `on:click` directive - failing in 486ms while passing alone. Asking
      // for the whole document makes the assertion about the parser rather
      // than about how busy the machine was.
      const parsed = ensureSyntaxTree(state, state.doc.length, 10_000);
      if (!parsed) throw new Error("Svelte parse did not complete");
      const tree = parsed.toString();
      expect(tree).toContain("IfBlock");
      expect(tree).toContain("DirectiveOn");
    },
    LANGUAGE_LOAD_TIMEOUT_MS,
  );

  // The prefix fallback must not let extension languages capture lookalike
  // files: `go.sum` / `go.mod` are not Go, `json.backup` is not JSON.
  it("does not let extension languages capture prefix lookalikes", () => {
    expect(resolveDisplayName("go.sum")).not.toBe("Go");
    expect(resolveDisplayName("go.mod")).not.toBe("Go");
    expect(resolveDisplayName("json.backup")).not.toBe("JSON");
  });

  it("falls back to a capitalized basename for unknown files", () => {
    expect(resolveDisplayName("notes")).toBe("Notes");
    expect(resolveDisplayName(null)).toBe("Plain Text");
    expect(resolveDisplayName("")).toBe("Plain Text");
  });
});
