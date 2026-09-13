// The network and checksum layer, driven by stub fetches so the tests say
// something about the parsing rather than about GitHub being up.

import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  download,
  latestVersion,
  releaseAssets,
  sha256File,
  verify,
} from "../src/release.mjs";

/** A fetch that answers with one canned response and records what it was asked. */
function stubFetch(response) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return typeof response === "function" ? response(url, init) : response;
  };
  fn.calls = calls;
  return fn;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("latestVersion", () => {
  // The version is read off the redirect's final URL, not the API: the API is
  // rate-limited per address, and a 403 there would read as "no releases".
  it("reads the tag out of the redirect target", async () => {
    const fetchImpl = stubFetch({
      ok: true,
      url: "https://github.com/99apps-id/termigo/releases/tag/v0.9.11",
    });
    assert.equal(await latestVersion(fetchImpl), "0.9.11");
    assert.equal(
      fetchImpl.calls[0].url,
      "https://github.com/99apps-id/termigo/releases/latest",
    );
  });

  it("refuses a response that is not a tag page", async () => {
    await assert.rejects(
      latestVersion(stubFetch({ ok: true, url: "https://github.com/99apps-id/termigo" })),
      /cannot read a version/,
    );
  });

  it("reports the status when the request fails", async () => {
    await assert.rejects(
      latestVersion(stubFetch({ ok: false, status: 503, url: "" })),
      /HTTP 503/,
    );
  });
});

describe("releaseAssets", () => {
  // GitHub computes a sha256 per asset and serves it as `digest`; there is no
  // SHA256SUMS file in these releases to look for.
  it("keeps the checksum and strips its algorithm prefix", async () => {
    const assets = await releaseAssets(
      "0.9.11",
      stubFetch(
        json({
          assets: [
            {
              name: "Termigo_0.9.11_x64.dmg",
              browser_download_url: "https://example.test/a.dmg",
              size: 14708276,
              digest: "sha256:abc123",
            },
          ],
        }),
      ),
    );
    assert.deepEqual(assets, [
      {
        name: "Termigo_0.9.11_x64.dmg",
        url: "https://example.test/a.dmg",
        size: 14708276,
        sha256: "abc123",
      },
    ]);
  });

  // An older release has no digest at all, and "no checksum" must not arrive as
  // something that reads like a valid one.
  it("reports a missing checksum as missing, not as an empty string", async () => {
    const [asset] = await releaseAssets(
      "0.9.0",
      stubFetch(json({ assets: [{ name: "a.msi", browser_download_url: "u", size: 1 }] })),
    );
    assert.equal(asset.sha256, null);
  });

  it("distinguishes a missing release from a rate limit", async () => {
    await assert.rejects(
      releaseAssets("1.2.3", stubFetch(json({}, 404))),
      /no release tagged v1\.2\.3/,
    );
    await assert.rejects(
      releaseAssets("1.2.3", stubFetch(json({}, 403))),
      /rate limit/,
    );
  });
});

describe("verify", () => {
  // null, not false: a caller must decide what an unverifiable download means
  // rather than receive a "false" that looks like a mismatch.
  it("returns null when there is nothing to compare against", () => {
    assert.equal(verify("abc", null), null);
    assert.equal(verify("abc", undefined), null);
  });

  it("compares case-insensitively", () => {
    assert.equal(verify("ABC123", "abc123"), true);
  });

  it("is false on a real mismatch", () => {
    assert.equal(verify("abc123", "def456"), false);
  });
});

describe("sha256File", () => {
  it("matches the well-known hash of an empty file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "termigo-sha-"));
    const path = join(dir, "empty");
    await writeFile(path, "");
    assert.equal(
      await sha256File(path),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes more than the first chunk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "termigo-sha-"));
    const path = join(dir, "big");
    // Larger than one read chunk, so a loop that hashes only the first pass
    // gives a different answer.
    await writeFile(path, Buffer.alloc(256 * 1024, 7));
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update(Buffer.alloc(256 * 1024, 7)).digest("hex");
    assert.equal(await sha256File(path), expected);
  });
});

describe("download", () => {
  it("writes the body and leaves no part file behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "termigo-dl-"));
    const dest = join(dir, "nested", "app.bin");
    const body = Buffer.from("termigo payload");
    const fetchImpl = stubFetch(new Response(body));

    const seen = [];
    const { size } = await download("https://example.test/app.bin", dest, {
      fetchImpl,
      onProgress: (s) => seen.push(s),
    });

    assert.equal(size, body.byteLength);
    assert.equal(await readFile(dest, "utf8"), "termigo payload");
    assert.ok(seen.length > 0, "progress should be reported");
    assert.deepEqual(await readdir(join(dir, "nested")), ["app.bin"]);
  });

  it("fails loudly on a bad status instead of writing a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "termigo-dl-"));
    await assert.rejects(
      download("https://example.test/x", join(dir, "x"), {
        fetchImpl: stubFetch(new Response("nope", { status: 404 })),
      }),
      /HTTP 404/,
    );
    assert.deepEqual(await readdir(dir), []);
  });
});
