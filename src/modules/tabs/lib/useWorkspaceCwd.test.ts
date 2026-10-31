import { describe, expect, it } from "vitest";
import { normalizeWorkspaceCwd } from "./useWorkspaceCwd";

describe("normalizeWorkspaceCwd", () => {
  it("keeps POSIX cwd identity stable across OSC 7 spellings", () => {
    const expected = "/home/iwan/project/termigo";

    expect(normalizeWorkspaceCwd("/home/iwan/project/termigo/")).toBe(expected);
    expect(normalizeWorkspaceCwd("/home/iwan//project/termigo")).toBe(expected);
  });

  it("converts Windows separators without changing the shared boundary", () => {
    expect(normalizeWorkspaceCwd("C:\\project\\termigo\\")).toBe(
      "C:/project/termigo",
    );
  });
});
