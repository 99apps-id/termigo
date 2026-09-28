import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { DirEntry } from "./native";

vi.mock("./native", () => ({
  native: { readFile: vi.fn(), readDir: vi.fn() },
}));

import { native } from "./native";
import {
  appendEnvTurn,
  formatEnvBlock,
  isResumingApproval,
  mergeRuleFiles,
  PROJECT_RULE_FILES,
  readProjectRules,
  resolveRuleFiles,
  TERMIGO_MD_MAX_CHARS,
  truncateProjectMemory,
} from "./transport";

const readFile = vi.mocked(native.readFile);
const readDir = vi.mocked(native.readDir);
const textRead = (content: string) =>
  ({ kind: "text", content }) as Awaited<ReturnType<typeof native.readFile>>;
const fileEntry = (name: string): DirEntry => ({
  name,
  kind: "file",
  size: 0,
  mtime: 0,
  gitignored: false,
});

const LIMIT = 10 * 1024;

describe("truncateProjectMemory", () => {
  it("leaves a document that already fits", () => {
    const doc = "# Project\n\nSmall enough.\n";
    expect(truncateProjectMemory(doc)).toBe(doc);
  });

  it("keeps the top of the document, which is where the overview is", () => {
    const doc = `# Overview\nthe important part\n${"x".repeat(LIMIT * 2)}`;
    const out = truncateProjectMemory(doc);
    expect(out.startsWith("# Overview\nthe important part")).toBe(true);
  });

  it("says it was cut, so the agent knows the rest exists", () => {
    const doc = `line\n`.repeat(LIMIT);
    expect(truncateProjectMemory(doc)).toMatch(/truncated here/);
  });

  // A blind slice ends mid-sentence, which reads as a fact that stops halfway
  // rather than a document that was cut short.
  it("cuts on a line boundary rather than mid-sentence", () => {
    const doc = `${"a".repeat(100)}\n`.repeat(LIMIT);
    const out = truncateProjectMemory(doc).replace(/\n\n\[TERMIGO.*$/s, "");
    for (const line of out.split("\n")) {
      expect(line === "" || line.length === 100).toBe(true);
    }
  });

  it("stays close to the budget rather than growing past it", () => {
    const out = truncateProjectMemory("y".repeat(LIMIT * 3));
    expect(out.length).toBeLessThan(LIMIT + 200);
  });

  it("still cuts a file with no line breaks at all", () => {
    const out = truncateProjectMemory("z".repeat(LIMIT * 2));
    expect(out.length).toBeLessThan(LIMIT + 200);
    expect(out).toMatch(/truncated here/);
  });

  it("discovers TERMIGO.md, .termigorules, CLAUDE.md, and AGENTS.md", () => {
    expect(PROJECT_RULE_FILES).toContain("TERMIGO.md");
    expect(PROJECT_RULE_FILES).toContain(".termigorules");
    expect(PROJECT_RULE_FILES).toContain("CLAUDE.md");
    expect(PROJECT_RULE_FILES).toContain("AGENTS.md");
  });
});

// The list carries both spellings of each name on purpose: on a case-sensitive
// filesystem `USER.md` and `user.md` are two files and both count. On Windows
// and macOS the second spelling resolves to the SAME file, so the join carried
// every rule twice - 4738 characters of the 10240 the agent receives, which cut
// TERMIGO.md's tail off and dropped CLAUDE.md entirely, on every request.
describe("mergeRuleFiles", () => {
  it("drops a rule file that was read twice under its other spelling", () => {
    const user = "# USER.md\nrules\n";
    const agents = "# AGENTS.md\nmore\n";
    const out = mergeRuleFiles([
      { name: "USER.md", content: user },
      { name: "user.md", content: user },
      { name: "AGENTS.md", content: agents },
      { name: "agents.md", content: agents },
    ]);
    expect(out?.match(/rules/g)).toHaveLength(1);
    expect(out?.match(/more/g)).toHaveLength(1);
  });

  it("keeps two genuinely different files in the same name family", () => {
    const out = mergeRuleFiles([
      { name: "USER.md", content: "# USER.md\nupper\n" },
      { name: "user.md", content: "# user.md\nlower\n" },
    ]);
    expect(out).toContain("upper");
    expect(out).toContain("lower");
    expect(out).toContain("<!-- Rules from USER.md -->");
    expect(out).toContain("<!-- Rules from user.md -->");
  });

  it("returns a single file unlabelled, and null for none", () => {
    expect(mergeRuleFiles([{ name: "TERMIGO.md", content: "# T\n" }])).toBe(
      "# T\n",
    );
    expect(mergeRuleFiles([])).toBeNull();
  });

  // The duplicates were eating the budget the model actually reads: the cut
  // landed inside TERMIGO.md instead of past the end of the rule set.
  it("spends the budget on unique rules, not on the same file twice", () => {
    const filler = (title: string) =>
      `${title}\n${"a rule line that explains something\n".repeat(50)}`;
    const files = [
      { name: "USER.md", content: filler("# USER.md") },
      { name: "user.md", content: filler("# USER.md") },
      { name: "AGENTS.md", content: filler("# AGENTS.md") },
      { name: "agents.md", content: filler("# AGENTS.md") },
      { name: "TERMIGO.md", content: filler("# TERMIGO.md") },
      { name: "termigo.md", content: filler("# TERMIGO.md") },
      { name: "CLAUDE.md", content: filler("# CLAUDE.md") },
      { name: "claude.md", content: filler("# CLAUDE.md") },
    ];
    const merged = mergeRuleFiles(files) ?? "";
    expect(merged.length).toBeLessThan(
      files.reduce((n, f) => n + f.content.length, 0),
    );

    // With the duplicates gone the whole rule set fits, so the last file is
    // read at all.
    const kept = truncateProjectMemory(merged);
    expect(kept).not.toMatch(/truncated here/);
    expect(kept).toContain("# CLAUDE.md");

    // The naive join is the pre-fix behaviour, and it loses CLAUDE.md.
    const naive = files.map((f) => f.content).join("\n\n");
    const cutNaive = truncateProjectMemory(naive);
    expect(cutNaive).toMatch(/truncated here/);
    expect(cutNaive).not.toContain("# CLAUDE.md");
  });
});

// The fixed list has to guess spellings, and a guess only works on a filesystem
// that resolves case for you. Windows turns `Agents.md` into `AGENTS.md` by
// itself, so this whole class of bug is invisible there and shows up on Linux
// and macOS as "my project rules are ignored" with no error anywhere.
describe("resolveRuleFiles", () => {
  it("finds a spelling the fixed list cannot guess", () => {
    expect(resolveRuleFiles(["Agents.md", "README.md"])).toEqual(["Agents.md"]);
  });

  it("returns each family once for a listing with one real file per family", () => {
    expect(
      resolveRuleFiles(["AGENTS.md", "USER.md", "TERMIGO.md", "CLAUDE.md"]),
    ).toEqual(["USER.md", "AGENTS.md", "TERMIGO.md", "CLAUDE.md"]);
  });

  it("keeps both files when a case-sensitive root really has both", () => {
    expect(resolveRuleFiles(["AGENTS.md", "agents.md"])).toEqual([
      "AGENTS.md",
      "agents.md",
    ]);
  });

  it("picks deterministically when only non-exact spellings exist", () => {
    expect(resolveRuleFiles(["Termigo.md", "TERMIGO.MD"])).toEqual([
      "TERMIGO.MD",
    ]);
  });

  it("never returns a dot-prefixed name, which a listing cannot show", () => {
    expect(resolveRuleFiles([".termigorules"])).toEqual([]);
    expect(resolveRuleFiles([])).toEqual([]);
  });
});

describe("readProjectRules discovery", () => {
  it("delivers a rule file whose casing the list does not carry", async () => {
    readDir.mockResolvedValue([fileEntry("Agents.md")]);
    readFile.mockImplementation(async (path) => {
      if (path === "/case-sensitive/Agents.md") {
        return textRead("# Agents.md\nhouse rules here\n");
      }
      throw new Error("ENOENT");
    });

    await expect(readProjectRules("/case-sensitive")).resolves.toContain(
      "house rules here",
    );
    expect(readFile).toHaveBeenCalledWith("/case-sensitive/Agents.md");
  });

  it("falls back to the exact spellings when the root cannot be listed", async () => {
    readDir.mockRejectedValue(new Error("path is not accessible"));
    readFile.mockImplementation(async (path) => {
      if (path === "/no-listing/AGENTS.md") {
        return textRead("# AGENTS.md\nfallback rules here\n");
      }
      throw new Error("ENOENT");
    });

    await expect(readProjectRules("/no-listing")).resolves.toContain(
      "fallback rules here",
    );
  });
});

// Providers cache on an exact token prefix. The env block used to be merged
// into the last user message on the outgoing copy only, so the message that
// carried it on one turn arrived without it on the next - and the difference
// landed at the first user message, invalidating everything after it.
describe("appendEnvTurn", () => {
  const user = (id: string, text: string) =>
    ({ id, role: "user", parts: [{ type: "text", text }] }) as never;
  const assistant = (id: string, text: string) =>
    ({ id, role: "assistant", parts: [{ type: "text", text }] }) as never;

  const textOf = (m: { parts: unknown }) =>
    (m.parts as { type: string; text?: string }[])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");

  it("leaves every stored message untouched", () => {
    const history = [user("u1", "first"), assistant("a1", "reply")];
    const out = appendEnvTurn(history, "<env>\ncwd: /x\n</env>");
    expect(out.slice(0, 2)).toEqual(history);
  });

  it("puts the env last, where a change costs nothing", () => {
    const out = appendEnvTurn([user("u1", "hi")], "<env>\ncwd: /x\n</env>");
    expect(out).toHaveLength(2);
    expect(textOf(out[1])).toContain("<env>");
  });

  // The regression this exists to prevent: turn N+1 must repeat turn N's
  // history exactly, or the provider's cache starts from scratch every time.
  it("keeps the prefix identical from one turn to the next", () => {
    const env1 = "<env>\ncwd: /x\n</env>";
    const env2 = "<env>\ncwd: /y\n</env>";

    const turnN = appendEnvTurn([user("u1", "first")], env1);
    const turnNext = appendEnvTurn(
      [user("u1", "first"), assistant("a1", "reply"), user("u2", "second")],
      env2,
    );

    // Everything turn N sent before its env block reappears unchanged.
    expect(turnNext[0]).toEqual(turnN[0]);
  });

  it("does not fold the env into the user's own text", () => {
    const out = appendEnvTurn(
      [user("u1", "selamat malam")],
      "<env>\ncwd: /x\n</env>",
    );
    expect(textOf(out[0])).toBe("selamat malam");
  });
});

// The env turn is appended to every outgoing copy, so it decides what the last
// message is - and `collectToolApprovals` reads approvals from the last message
// only, requiring it to be the `tool` message that carries them:
//
//     const lastMessage = messages.at(-1);
//     if (lastMessage?.role != "tool") return { approvedToolApprovals: [] };
//
// With a user turn appended after it, `streamText` found no approval, never ran
// the approved command, and sent the provider an assistant `tool_calls` with
// nothing answering it. The user saw their approved command fail with "must be
// followed by tool messages responding to each tool_call_id".
describe("isResumingApproval", () => {
  const user = (id: string) =>
    ({ id, role: "user", parts: [{ type: "text", text: "hi" }] }) as never;
  const withTool = (id: string, state: string) =>
    ({
      id,
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-bash_run",
          state,
          toolCallId: "c1",
          input: { command: "which openclaw" },
          approval: { id: "ap1", approved: true },
        },
      ],
    }) as never;

  it("holds the env turn back while an approved call is waiting to run", () => {
    expect(
      isResumingApproval([user("u1"), withTool("a1", "approval-responded")]),
    ).toBe(true);
  });

  it("lets an ordinary continuation have it: results already end the history", () => {
    expect(
      isResumingApproval([user("u1"), withTool("a1", "output-available")]),
    ).toBe(false);
  });

  // Still waiting on the user, so nothing is being resumed and no request is
  // in flight for the env block to disturb.
  it("lets an unanswered approval have it", () => {
    expect(
      isResumingApproval([user("u1"), withTool("a1", "approval-requested")]),
    ).toBe(false);
  });

  it("lets a plain user turn have it", () => {
    expect(
      isResumingApproval([withTool("a1", "approval-responded"), user("u2")]),
    ).toBe(false);
  });

  it("lets an empty history have it", () => {
    expect(isResumingApproval([])).toBe(false);
  });
});

