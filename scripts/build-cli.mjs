import { cpSync, chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { goAssetName, resolveGoTarget } from "./lib/go-target.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(root, "src-tauri");
const release = process.argv.includes("--release");
// `--go-only` skips the Rust sidecar. The Go companion cross-compiles from any
// host with one toolchain, which the Rust sidecar does not: building the macOS
// and Linux sidecars from Windows would need every target installed through
// rustup first. Cross-compiling the companion is a flag; cross-compiling the
// sidecar is a toolchain setup.
const goOnly = process.argv.includes("--go-only");

function run(command, args, { capture = false, cwd = root, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: env ?? process.env,
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
  });
  if (result.error) {
    process.stderr.write(`Could not run ${command}: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    if (capture) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? "";
}

function hostTriple() {
  const output = run("rustc", ["-vV"], { capture: true });
  const match = output.match(/^host:\s+(.+)$/m);
  if (!match) {
    process.stderr.write("rustc did not report a host target triple\n");
    process.exit(1);
  }
  return match[1].trim();
}

function requireArtifact(path, label) {
  try {
    const artifact = statSync(path);
    if (artifact.isFile() && artifact.size > 0) return;
  } catch {}
  process.stderr.write(`${label} is missing or empty: ${path}\n`);
  process.exit(1);
}

const target =
  process.env.TERMIGO_CLI_TARGET?.trim() ||
  process.env.CARGO_BUILD_TARGET?.trim() ||
  hostTriple();

// Resolved BEFORE the Rust build on purpose. A triple this project cannot map
// to a Go target has to say so in one clear line; letting it surface later
// means cargo fails first and the real reason is buried under a linker error.
//
// Thrown errors are printed rather than allowed to escape: an uncaught one
// arrives as a Node stack trace, and the sentence that explains the problem is
// then the one line nobody reads.
let goTarget;
try {
  goTarget = resolveGoTarget(target);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
const goAsset = goAssetName(goTarget);

// Go is optional, and that is a deliberate constraint rather than a convenience:
// nothing bundles this binary, so a machine without Go can still build every
// artifact it is responsible for.
const hasGo = (() => {
  const probe = spawnSync("go", ["version"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
})();

const cargoArgs = [
  "build",
  "--locked",
  "--manifest-path",
  join(tauriDir, "Cargo.toml"),
  "--package",
  "termigo-cli",
  "--bin",
  "termigo-cli",
  "--target",
  target,
];
if (release) cargoArgs.push("--release");

// Skipped entirely under `--go-only`; see the flag's comment above.
if (!goOnly) {
  run("cargo", cargoArgs);

  const extension = target.includes("windows") ? ".exe" : "";
  const profile = release ? "release" : "debug";
  const source = join(
    tauriDir,
    "target",
    target,
    profile,
    `termigo-cli${extension}`,
  );
  const destination = join(
    tauriDir,
    "binaries",
    `termigo-cli-${target}${extension}`,
  );
  requireArtifact(source, "Built CLI artifact");
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
  if (!extension) chmodSync(destination, 0o755);
  requireArtifact(destination, "Prepared CLI sidecar");

  console.log(`Prepared ${destination.slice(root.length + 1)}`);
}

// ── The Go companion ──────────────────────────────────────────────────────
//
// This is the `termigo tui` program. It is built here so one command produces
// every executable the project ships, and it is uploaded as a RELEASE ASSET
// rather than bundled as a Tauri sidecar for a specific reason: a sidecar in
// `bundle.externalBin` has to exist for every build, and the VPS that builds
// the headless release has no Go toolchain at all. Making it mandatory would
// turn "build the server binary" into "install Go first", for a program the
// server does not run.
//
// So a machine without Go skips it with a warning instead of failing, and the
// release workflow installs Go precisely so that the published assets do
// include it.
function buildGoCompanion() {
  const out = join(tauriDir, "binaries", goAsset);

  if (!hasGo) {
    console.warn(
      `Skipping ${goAsset}: no Go toolchain on this machine.\n` +
        `  The release workflow installs Go, so a published release still has it.`,
    );
    return;
  }

  // The version stamped in is the package version, which matches the tag in CI.
  // The override exists for the case where an asset is built for a release that
  // is already published: stamping a newer version into a binary attached to an
  // older tag makes `termigo-go version` contradict the page it came from.
  const version =
    process.env.TERMIGO_VERSION?.trim() ||
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

  // -s -w strip the symbol table and DWARF data (10.3 MB -> about 7 MB) and
  // -X stamps the real version in, because `var version = "dev"` in main.go is
  // otherwise what `termigo version` reports forever.
  const ldflags = ["-s", "-w", `-X main.version=${version}`].join(" ");
  run("go", ["build", "-trimpath", "-ldflags", ldflags, "-o", out, "./cmd/termigo"], {
    // `go build` must run inside the module, and CGO has to be off or
    // cross-compiling to another OS fails with a confusing linker error.
    cwd: join(root, "cli"),
    env: { ...process.env, GOOS: goTarget.goos, GOARCH: goTarget.goarch, CGO_ENABLED: "0" },
  });

  if (!goTarget.ext) chmodSync(out, 0o755);
  requireArtifact(out, "Built Go companion");
  const size = statSync(out).size;
  console.log(
    `Prepared src-tauri/binaries/${goAsset} (${(size / 1024 / 1024).toFixed(1)} MB, ${goTarget.goos}/${goTarget.goarch})`,
  );
}

buildGoCompanion();
