import { describe, expect, it, vi } from "vitest";

const rename = vi.fn();
const copyInto = vi.fn();
const deletePath = vi.fn();
const canonicalize = vi.fn(async (p: string) => p);

const sftpRename = vi.fn();
const sftpDelete = vi.fn();
vi.mock("@/modules/ssh/sftp", () => ({
  sftpRename: (...a: unknown[]) => sftpRename(...a),
  sftpDelete: (...a: unknown[]) => sftpDelete(...a),
}));

vi.mock("../lib/native", () => ({
  native: {
    rename: (...a: unknown[]) => rename(...a),
    copyInto: (...a: unknown[]) => copyInto(...a),
    deletePath: (...a: unknown[]) => deletePath(...a),
    canonicalize: (p: string) => canonicalize(p),
  },
}));

import { buildFileOpsTools } from "./fileops";
import type { ToolContext } from "./context";

const ctx = {
  getCwd: () => "/workspace",
  getRemoteSession: () => null,
  getWorkspaceRoot: () => "/workspace",
} as unknown as ToolContext;

const tools = buildFileOpsTools(ctx);

function run(name: keyof typeof tools, args: unknown) {
  const t = tools[name] as unknown as {
    execute: (a: unknown, o: unknown) => Promise<unknown>;
  };
  return t.execute(args, {});
}

describe("move_file", () => {
  it("renames and reports both ends", async () => {
    rename.mockResolvedValue(undefined);
    const out = await run("move_file", { from: "a.txt", to: "b.txt" });
    expect(out).toMatchObject({ moved: true });
    expect(rename).toHaveBeenCalledWith("/workspace/a.txt", "/workspace/b.txt");
  });

  // Checking only one end would let a move take a file from anywhere, or drop
  // one somewhere it may not go.
  it("refuses a denied source", async () => {
    const out = await run("move_file", { from: "../../.ssh/id_rsa", to: "k.txt" });
    expect(out).toHaveProperty("error");
    expect(rename).not.toHaveBeenCalledWith(
      expect.stringContaining("id_rsa"),
      expect.anything(),
    );
  });

  it("refuses a denied destination", async () => {
    rename.mockClear();
    const out = await run("move_file", { from: "a.txt", to: "../../.ssh/authorized_keys" });
    expect(out).toHaveProperty("error");
    expect(rename).not.toHaveBeenCalled();
  });

  it("returns a backend failure instead of throwing", async () => {
    rename.mockRejectedValue(new Error("already exists: /workspace/b.txt"));
    const out = await run("move_file", { from: "a.txt", to: "b.txt" });
    expect(String((out as { error: string }).error)).toContain("already exists");
  });
});

describe("copy_file", () => {
  it("copies into the directory and reports where it landed", async () => {
    copyInto.mockResolvedValue(undefined);
    const out = await run("copy_file", { source: "src/a.txt", dest_dir: "backup" });
    // The tool takes a directory, so without this the model has to guess the
    // resulting path.
    expect(out).toMatchObject({
      copied: true,
      to: "/workspace/backup/a.txt",
    });
  });

  it("refuses a denied source", async () => {
    copyInto.mockClear();
    const out = await run("copy_file", { source: "../../.env", dest_dir: "backup" });
    expect(out).toHaveProperty("error");
    expect(copyInto).not.toHaveBeenCalled();
  });
});

describe("delete_file", () => {
  it("deletes an allowed path", async () => {
    deletePath.mockResolvedValue(undefined);
    const out = await run("delete_file", { path: "junk.txt" });
    expect(out).toMatchObject({ deleted: true, path: "/workspace/junk.txt" });
  });

  it("refuses a path the safety layer denies", async () => {
    deletePath.mockClear();
    const out = await run("delete_file", { path: "../../.ssh/id_rsa" });
    expect(out).toHaveProperty("error");
    expect(deletePath).not.toHaveBeenCalled();
  });

  it("returns a backend failure instead of throwing", async () => {
    deletePath.mockRejectedValue(new Error("permission denied"));
    const out = await run("delete_file", { path: "locked.txt" });
    expect(String((out as { error: string }).error)).toContain("permission denied");
  });
});

describe("approval", () => {
  it("every file operation asks before running", () => {
    for (const name of ["move_file", "copy_file", "delete_file"] as const) {
      expect((tools[name] as unknown as { needsApproval: boolean }).needsApproval).toBe(
        true,
      );
    }
  });
});

// With a session open every tool must either act on the remote host or say it
// cannot. Quietly acting locally is how an agent ends up moving the wrong
// machine's files.
describe("with an SSH session open", () => {
  const remoteCtx = {
    getCwd: () => "/workspace",
    getRemoteSession: () => ({ sessionId: 5, cwd: "/srv/app" }),
    getWorkspaceRoot: () => "/workspace",
  } as unknown as ToolContext;
  const remoteTools = buildFileOpsTools(remoteCtx);

  function runRemote(name: keyof typeof remoteTools, args: unknown) {
    const t = remoteTools[name] as unknown as {
      execute: (a: unknown, o: unknown) => Promise<unknown>;
    };
    return t.execute(args, {});
  }

  it("moves on the remote host, not locally", async () => {
    rename.mockClear();
    sftpRename.mockResolvedValue(undefined);
    const out = await runRemote("move_file", { from: "a.txt", to: "b.txt" });
    expect(out).toMatchObject({ moved: true, remote: true });
    expect(sftpRename).toHaveBeenCalledWith(5, "/srv/app/a.txt", "/srv/app/b.txt");
    expect(rename).not.toHaveBeenCalled();
  });

  it("deletes on the remote host, not locally", async () => {
    deletePath.mockClear();
    sftpDelete.mockResolvedValue(undefined);
    const out = await runRemote("delete_file", { path: "junk.log" });
    expect(out).toMatchObject({ deleted: true, remote: true });
    expect(sftpDelete).toHaveBeenCalledWith(5, "/srv/app/junk.log");
    expect(deletePath).not.toHaveBeenCalled();
  });

  // A move across machines would be a download-then-upload wearing a rename's
  // name, with none of a rename's atomicity.
  it("refuses a move that would cross machines", async () => {
    sftpRename.mockClear();
    const out = await runRemote("move_file", { from: "a.txt", to: "C:/temp/b.txt" });
    expect(String((out as { error: string }).error)).toContain("same one");
    expect(sftpRename).not.toHaveBeenCalled();
  });

  // SFTP has no server-side copy; doing it by hand would move every byte
  // through this machine, and would be wrong for directories.
  it("refuses to copy rather than pretending", async () => {
    copyInto.mockClear();
    const out = await runRemote("copy_file", { source: "a", dest_dir: "b" });
    expect(String((out as { error: string }).error)).toContain("copy_file");
    expect(copyInto).not.toHaveBeenCalled();
  });
});
