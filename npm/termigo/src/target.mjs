// Which release asset belongs to this machine.
//
// The CI matrix names every asset after the runner that produced it, and the
// three platforms do not agree on how the architecture is spelled: macOS and
// Windows use `x64` / `aarch64`, while Linux uses `amd64` for the AppImage and
// the deb and `x86_64` - behind a dash, not an underscore - for the rpm
// (`Termigo-0.9.11-1.x86_64.rpm`). Deriving the name from one template
// therefore produces a 404 on two platforms out of three, and that failure
// reads as "the release is broken" rather than "the name is wrong".
//
// So the mapping is written out, and a test pins every entry against the asset
// list of a release that really is published. When the CI matrix gains a target
// the test is what notices.

export const REPO = "99apps-id/termigo";

/** Where a release's assets live, given a version without its leading `v`. */
export function assetUrl(version, name) {
  return `https://github.com/${REPO}/releases/download/v${version}/${name}`;
}

/**
 * One installable artifact: how to name it, and how it gets installed.
 *
 * `how` is deliberately not the file extension. An MSI and an NSIS setup are
 * both `.exe`-adjacent Windows installers with different silent flags, and the
 * AppImage and the deb are both Linux files that install in completely
 * different ways (one needs no privileges at all, the other needs root).
 */
const ARTIFACTS = {
  "win32-x64-msi": {
    how: "msi",
    name: (v) => `Termigo_${v}_x64_en-US.msi`,
  },
  "win32-x64-nsis": {
    how: "nsis",
    name: (v) => `Termigo_${v}_x64-setup.exe`,
  },
  "darwin-x64-dmg": {
    how: "dmg",
    name: (v) => `Termigo_${v}_x64.dmg`,
  },
  "darwin-arm64-dmg": {
    how: "dmg",
    name: (v) => `Termigo_${v}_aarch64.dmg`,
  },
  "linux-x64-appimage": {
    how: "appimage",
    name: (v) => `Termigo_${v}_amd64.AppImage`,
  },
  "linux-x64-deb": {
    how: "deb",
    name: (v) => `Termigo_${v}_amd64.deb`,
  },
  "linux-x64-rpm": {
    how: "rpm",
    name: (v) => `Termigo-${v}-1.x86_64.rpm`,
  },
};

/**
 * Formats worth offering per platform, most-preferred first.
 *
 * The default is the one that asks least of whoever runs the command: an
 * AppImage installs into the home directory with no root, and the dmg is the
 * only macOS artifact that produces a launchable app. A deb or an rpm needs
 * sudo, so it is a choice rather than a default.
 */
export const FORMATS_BY_PLATFORM = {
  win32: ["msi", "nsis"],
  darwin: ["dmg"],
  linux: ["appimage", "deb", "rpm"],
};

/** Node reports `arm64` for both Apple silicon and Linux on ARM. */
const KNOWN_ARCHES = ["x64", "arm64"];

/**
 * The artifact for a platform/arch/format, or a reason it does not exist.
 *
 * The failure carries the choices that WOULD work instead of only the one that
 * did not: "no arm64 build of Linux" is a dead end, while "Linux on arm64 is
 * not published; available for linux: x64 (appimage, deb, rpm)" at least tells
 * the user whether the machine or the format is the problem.
 */
export function resolveArtifact({ platform, arch, format, version }) {
  if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`not a usable release version: ${version}`);
  }
  if (!KNOWN_ARCHES.includes(arch)) {
    throw new Error(
      `unsupported architecture: ${arch} (releases carry ${KNOWN_ARCHES.join(" and ")} only)`,
    );
  }

  const formats = FORMATS_BY_PLATFORM[platform];
  if (!formats) {
    throw new Error(
      `unsupported platform: ${platform} (releases carry ${Object.keys(FORMATS_BY_PLATFORM).join(", ")})`,
    );
  }
  if (format && !formats.includes(format)) {
    throw new Error(
      `format "${format}" is not published for ${platform}; available: ${formats.join(", ")}`,
    );
  }

  const chosen = format ?? formats[0];
  const id = `${platform}-${arch}-${chosen}`;
  const artifact = ARTIFACTS[id];
  if (!artifact) {
    // The platform is real and the format is real, so the only thing left is
    // the architecture - which is exactly what has no build.
    throw new Error(
      `${platform} on ${arch} is not published; available: ${formats
        .map((f) => `${f} (x64)`)
        .join(", ")}`,
    );
  }

  const name = artifact.name(version);
  return { id, format: chosen, how: artifact.how, name, url: assetUrl(version, name) };
}

/**
 * Pick the asset out of a release by EXACT name.
 *
 * A substring test is the obvious implementation and it is wrong here: `0.9.1`
 * is a prefix of `0.9.11`, so asking a v0.9.1 release for
 * `Termigo_0.9.1_x64.dmg` by substring happily returns the 0.9.11 asset. The
 * user gets a newer build than they pinned, with no error - the one class of
 * bug a checksum cannot catch, because the file is intact.
 */
export function findAsset(assets, name) {
  const hit = (assets ?? []).find((a) => a?.name === name);
  if (hit) return hit;
  const known = (assets ?? []).map((a) => a?.name).filter(Boolean);
  throw new Error(
    `release has no asset named "${name}"${known.length ? `\navailable:\n  ${known.join("\n  ")}` : ""}`,
  );
}
