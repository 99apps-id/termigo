import { describe, expect, it } from "vitest";
import { usableSuggestion } from "./terminalSuggest";

describe("usableSuggestion", () => {
  it("keeps a completion that extends the typed prefix", () => {
    expect(usableSuggestion("git ch", "git checkout main")).toBe(
      "git checkout main",
    );
    expect(usableSuggestion("pnpm ", "pnpm install")).toBe("pnpm install");
  });

  it("drops a reply that does not begin with the prefix", () => {
    // The model reworded the command instead of completing it.
    expect(usableSuggestion("git ch", "checkout main")).toBeNull();
  });

  it("drops the bare prefix echoed back and shorter strings", () => {
    expect(usableSuggestion("git status", "git status")).toBeNull();
    expect(usableSuggestion("git status", "git")).toBeNull();
  });

  it("drops empty / null replies", () => {
    expect(usableSuggestion("ls", null)).toBeNull();
    expect(usableSuggestion("ls", "")).toBeNull();
  });
});
