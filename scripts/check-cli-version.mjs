// Guard against the "CLI reports a version nobody released" bug.
//
// `main.version` in cli/cmd/termigo/main.go is stamped at build time with
// -ldflags from package.json, so a hardcoded value there is dead weight that
// drifts silently: the binary keeps claiming an old version after a bump, or
// a release script regression leaves `dev` in a tagged build. This script
// cross-checks the source the same way check-invoke-commands.mjs guards the
// Tauri command surface, and fails CI when:
//   1. main.go does NOT keep `var version = "dev"` (the stamp contract), or
//   2. build-cli.mjs does not stamp package.json's version into main.version.
//
// The Go source itself cannot be checked for its stamped value (that is the
// linker's job), so the guard pins the two ends of the pipe instead: the
// fallback must be "dev", and the release build must overwrite it.
//
// CLI: node scripts/check-cli-version.mjs   (exit 1 on any violation)
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mainGo = join(root, "cli", "cmd", "termigo", "main.go");
const buildScript = join(root, "scripts", "build-cli.mjs");
const packageJson = join(root, "package.json");

const problems = [];

// 1. The fallback in main.go must stay "dev". Anything else is a hardcoded
//    version that will contradict the stamped one the moment package.json
//    moves.
const mainGoSource = readFileSync(mainGo, "utf8");
const versionDecl = mainGoSource.match(/^var version = "(.+)"$/m);
if (!versionDecl) {
  problems.push(
    `cli/cmd/termigo/main.go: no \`var version = "..."\" declaration found; the -ldflags stamp has nothing to overwrite`,
  );
} else if (versionDecl[1] !== "dev") {
  problems.push(
    `cli/cmd/termigo/main.go: \`var version = "${versionDecl[1]}"\` is hardcoded; it must be "dev" so -ldflags is the single source of truth (the value is stamped from package.json at build time)`,
  );
}

// 2. The build script must read the version from package.json and stamp it
//    into main.version. TERMIGO_VERSION may override it, but package.json is
//    the floor the stamp never falls below.
const buildSource = readFileSync(buildScript, "utf8");
if (!buildSource.includes("-X main.version=")) {
  problems.push(
    "scripts/build-cli.mjs: no `-X main.version=` in ldflags; the built binary would report the dev fallback forever",
  );
}
if (!/package\.json/.test(buildSource)) {
  problems.push(
    "scripts/build-cli.mjs: does not read package.json for the version; the stamp is not tied to the release source of truth",
  );
}

// 3. The package.json version must be a plain semver-ish value; the release
//    stamp is embedded raw, so a value with spaces would corrupt the ldflags
//    argument for every platform at once.
const pkgVersion = JSON.parse(readFileSync(packageJson, "utf8")).version;
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pkgVersion)) {
  problems.push(
    `package.json: version "${pkgVersion}" is not semver; it cannot be stamped into -ldflags safely`,
  );
}

if (problems.length > 0) {
  for (const problem of problems) {
    process.stderr.write(`check-cli-version: ${problem}\n`);
  }
  process.exit(1);
}

console.log(
  `check-cli-version: ok (fallback is "dev", build stamps package.json ${pkgVersion})`,
);
