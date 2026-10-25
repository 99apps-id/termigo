import { describe, expect, it } from "vitest";
import { predictGhostText } from "./ghostPredictor";

describe("predictGhostText", () => {
  it("returns null for short or empty inputs", () => {
    expect(predictGhostText("")).toBeNull();
    expect(predictGhostText(" ")).toBeNull();
    expect(predictGhostText("g")).toBeNull();
  });

  it("prioritizes in-memory session history over patterns", () => {
    const history = ["git checkout fix/login-modal", "git status"];
    const sugg = predictGhostText("git check", { history });
    expect(sugg).toBe("git checkout fix/login-modal");
  });

  it("suggests common CLI patterns when not found in history", () => {
    const sugg = predictGhostText("cargo clip", { history: [] });
    expect(sugg).toBe("cargo clippy --all-targets --locked");

    const pnpmSugg = predictGhostText("pnpm check", { history: [] });
    expect(pnpmSugg).toBe("pnpm check-types");
  });

  it("returns null when input equals full candidate string", () => {
    expect(
      predictGhostText("git status", { history: ["git status"] }),
    ).toBeNull();
  });
});
