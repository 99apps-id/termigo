import { describe, expect, it } from "vitest";
import {
  isRemoteTarget,
  isWindowsPath,
  remoteUnsupported,
  routePath,
} from "./remoteFs";

const local = (p: string) => (p.startsWith("/") ? p : `C:/workspace/${p}`);
const session = { sessionId: 7, cwd: "/root/app" };

describe("isWindowsPath", () => {
  it("recognises drive paths in both slash styles", () => {
    expect(isWindowsPath("C:\\Users\\x")).toBe(true);
    expect(isWindowsPath("d:/projects")).toBe(true);
  });

  it("does not mistake a POSIX path for one", () => {
    expect(isWindowsPath("/etc/nginx")).toBe(false);
    expect(isWindowsPath("src/main.ts")).toBe(false);
  });
});

describe("routePath without a session", () => {
  it("stays local", () => {
    expect(routePath(null, "src/a.ts", local)).toEqual({
      kind: "local",
      path: "C:/workspace/src/a.ts",
    });
  });
});

describe("routePath with a session", () => {
  it("sends absolute POSIX paths to the remote host", () => {
    expect(routePath(session, "/etc/nginx/nginx.conf", local)).toEqual({
      kind: "remote",
      sessionId: 7,
      path: "/etc/nginx/nginx.conf",
    });
  });

  it("resolves a relative path against the remote cwd, not the local one", () => {
    expect(routePath(session, "config.yml", local)).toEqual({
      kind: "remote",
      sessionId: 7,
      path: "/root/app/config.yml",
    });
  });

  it("does not double the separator when the cwd already ends in one", () => {
    const t = routePath({ sessionId: 1, cwd: "/root/" }, "a.txt", local);
    expect(t).toMatchObject({ path: "/root/a.txt" });
  });

  // A Windows path cannot mean anything on a POSIX host, so it is the one case
  // that still refers to this machine while a session is open.
  it("keeps Windows drive paths local", () => {
    expect(routePath(session, "C:\\temp\\notes.txt", local)).toEqual({
      kind: "local",
      path: "C:/workspace/C:\\temp\\notes.txt",
    });
  });

  // Guessing a base would mean writing to an arbitrary remote directory.
  it("refuses a relative path before the shell has reported a cwd", () => {
    const t = routePath({ sessionId: 3, cwd: null }, "a.txt", local);
    expect(t.kind).toBe("error");
    expect(t.kind === "error" && t.reason).toContain("absolute remote path");
  });
});

// The property this whole module exists for: with a session open, a path is
// either handled remotely or reported as an error. It is never quietly turned
// into a local path, which is how an agent ends up reading a server's config
// and writing the edit to the user's own disk.
describe("no silent local fallback", () => {
  it("never routes a POSIX path to the local machine while connected", () => {
    for (const p of ["/etc/passwd", "relative/file.txt", "./x", "../y"]) {
      const t = routePath(session, p, local);
      expect(t.kind).not.toBe("local");
    }
  });

  it("routes those same paths locally once the session is gone", () => {
    for (const p of ["/etc/passwd", "relative/file.txt"]) {
      expect(routePath(null, p, local).kind).toBe("local");
    }
  });
});

describe("remoteUnsupported", () => {
  it("names the operation and offers a way forward", () => {
    const out = remoteUnsupported("copy_file", "Use bash_run instead.");
    expect(out.error).toContain("copy_file");
    expect(out.error).toContain("Use bash_run instead.");
    // A bare failure would leave the model guessing whether to retry.
    expect(out.error).toContain("local machine");
  });
});

describe("isRemoteTarget", () => {
  it("narrows to the remote case only", () => {
    expect(isRemoteTarget(routePath(session, "/a", local))).toBe(true);
    expect(isRemoteTarget(routePath(null, "/a", local))).toBe(false);
  });
});