describe("formatEnvBlock", () => {
  it("formats remote SSH session when remoteSession is present", () => {
    const block = formatEnvBlock({
      cwd: "/srv/app",
      terminalPrivate: false,
      workspaceRoot: null,
      activeFile: null,
      goal: null,
      schedules: [],
      todos: [],
      remoteSession: {
        sessionId: 42,
        cwd: "/srv/app",
        hostLabel: "root@192.168.1.100",
      },
    });

    expect(block).not.toBeNull();
    expect(block).toContain("environment: remote SSH session");
    expect(block).toContain("remote_host: root@192.168.1.100");
    expect(block).toContain("os: Linux / POSIX remote host");
    expect(block).toContain("shell: bash/sh - POSIX syntax, forward slashes");
    expect(block).toContain("remote_cwd: /srv/app");
    expect(block).not.toContain("PowerShell");
  });

  it("formats local os environment when remoteSession is null", () => {
    const block = formatEnvBlock({
      cwd: "C:\\local\\project",
      terminalPrivate: false,
      workspaceRoot: "C:\\local\\project",
      activeFile: null,
      goal: null,
      schedules: [],
      todos: [],
      remoteSession: null,
    });

    expect(block).not.toBeNull();
    expect(block).not.toContain("environment: remote SSH session");
    expect(block).toContain("active_terminal_cwd: C:\\local\\project");
  });
});

// This repo's own TERMIGO.md is the agent's project memory, and only the first
// TERMIGO_MD_MAX_CHARS of it are sent. It had grown to 32 KB: the cut landed at
// line 88 of 188, so the entire AI subsystem section, the UI conventions and
// the known gotchas were invisible to the agent while still costing every
// reader who opened the file the impression that they were not.
//
// The file was restructured to fit, with the detail moved into docs/. That
// only stays true if something checks, so this does - a doc budget is not the
// kind of thing anyone remembers while writing a paragraph.
describe("TERMIGO.md fits the budget the agent actually receives", () => {
  it("is not silently truncated before it reaches the model", () => {
    const doc = readFileSync("TERMIGO.md", "utf8");
    expect(
      doc.length,
      `TERMIGO.md is ${doc.length} chars, over the ${TERMIGO_MD_MAX_CHARS} the ` +
        "agent receives. Everything past the cut is invisible to it. Move " +
        "detail into docs/architecture/ and leave a pointer, rather than " +
        "raising the cap: project memory is paid on every request.",
    ).toBeLessThanOrEqual(TERMIGO_MD_MAX_CHARS);
  });
});
