// Rust target triple -> the pair of names the Go toolchain and Node each use.
//
// Three vocabularies describe the same machine and none of them agree:
//
//   rust    x86_64-pc-windows-msvc   x86_64-apple-darwin   aarch64-unknown-linux-gnu
//   go      windows/amd64            darwin/amd64          linux/arm64
//   node    win32/x64                darwin/x64            linux/arm64
//
// The release asset is named in NODE's vocabulary on purpose, because the thing
// that downloads it (`npm/termigo`) only ever knows `process.platform` and
// `process.arch`. Naming it after the Rust target would make every download
// depend on a translation table at runtime, where a mistake is a 404 a user
// sees. Translating once, at build time, puts the risk somewhere a test can
// reach it.
//
// Go is cross-compiled with CGO_ENABLED=0, which is what makes building the
// darwin binary on a macOS runner and the windows one on a Windows runner -
// or all three from a Linux runner - a flag change rather than a toolchain
// problem.

/** Triples this project actually builds for. Anything else is refused loudly. */
const BY_TRIPLE = {
  "x86_64-pc-windows-msvc": { goos: "windows", goarch: "amd64", platform: "win32", arch: "x64", ext: ".exe" },
  "aarch64-pc-windows-msvc": { goos: "windows", goarch: "arm64", platform: "win32", arch: "arm64", ext: ".exe" },
  // The GNU and gnullvm toolchains produce the same Go binary as MSVC - Go does
  // not link against the C toolchain at all with CGO off - so they map to the
  // same asset rather than being refused. A developer on the GNU toolchain
  // should not have to discover this map to build.
  "x86_64-pc-windows-gnu": { goos: "windows", goarch: "amd64", platform: "win32", arch: "x64", ext: ".exe" },
  "aarch64-pc-windows-gnullvm": { goos: "windows", goarch: "arm64", platform: "win32", arch: "arm64", ext: ".exe" },
  "x86_64-apple-darwin": { goos: "darwin", goarch: "amd64", platform: "darwin", arch: "x64", ext: "" },
  "aarch64-apple-darwin": { goos: "darwin", goarch: "arm64", platform: "darwin", arch: "arm64", ext: "" },
  "x86_64-unknown-linux-gnu": { goos: "linux", goarch: "amd64", platform: "linux", arch: "x64", ext: "" },
  "aarch64-unknown-linux-gnu": { goos: "linux", goarch: "arm64", platform: "linux", arch: "arm64", ext: "" },
  "x86_64-unknown-linux-musl": { goos: "linux", goarch: "amd64", platform: "linux", arch: "x64", ext: "" },
  "aarch64-unknown-linux-musl": { goos: "linux", goarch: "arm64", platform: "linux", arch: "arm64", ext: "" },
};

/** What `process.platform` / `process.arch` are on the machine running this. */
export function hostTripleNames() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  switch (process.platform) {
    case "win32":
      return { goos: "windows", goarch: arch === "arm64" ? "arm64" : "amd64", platform: "win32", arch, ext: ".exe" };
    case "darwin":
      return { goos: "darwin", goarch: arch === "arm64" ? "arm64" : "amd64", platform: "darwin", arch, ext: "" };
    case "linux":
      return { goos: "linux", goarch: arch === "arm64" ? "arm64" : "amd64", platform: "linux", arch, ext: "" };
    default:
      throw new Error(`no Go target for host platform ${process.platform}`);
  }
}

/**
 * Resolve a Rust target triple, or the host when it is empty.
 *
 * An empty triple is what the release matrix sends for the Linux and Windows
 * legs (only the macOS legs set one, because those are the cross-arch builds),
 * so "empty means host" is the contract and not a shortcut.
 */
export function resolveGoTarget(triple) {
  const wanted = (triple ?? "").trim();
  if (!wanted) return hostTripleNames();

  const found = BY_TRIPLE[wanted];
  if (!found) {
    // Refusing beats falling back to the host: a silently wrong GOOS produces a
    // binary that is correct in name and useless in practice, and the release
    // would ship it.
    throw new Error(
      `no Go target mapping for rust triple "${wanted}".\n` +
        `known triples:\n  ${Object.keys(BY_TRIPLE).join("\n  ")}`,
    );
  }
  return found;
}

/**
 * The release asset name for a target.
 *
 * `termigo-go-<platform>-<arch><ext>`, which `npm/termigo` can build from
 * `process.platform` and `process.arch` without translating anything.
 */
export function goAssetName(target) {
  return `termigo-go-${target.platform}-${target.arch}${target.ext}`;
}
