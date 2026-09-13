// The names in here are the whole risk of this package: nothing fails loudly
// when one is wrong, the download just 404s and the release looks broken. So
// the mapping is checked against a release that really is published, in both
// directions, and a change to the CI matrix shows up as a failing test rather
// than as a bug report from someone who cannot install.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { FORMATS_BY_PLATFORM, findAsset, resolveArtifact } from "../src/target.mjs";

/** Every asset of release v0.9.11, copied from the GitHub API. */
const PUBLISHED = [
  "Termigo-0.9.11-1.x86_64.rpm",
  "Termigo_0.9.11_aarch64.app.tar.gz",
  "Termigo_0.9.11_aarch64.dmg",
  "Termigo_0.9.11_amd64.AppImage",
  "Termigo_0.9.11_amd64.deb",
  "Termigo_0.9.11_x64-setup.exe",
  "Termigo_0.9.11_x64.app.tar.gz",
  "Termigo_0.9.11_x64.dmg",
  "Termigo_0.9.11_x64_en-US.msi",
];

const VERSION = "0.9.11";

/** Consumed by the app's own auto-updater; never installed by hand. */
const UPDATER = PUBLISHED.filter((n) => n.endsWith(".app.tar.gz"));

/** Combinations a user's machine can actually resolve to. */
const OFFERED = [
  { platform: "win32", arch: "x64" },
  { platform: "darwin", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "linux", arch: "x64" },
];

function everyOffered() {
  const out = [];
  for (const { platform, arch } of OFFERED) {
    for (const format of FORMATS_BY_PLATFORM[platform]) {
      out.push(resolveArtifact({ platform, arch, format, version: VERSION }));
    }
  }
  return out;
}

describe("artifact names", () => {
  it("produces a name that is really in the release, for every combination offered", () => {
    for (const artifact of everyOffered()) {
      assert.ok(
        PUBLISHED.includes(artifact.name),
        `${artifact.id} builds "${artifact.name}", which v${VERSION} does not contain`,
      );
    }
  });

  // The direction that catches ADDITIONS: a format the workflow starts
  // publishing but this map never learns about is a build nobody can install.
  it("covers every installable file the release publishes", () => {
    const produced = new Set(everyOffered().map((a) => a.name));
    const installable = PUBLISHED.filter((n) => !UPDATER.includes(n));
    assert.deepEqual([...produced].sort(), [...installable].sort());
  });

  it("does not claim the auto-updater bundles", () => {
    const produced = new Set(everyOffered().map((a) => a.name));
    for (const bundle of UPDATER) {
      assert.ok(!produced.has(bundle), `${bundle} should never be installed by hand`);
    }
  });

  // Linux is the one platform where the architecture is spelled differently by
  // format, which is exactly the case a single template gets wrong.
  it("spells amd64 and x86_64 the way Linux artifacts really do", () => {
    const appimage = resolveArtifact({
      platform: "linux",
      arch: "x64",
      format: "appimage",
      version: VERSION,
    });
    const rpm = resolveArtifact({
      platform: "linux",
      arch: "x64",
      format: "rpm",
      version: VERSION,
    });
    assert.equal(appimage.name, "Termigo_0.9.11_amd64.AppImage");
    assert.equal(rpm.name, "Termigo-0.9.11-1.x86_64.rpm");
  });

  it("points at the versioned download path", () => {
    const a = resolveArtifact({
      platform: "darwin",
      arch: "arm64",
      version: VERSION,
    });
    assert.equal(
      a.url,
      "https://github.com/99apps-id/termigo/releases/download/v0.9.11/Termigo_0.9.11_aarch64.dmg",
    );
  });
});

describe("default formats", () => {
  // The default has to be the one needing least from the user: an AppImage
  // needs no root, a deb or an rpm does.
  it("defaults to the format that asks least of the user", () => {
    const pick = (platform, arch) =>
      resolveArtifact({ platform, arch, version: VERSION }).format;
    assert.equal(pick("linux", "x64"), "appimage");
    assert.equal(pick("win32", "x64"), "msi");
    assert.equal(pick("darwin", "x64"), "dmg");
  });

  it("explains which architectures are published instead of just failing", () => {
    assert.throws(
      () => resolveArtifact({ platform: "linux", arch: "arm64", version: VERSION }),
      (e) => /not published/.test(e.message) && /x64/.test(e.message),
    );
    assert.throws(
      () => resolveArtifact({ platform: "win32", arch: "arm64", version: VERSION }),
      /not published/,
    );
  });

  it("names the formats that exist when one does not", () => {
    assert.throws(
      () => resolveArtifact({ platform: "linux", arch: "x64", format: "dmg", version: VERSION }),
      /not published for linux; available: appimage, deb, rpm/,
    );
  });

  it("rejects a platform and a version it cannot serve", () => {
    assert.throws(
      () => resolveArtifact({ platform: "freebsd", arch: "x64", version: VERSION }),
      /unsupported platform/,
    );
    assert.throws(
      () => resolveArtifact({ platform: "linux", arch: "x64", version: "latest" }),
      /not a usable release version/,
    );
    assert.throws(
      () => resolveArtifact({ platform: "linux", arch: "riscv64", version: VERSION }),
      /unsupported architecture/,
    );
  });
});

describe("findAsset", () => {
  // 0.9.1 is a prefix of 0.9.11, so a substring match would hand a user who
  // pinned v0.9.1 the v0.9.11 build. The file is intact, so the checksum cannot
  // catch it - the only defence is matching the name exactly.
  it("does not match a version that is a prefix of another", () => {
    const assets = [{ name: "Termigo_0.9.11_x64.dmg" }];
    assert.throws(
      () => findAsset(assets, "Termigo_0.9.1_x64.dmg"),
      /no asset named/,
    );
    assert.equal(findAsset(assets, "Termigo_0.9.11_x64.dmg").name, "Termigo_0.9.11_x64.dmg");
  });

  it("lists what the release does have when the name is wrong", () => {
    assert.throws(
      () => findAsset([{ name: "a.deb" }, { name: "b.rpm" }], "c.msi"),
      (e) => /a\.deb/.test(e.message) && /b\.rpm/.test(e.message),
    );
  });
});
