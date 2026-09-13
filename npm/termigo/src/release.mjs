// Talking to GitHub: which version is current, where its files are, and
// whether the bytes that arrived are the bytes that were published.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { REPO } from "./target.mjs";

const API = `https://api.github.com/repos/${REPO}`;

/**
 * The version of the newest release, without the leading `v`.
 *
 * This follows the `/releases/latest` redirect instead of calling the API. The
 * API is rate-limited per ADDRESS (60 requests an hour with no token), so a
 * shared office NAT can exhaust it through no fault of the user, and a
 * rate-limited answer here would look like "Termigo has no releases". The
 * redirect is an ordinary web request and is not limited that way.
 */
export async function latestVersion(fetchImpl = fetch) {
  const res = await fetchImpl(`https://github.com/${REPO}/releases/latest`, {
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`cannot resolve the latest release: HTTP ${res.status}`);
  }
  // The final URL is .../releases/tag/v0.9.11 - the tag is the version. The
  // response body is a full HTML page, which is why the URL is read instead.
  const tag = /\/releases\/tag\/v([^/?#]+)/.exec(res.url ?? "")?.[1];
  if (!tag) {
    throw new Error(`cannot read a version out of ${res.url}`);
  }
  return tag;
}

/**
 * Every asset of one release, with the checksum GitHub publishes for it.
 *
 * GitHub computes a sha256 per asset and serves it as `digest`, which is the
 * only checksum source that needs no cooperation from the release workflow -
 * there is no SHA256SUMS file here to look for. It is absent on older releases,
 * so callers must treat a missing digest as "not verifiable", not as "fine".
 */
export async function releaseAssets(version, fetchImpl = fetch) {
  const res = await fetchImpl(`${API}/releases/tags/v${version}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (res.status === 404) {
    throw new Error(`no release tagged v${version}`);
  }
  if (!res.ok) {
    throw new Error(
      `cannot read the release list: HTTP ${res.status}` +
        (res.status === 403 ? " (GitHub's unauthenticated rate limit)" : ""),
    );
  }
  const body = await res.json();
  return (body.assets ?? []).map((a) => ({
    name: a.name,
    url: a.browser_download_url,
    size: a.size,
    // "sha256:ab12..." -> "ab12..."
    sha256: a.digest?.startsWith("sha256:") ? a.digest.slice(7) : null,
  }));
}

/** The sha256 of a file on disk, lowercase hex. */
export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/**
 * Download a URL to a path, creating parents.
 *
 * Streams rather than buffering: the Linux AppImage is ~100 MB, and holding
 * that in memory to write it once is a pointless way to fail on a small VPS.
 */
export async function download(url, dest, { fetchImpl = fetch, onProgress } = {}) {
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status} ${url}`);
  }
  const total = Number(res.headers.get("content-length")) || 0;

  await mkdir(dirname(dest), { recursive: true });
  const partial = `${dest}.part`;
  let seen = 0;

  const counting = new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      onProgress?.(seen, total);
      controller.enqueue(chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(res.body.pipeThrough(counting)),
      createWriteStream(partial),
    );
    // Rename only after the whole body landed. A truncated file wearing the
    // final name is worse than no file, because the next step would install it.
    await rename(partial, dest);
  } catch (e) {
    await rm(partial, { force: true });
    throw e;
  }

  const { size } = await stat(dest);
  return { path: dest, size, expectedSize: total };
}

/** Compare a file against an expected sha256. Returns null when unverifiable. */
export function verify(fileSha, expectedSha) {
  if (!expectedSha) return null;
  return fileSha.toLowerCase() === expectedSha.toLowerCase();
}
