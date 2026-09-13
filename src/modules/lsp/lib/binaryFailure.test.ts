import { describe, expect, it } from "vitest";
import { looksLikeMissingBinary } from "./binaryFailure";

describe("looksLikeMissingBinary", () => {
  // The real message from the incident this exists for: rustup's shim is on
  // PATH, so the binary-existence check passes, and the failure only appears at
  // launch time. Pinning the exact string is the point - a paraphrase would
  // prove nothing about the case that was actually broken.
  it("recognises rustup's unknown-binary error", () => {
    expect(
      looksLikeMissingBinary(
        "error: Unknown binary 'rust-analyzer.exe' in official toolchain 'stable-x86_64-pc-windows-msvc'.",
      ),
    ).toBe(true);
  });

  it("recognises the usual shell and platform spellings", () => {
    expect(looksLikeMissingBinary("rust-analyzer: command not found")).toBe(true);
    expect(looksLikeMissingBinary("Error: spawn pyright-langserver ENOENT")).toBe(true);
    expect(
      looksLikeMissingBinary("The system cannot find the file specified. (os error 2)"),
    ).toBe(true);
    expect(
      looksLikeMissingBinary("'gopls' is not recognized as an internal or external command"),
    ).toBe(true);
    expect(looksLikeMissingBinary("Cannot find module 'pyright'")).toBe(true);
  });

  // A memory-budget kill and a crash on a large crate are NOT install problems,
  // and offering an install command for them sends the user the wrong way.
  it("stays quiet for failures that are not about launching", () => {
    expect(
      looksLikeMissingBinary("Exceeded the 3072 MB memory budget for this server."),
    ).toBe(false);
    expect(
      looksLikeMissingBinary("panicked at 'index out of bounds' during crate analysis"),
    ).toBe(false);
  });

  // No reason was captured at all: nothing to match on, so nothing to claim.
  it("is false for empty input rather than throwing", () => {
    expect(looksLikeMissingBinary("")).toBe(false);
    expect(looksLikeMissingBinary(null)).toBe(false);
    expect(looksLikeMissingBinary(undefined)).toBe(false);
  });
});
