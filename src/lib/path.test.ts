import { describe, expect, it } from "vitest";
import { canonicalDirPath } from "./path";

describe("canonicalDirPath", () => {
  it("reads one directory spelled different ways as one path", () => {
    const expected = "C:/project/app";
    expect(canonicalDirPath("C:/project/app")).toBe(expected);
    expect(canonicalDirPath("C:/project/app/")).toBe(expected);
    expect(canonicalDirPath("C:\\project\\app")).toBe(expected);
    expect(canonicalDirPath("C:/project/app//")).toBe(expected);
    expect(canonicalDirPath("C:/project//app")).toBe(expected);
  });

  it("preserves case, so two real directories stay distinct", () => {
    expect(canonicalDirPath("/home/App")).not.toBe(
      canonicalDirPath("/home/app"),
    );
  });

  it("keeps a filesystem root intact", () => {
    expect(canonicalDirPath("/")).toBe("/");
    expect(canonicalDirPath("C:/")).toBe("C:");
    expect(canonicalDirPath("C:")).toBe("C:");
  });

  it("keeps the leading double slash of a UNC root", () => {
    expect(canonicalDirPath("\\\\server\\share\\proj\\")).toBe(
      "//server/share/proj",
    );
    expect(canonicalDirPath("//server/share/proj")).toBe("//server/share/proj");
  });
});
