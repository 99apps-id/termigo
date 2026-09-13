// Installing the companion is a filesystem operation with a PATH check, and the
// PATH check is the part that decides whether the feature appears to work at
// all: a command that is installed but not findable by name looks broken.

import { strict as assert } from "node:assert";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  companionDir,
  companionInstalled,
  companionName,
  companionPath,
  installCompanion,
  isOnPath,
} from "../src/install.mjs";

describe("companionName", () => {
  // Never `termigo`: that name is the installer's own command.
  it("is named termigo-go so it cannot shadow the installer", () => {
    assert.equal(companionName({ platform: "linux", arch: "x64" }), "termigo-go");
    assert.equal(companionName({ platform: "darwin", arch: "arm64" }), "termigo-go");
    assert.equal(companionName({ platform: "win32", arch: "x64" }), "termigo-go.exe");
  });
});

describe("companionDir", () => {
  it("uses the per-user bin directory on Unix", () => {
    const dir = companionDir({ platform: "linux", env: {} });
    assert.match(dir.replace(/\\/g, "/"), /\/\.local\/bin$/);
  });

  // No privileges and no shared location on Windows: it goes beside what the
  // installer already creates for this user.
  it("uses a per-user programs directory on Windows", () => {
    const dir = companionDir({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" },
    });
    assert.match(dir.replace(/\\/g, "/"), /AppData\/Local\/Programs\/termigo-cli$/);
  });

  it("says so rather than throwing a path error when LOCALAPPDATA is absent", () => {
    assert.throws(
      () => companionDir({ platform: "win32", env: {} }),
      /LOCALAPPDATA is not set/,
    );
  });
});

describe("isOnPath", () => {
  it("finds a directory on a Unix PATH", () => {
    assert.equal(
      isOnPath("/home/u/.local/bin", {
        platform: "linux",
        env: { PATH: "/usr/bin:/home/u/.local/bin:/bin" },
      }),
      true,
    );
  });

  // A trailing separator in PATH is common and means the same directory.
  it("ignores a trailing separator on either side", () => {
    assert.equal(
      isOnPath("/home/u/.local/bin/", {
        platform: "linux",
        env: { PATH: "/usr/bin:/home/u/.local/bin/" },
      }),
      true,
    );
  });

  // Windows compares case-insensitively and reads PATH from `Path`.
  it("matches case-insensitively on Windows and reads Path", () => {
    assert.equal(
      isOnPath("C:\\Users\\X\\AppData\\Local\\Programs\\termigo-cli", {
        platform: "win32",
        env: { Path: "C:\\Windows;C:\\Users\\x\\AppData\\Local\\Programs\\Termigo-CLI" },
      }),
      true,
    );
  });

  it("is false when the directory is genuinely absent", () => {
    assert.equal(
      isOnPath("/opt/termigo", { platform: "linux", env: { PATH: "/usr/bin:/bin" } }),
      false,
    );
    assert.equal(
      isOnPath("/opt/termigo", { platform: "linux", env: {} }),
      false,
    );
  });

  // A prefix of a real entry must not count as a match: /home/u/.local/bin2 is
  // a different directory, and reporting it as on PATH would suppress the one
  // warning the user needs.
  it("does not match a directory that merely starts the same", () => {
    assert.equal(
      isOnPath("/home/u/.local/bin", {
        platform: "linux",
        env: { PATH: "/home/u/.local/bin2:/usr/bin" },
      }),
      false,
    );
  });
});

describe("installCompanion", () => {
  it("copies the verified file into place and reports the PATH situation", async () => {
    const home = await mkdtemp(join(tmpdir(), "termigo-companion-"));
    const src = join(home, "downloaded");
    await writeFile(src, "not really a binary");

    const result = await installCompanion({
      file: src,
      platform: "win32",
      arch: "x64",
      env: { LOCALAPPDATA: home, Path: "C:\\Windows" },
    });

    assert.equal(await readFile(result.path, "utf8"), "not really a binary");
    assert.match(result.path.replace(/\\/g, "/"), /termigo-go\.exe$/);
    assert.equal(result.onPath, false, "a temp directory is not on PATH");
  });

  it("reports onPath true when the directory is already on PATH", async () => {
    const home = await mkdtemp(join(tmpdir(), "termigo-companion-"));
    const src = join(home, "downloaded");
    await writeFile(src, "x");
    const dir = companionDir({ platform: "win32", env: { LOCALAPPDATA: home } });

    const result = await installCompanion({
      file: src,
      platform: "win32",
      arch: "x64",
      env: { LOCALAPPDATA: home, Path: `C:\\Windows;${dir}` },
    });

    assert.equal(result.onPath, true);
    // And it is really a file, not just a reported success.
    assert.ok((await stat(result.path)).size > 0);
  });
});

describe("companionInstalled", () => {
  // This check is what keeps the everyday case - the app is installed, open it -
  // from making a network call, or failing offline, on every invocation.
  it("is false before an install and true after one", async () => {
    const home = await mkdtemp(join(tmpdir(), "termigo-companion-"));
    const env = { LOCALAPPDATA: home, Path: "C:\\Windows" };
    const target = { platform: "win32", arch: "x64", env };

    assert.equal(await companionInstalled(target), false);
    assert.match(companionPath(target).replace(/\\/g, "/"), /termigo-go\.exe$/);

    const src = join(home, "downloaded");
    await writeFile(src, "x");
    await installCompanion({ file: src, platform: "win32", arch: "x64", env });

    assert.equal(await companionInstalled(target), true);
  });

  it("is false rather than throwing when the directory does not exist", async () => {
    assert.equal(
      await companionInstalled({
        platform: "win32",
        arch: "x64",
        env: { LOCALAPPDATA: join(tmpdir(), "definitely-absent-termigo-xyz") },
      }),
      false,
    );
  });
});
