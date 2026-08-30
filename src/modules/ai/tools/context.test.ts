import { describe, expect, it } from "vitest";
import { resolvePath, resolveRemotePath } from "./context";

describe("resolveRemotePath", () => {
  it("resolves a relative path against the remote cwd with a forward slash", () => {
    expect(resolveRemotePath("src/main.ts", "/root/app")).toBe(
      "/root/app/src/main.ts",
    );
  });

  it("does not double the slash when the remote cwd ends with one", () => {
    expect(resolveRemotePath("config.yaml", "/root/app/")).toBe(
      "/root/app/config.yaml",
    );
  });

  it("passes absolute POSIX paths through unchanged", () => {
    expect(resolveRemotePath("/var/www", "/root")).toBe("/var/www");
    expect(resolveRemotePath("/", "/root")).toBe("/");
  });

  it("returns null for Windows drive paths so they stay local", () => {
    expect(resolveRemotePath("C:\\Users\\me\\file.txt", "/root")).toBeNull();
    expect(resolveRemotePath("C:/Users/me/file.txt", "/root")).toBeNull();
  });

  it("returns null for a relative path with no remote cwd so the read falls back to local", () => {
    expect(resolveRemotePath("src/main.ts", null)).toBeNull();
  });
});

describe("resolvePath", () => {
  it("still resolves local Windows paths against a backslash cwd", () => {
    expect(resolvePath("src\\main.ts", "C:\\project")).toBe(
      "C:\\project\\src\\main.ts",
    );
  });
});
