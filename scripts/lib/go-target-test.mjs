// The mapping is the only place a 404 can be born, and a wrongly named asset is
// invisible until somebody tries to download it. So every triple the project
// claims to support is pinned here.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  goAssetName,
  hostTripleNames,
  resolveGoTarget,
} from "./go-target.mjs";

describe("resolveGoTarget", () => {
  it("maps every triple the release matrix builds", () => {
    const matrix = [
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
      "x86_64-pc-windows-msvc",
      "aarch64-pc-windows-msvc",
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu",
    ];
    for (const triple of matrix) {
      const t = resolveGoTarget(triple);
      assert.ok(t.goos, `${triple} produced no GOOS`);
      assert.ok(t.goarch, `${triple} produced no GOARCH`);
      assert.ok(t.platform, `${triple} produced no node platform`);
      assert.ok(t.arch, `${triple} produced no node arch`);
    }
  });

  // The three vocabularies must not be conflated: Go says amd64 where Node says
  // x64, and getting that wrong is a 404 rather than a compile error.
  it("keeps Go's and Node's words for the same machine apart", () => {
    const t = resolveGoTarget("x86_64-apple-darwin");
    assert.equal(t.goos, "darwin");
    assert.equal(t.goarch, "amd64");
    assert.equal(t.platform, "darwin");
    assert.equal(t.arch, "x64");
  });

  it("only puts .exe on Windows", () => {
    assert.equal(resolveGoTarget("x86_64-pc-windows-msvc").ext, ".exe");
    assert.equal(resolveGoTarget("x86_64-unknown-linux-gnu").ext, "");
    assert.equal(resolveGoTarget("aarch64-apple-darwin").ext, "");
  });

  // The release matrix sends an empty triple for the Linux and Windows legs.
  it("treats an empty triple as the host", () => {
    assert.deepEqual(resolveGoTarget(""), hostTripleNames());
    assert.deepEqual(resolveGoTarget(null), hostTripleNames());
    assert.deepEqual(resolveGoTarget("   "), hostTripleNames());
  });

  // A silent fallback to the host would ship a correctly-named, useless binary.
  it("refuses an unknown triple instead of guessing", () => {
    assert.throws(
      () => resolveGoTarget("riscv64-unknown-linux-gnu"),
      (e) => /no Go target mapping/.test(e.message) && /known triples/.test(e.message),
    );
  });
});

describe("goAssetName", () => {
  // The name is built from NODE's vocabulary so the downloader never has to
  // translate: it has process.platform and process.arch and nothing else.
  it("names the asset in Node's vocabulary", () => {
    assert.equal(
      goAssetName(resolveGoTarget("x86_64-pc-windows-msvc")),
      "termigo-go-win32-x64.exe",
    );
    assert.equal(
      goAssetName(resolveGoTarget("aarch64-apple-darwin")),
      "termigo-go-darwin-arm64",
    );
    assert.equal(
      goAssetName(resolveGoTarget("x86_64-unknown-linux-gnu")),
      "termigo-go-linux-x64",
    );
  });

  it("gives every supported target a distinct name", () => {
    const triples = [
      "x86_64-pc-windows-msvc",
      "aarch64-pc-windows-msvc",
      "x86_64-apple-darwin",
      "aarch64-apple-darwin",
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu",
      "x86_64-unknown-linux-musl",
      "aarch64-unknown-linux-musl",
    ];
    const names = triples.map((t) => goAssetName(resolveGoTarget(t)));
    // The two musl triples deliberately share a name with their gnu siblings:
    // the Go binary is static, so glibc and musl get the same file.
    assert.equal(new Set(names).size, 6);
  });

  // Deliberate sharing, not an oversight: with CGO off, Go never links the C
  // toolchain, so the MSVC and GNU Windows toolchains produce the same binary
  // and a developer on either should find the asset under one name.
  it("shares one asset between the MSVC and GNU Windows toolchains", () => {
    assert.equal(
      goAssetName(resolveGoTarget("x86_64-pc-windows-gnu")),
      goAssetName(resolveGoTarget("x86_64-pc-windows-msvc")),
    );
    assert.equal(
      goAssetName(resolveGoTarget("aarch64-pc-windows-gnullvm")),
      goAssetName(resolveGoTarget("aarch64-pc-windows-msvc")),
    );
  });
});
