// One composer per bar.
//
// The centre bar used to offer a Shell / AI switch on a block tab, so the same
// input could be the terminal's or a chat's. In practice two composers competed
// for one bar: the dock already types into the AI chat, and which surface the
// keystrokes reached depended on a toggle the user had to notice. The AI segment
// is gone; these tests are what stop it coming back without the reasoning.

import { describe, expect, it } from "vitest";
import { inputSurfaces } from "./inputSurfaces";

describe("inputSurfaces", () => {
  it("gives a block tab the shell input and nothing else", () => {
    // The reported bug: a block tab showed Shell AND AI.
    expect(
      inputSurfaces({ isBlockTab: true, hasComposer: true, panelOpen: false }),
    ).toEqual({ shell: true, ai: false });
  });

  it("does not offer the AI composer on a block tab even with the dock closed", () => {
    // The toggle was only offered when a composer existed, so removing the
    // toggle must not move the composer back in.
    expect(
      inputSurfaces({ isBlockTab: true, hasComposer: true, panelOpen: true }),
    ).toEqual({ shell: true, ai: false });
  });

  it("never shows both surfaces at once", () => {
    // The invariant. Every other assertion here is a case of it.
    for (const isBlockTab of [true, false]) {
      for (const hasComposer of [true, false]) {
        for (const panelOpen of [true, false]) {
          const s = inputSurfaces({ isBlockTab, hasComposer, panelOpen });
          expect(
            s.shell && s.ai,
            `both surfaces for block=${isBlockTab} composer=${hasComposer} dock=${panelOpen}`,
          ).toBe(false);
        }
      }
    }
  });

  it("keeps the AI composer for a normal tab with the dock closed", () => {
    expect(
      inputSurfaces({ isBlockTab: false, hasComposer: true, panelOpen: false }),
    ).toEqual({ shell: false, ai: true });
  });

  it("leaves the typing area to the dock while the dock is open", () => {
    expect(
      inputSurfaces({ isBlockTab: false, hasComposer: true, panelOpen: true }),
    ).toEqual({ shell: false, ai: false });
  });

  it("shows no composer on a normal tab without one", () => {
    expect(
      inputSurfaces({ isBlockTab: false, hasComposer: false, panelOpen: false }),
    ).toEqual({ shell: false, ai: false });
  });

  it("never gives a non-block tab a shell input", () => {
    for (const hasComposer of [true, false]) {
      for (const panelOpen of [true, false]) {
        expect(
          inputSurfaces({ isBlockTab: false, hasComposer, panelOpen }).shell,
        ).toBe(false);
      }
    }
  });
});
