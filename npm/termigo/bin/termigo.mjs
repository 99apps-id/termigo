#!/usr/bin/env node
// Install (or start) the Termigo desktop app.
//
// Termigo is a Tauri application, not a library, so `npm install termigo` as a
// plain dependency would only reproduce a source tree that has to be compiled
// with a Rust toolchain. This package is an installer instead: it downloads the
// build that was made for this machine, checks it against the checksum GitHub
// publishes, installs it, and then starts it. The second thing it does is make
// itself unnecessary - once the app is installed, running it again just opens
// the app.

import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  cleanup,
  headlessCommand,
  installApp,
  installedApp,
  launch,
  stagingDir,
} from "../src/install.mjs";
import {
  download,
  latestVersion,
  releaseAssets,
  sha256File,
  verify,
} from "../src/release.mjs";
import { FORMATS_BY_PLATFORM, findAsset, resolveArtifact } from "../src/target.mjs";

const self = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

const HELP = `termigo ${self.version} - install or start the Termigo desktop app

Usage
  termigo                     install for this machine, then start it
  termigo --dry-run           show what would be downloaded, download nothing
  termigo --list              list the files in the current release
  termigo --reinstall         install again even if the app is already here

Options
  --app-version <x.y.z>   install a specific release instead of the newest
  --format <name>         ${Object.entries(FORMATS_BY_PLATFORM)
    .map(([p, f]) => `${p}: ${f.join("|")}`)
    .join("   ")}
  --dir <path>            keep the download here instead of a temp directory
  --keep                  keep the downloaded file
  --download-only         fetch the file and verify it, install nothing
  --silent                install without a progress window (Windows only)
  --no-verify             install without checking the checksum (not advised)
  --no-launch             install without starting the app
  --platform, --arch      override detection (for --dry-run on another machine)
  -h, --help              this text
  -v, --version           the version of this installer
On a server with no display the app is installed but not started, and the
command to run it under Xvfb is printed instead.
The app is never installed into a directory on PATH: the name \`termigo\` is
already this command. On Linux the AppImage goes to ~/.local/share/termigo.
`;

/**
 * Start the app, or explain why it cannot be started here.
 *
 * A server has no display, and spawning a GUI binary there fails silently - it
 * exits, nothing is printed, and the user is left thinking Termigo is broken.
 * Being told the exact command that DOES work on that machine is worth more
 * than a launch attempt that appears to do nothing.
 */
async function startOrExplain(app, platform) {
  const result = await launch(app, { platform });
  if (result.started) {
    process.stdout.write("  started\n");
    return;
  }
  if (result.reason === "missing" || result.reason === "failed") {
    process.stdout.write(
      `  could not start ${app}: ${result.error}\n` +
        "  the install looks incomplete - re-run with --reinstall\n",
    );
    // A non-zero exit, because the requested action did not happen.
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    "  not started: no display on this machine (a server, or an SSH session without X).\n" +
      "\n  Termigo is a desktop app, but it runs headless too - the repository's\n" +
      "  scripts/run-headless.sh is the supported entry point, and this is what it runs:\n" +
      `\n    ${headlessCommand(app)}\n` +
      "\n  Do not run the binary directly without xvfb-run: WebKit looks for a D-Bus\n" +
      "  session and exits. See docs/headless-vps.md.\n" +
      "\n  A release install alongside an existing Termigo is a SECOND instance and\n" +
      "  shares its data directory - check that nothing is already running first.\n",
  );
}

const FLAGS_WITH_VALUE = new Set([
  "--app-version",
  "--format",
  "--dir",
  "--platform",
  "--arch",
]);

