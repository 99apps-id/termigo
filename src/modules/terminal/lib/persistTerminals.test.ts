import { describe, expect, it } from "vitest";
import {
  isValidPersistKey,
  makePersistKey,
  sanitizePersistKey,
  tmuxAttachCommand,
  tmuxSessionKey,
} from "./persistTerminals";

describe("isValidPersistKey", () => {
  it("accepts lowercase ids with dashes", () => {
    expect(isValidPersistKey("leaf-3")).toBe(true);
    expect(isValidPersistKey("a")).toBe(true);
  });

  it("rejects unsafe characters", () => {
    expect(isValidPersistKey("Leaf 3")).toBe(false);
    expect(isValidPersistKey("a/b")).toBe(false);
    expect(isValidPersistKey("")).toBe(false);
    expect(isValidPersistKey("a".repeat(49))).toBe(false);
  });
});

describe("sanitizePersistKey", () => {
  it("lowercases and collapses separators", () => {
    expect(sanitizePersistKey("Hello World")).toBe("hello-world");
  });

  it("strips unsafe characters", () => {
    expect(sanitizePersistKey("a/b_c d")).toBe("a-b-c-d");
  });

  it("falls back to a safe default", () => {
    expect(sanitizePersistKey("!@#")).toBe("leaf");
    expect(sanitizePersistKey("")).toBe("leaf");
  });

  it("truncates to the id length", () => {
    expect(sanitizePersistKey("a".repeat(100))).toHaveLength(48);
  });
});

describe("tmuxSessionKey", () => {
  it("prefixes a sanitised key", () => {
    expect(tmuxSessionKey("Leaf 3")).toBe("termigo-leaf-3");
  });
});

describe("makePersistKey", () => {
  it("combines cwd basename and symbol", () => {
    expect(makePersistKey("/home/me/dev/app", "5")).toBe("app-5");
  });

  it("distinguishes same-cwd leaves by symbol", () => {
    expect(makePersistKey("/app", "1")).not.toBe(makePersistKey("/app", "2"));
  });

  it("falls back when cwd is absent", () => {
    expect(makePersistKey(undefined, "3")).toBe("leaf-3");
  });
});

describe("tmuxAttachCommand", () => {
  it("builds a create-or-attach command with quoted argv", () => {
    const cmd = tmuxAttachCommand("leaf-3", ["/bin/bash", "-i"]);
    expect(cmd).toBe(
      "tmux new-session -A -s termigo-leaf-3 -- '/bin/bash' '-i'",
    );
  });

  it("quotes arguments containing spaces", () => {
    const cmd = tmuxAttachCommand("leaf-3", ["/path/with space/sh"]);
    expect(cmd).toContain("'/path/with space/sh'");
  });
});