export function parseArgs(argv) {
  const opts = {
    appVersion: null,
    format: null,
    dir: null,
    keep: false,
    downloadOnly: false,
    silent: false,
    verify: true,
    launch: true,
    dryRun: false,
    list: false,
    reinstall: false,
    help: false,
    version: false,
    platform: process.platform,
    arch: process.arch,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (FLAGS_WITH_VALUE.has(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} needs a value`);
      }
      if (arg === "--app-version") opts.appVersion = value.replace(/^v/, "");
      else if (arg === "--format") opts.format = value;
      else if (arg === "--dir") opts.dir = value;
      else if (arg === "--platform") opts.platform = value;
      else if (arg === "--arch") opts.arch = value;
      continue;
    }
    switch (arg) {
      case "--keep":
        opts.keep = true;
        break;
      case "--download-only":
        // The escape hatch that makes the command useful for a machine that is
        // not this one: fetch the .deb here, copy it to the server.
        opts.downloadOnly = true;
        opts.keep = true;
        break;
      case "--silent":
        opts.silent = true;
        break;
      case "--no-verify":
        opts.verify = false;
        break;
      case "--no-launch":
        opts.launch = false;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--list":
        opts.list = true;
        break;
      case "--reinstall":
        opts.reinstall = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "-v":
      case "--version":
        opts.version = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

function human(bytes) {
  if (!bytes) return "";
  const mb = bytes / 1024 / 1024;
  return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

/** A one-line progress bar, but only where a line can be rewritten. */
function progressReporter() {
  const tty = process.stderr.isTTY;
  let last = 0;
  return (seen, total) => {
    if (!tty) return;
    const now = Date.now();
    if (now - last < 100 && seen !== total) return;
    last = now;
    const pct = total ? `${Math.floor((seen / total) * 100)}%` : human(seen);
    process.stderr.write(
      `\r  downloading ${pct}${total ? ` of ${human(total)}` : ""}   `,
    );
  };
}

async function main(argv) {
  const opts = parseArgs(argv);

  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`${self.version}\n`);
    return 0;
  }

  // Already here and not being replaced: start it. This is what makes the
  // command worth having on PATH rather than a one-shot installer.
  if (!opts.reinstall && !opts.dryRun && !opts.list) {
    const existing = await installedApp({ platform: opts.platform });
    if (existing) {
      process.stdout.write(`Termigo is already installed at ${existing}\n`);
      if (opts.launch) await startOrExplain(existing, opts.platform);
      return 0;
    }
  }

  const version = opts.appVersion ?? (await latestVersion());
  const artifact = resolveArtifact({
    platform: opts.platform,
    arch: opts.arch,
    format: opts.format,
    version,
  });

  const assets = await releaseAssets(version);
  const asset = findAsset(assets, artifact.name);

  if (opts.list) {
    process.stdout.write(`Termigo v${version}\n`);
    for (const a of assets) {
      const mark = a.name === artifact.name ? "*" : " ";
      process.stdout.write(`${mark} ${a.name}  ${human(a.size)}\n`);
    }
    return 0;
  }

  process.stdout.write(`Termigo v${version} for ${opts.platform}/${opts.arch}\n`);
  process.stdout.write(`  ${artifact.name}  ${human(asset.size)}\n`);

  if (opts.dryRun) {
    process.stdout.write(`  from ${asset.url}\n`);
    process.stdout.write(
      `  checksum ${asset.sha256 ? `sha256:${asset.sha256}` : "NOT PUBLISHED"}\n`,
    );
    process.stdout.write(`  install: ${artifact.how}\n`);
    return 0;
  }

  // Refusing an unverifiable binary is the default because this is the step
  // where a compromised mirror or a hijacked DNS answer becomes an installed
  // application. The escape hatch exists, but it has to be asked for.
  if (opts.verify && !asset.sha256) {
    throw new Error(
      `release v${version} publishes no checksum for ${artifact.name}, so the download cannot be verified.\n` +
        `Re-run with --no-verify if you accept that.`,
    );
  }

  const dir = opts.dir ? join(opts.dir) : await stagingDir();
  const target = join(dir, basename(artifact.name));

  try {
    const { size } = await download(asset.url, target, {
      onProgress: progressReporter(),
    });
    if (process.stderr.isTTY) process.stderr.write("\r\u001b[K");
    process.stdout.write(`  downloaded ${human(size)}\n`);

    if (opts.verify) {
      const actual = await sha256File(target);
      const ok = verify(actual, asset.sha256);
      if (!ok) {
        throw new Error(
          `checksum mismatch for ${artifact.name}\n  expected ${asset.sha256}\n  got      ${actual}\n` +
            `The download was discarded. Nothing was installed.`,
        );
      }
      process.stdout.write("  checksum verified\n");
    } else {
      process.stdout.write("  checksum NOT verified (--no-verify)\n");
    }

    if (opts.downloadOnly) {
      process.stdout.write(`  saved to ${target}\n`);
      return 0;
    }

    const result = await installApp({
      file: target,
      how: artifact.how,
      silent: opts.silent,
    });
    process.stdout.write(`  installed: ${result.installedAt ?? result.note}\n`);

    if (opts.launch) {
      const app = result.installedAt ?? (await installedApp({ platform: opts.platform }));
      if (app) await startOrExplain(app, opts.platform);
      else process.stdout.write("  start it from your applications menu\n");
    }
    return 0;
  } finally {
    if (!opts.keep && !opts.dir) await cleanup(dir);
    else process.stdout.write(`  kept ${target}\n`);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`termigo: ${e.message}\n`);
  process.exitCode = 1;
}
