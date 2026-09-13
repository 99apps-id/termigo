// Putting the downloaded artifact where the operating system expects it, and
// starting the app afterwards.
//
// Nothing here tries to be clever about privileges. An AppImage needs none and
// is installed into the home directory; a deb or an rpm needs root and is
// handed to the system package manager so it can be tracked and removed later.
// Reaching for sudo on a user's behalf, silently, is how an installer becomes
// something people are told not to run.

import { spawn } from "node:child_process";
import { access, chmod, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

/** Run a command, inheriting stdio, and reject on a non-zero exit. */
export function run(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...opts });
    child.on("error", (e) =>
      reject(new Error(`cannot run ${command}: ${e.message}`)),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with code ${code}`)),
    );
  });
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where an AppImage copy lives. Deliberately NOT on PATH. */
export function appImageDir() {
  return join(homedir(), ".local", "share", "termigo");
}

/**
 * Where a previous run left the app, or null.
 *
 * Used to make the command useful twice: the first run installs, every later
 * run just starts the app. It is also why the AppImage is not placed on PATH -
 * the npm bin is already called `termigo`, and a second `termigo` in
 * `~/.local/bin` would shadow one or the other depending on PATH order, which
 * is a support ticket rather than a feature.
 */
export async function installedApp({ platform }) {
  if (platform === "linux") {
    const dir = appImageDir();
    try {
      const entries = await readdir(dir);
      const app = entries.find((e) => e.endsWith(".AppImage"));
      return app ? join(dir, app) : null;
    } catch {
      return null;
    }
  }
  if (platform === "darwin") {
    const app = "/Applications/Termigo.app";
    return (await exists(app)) ? app : null;
  }
  if (platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    const candidates = [
      local && join(local, "Programs", "Termigo", "Termigo.exe"),
      join(process.env.ProgramFiles ?? "C:\\Program Files", "Termigo", "Termigo.exe"),
    ].filter(Boolean);
    for (const c of candidates) {
      if (await exists(c)) return c;
    }
  }
  return null;
}

/**
 * Whether this machine can show a window at all.
 *
 * Termigo is a Tauri app: without a display the webview cannot start, and the
 * failure is silent from a detached process - it exits and nothing is printed.
 * A server reached over SSH is the normal case here, not an edge one, and it is
 * also the case where a user is most likely to be installing unattended.
 *
 * macOS and Windows always have a window server, so only Linux is interrogated.
 */
export function isHeadless(platform, env = process.env) {
  if (platform !== "linux") return false;
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

/**
 * How to run Termigo on a machine with no display.
 *
 * Taken from the repository's own `scripts/run-headless.sh`, which is the
 * supported entry point: Xvfb for the display, a private D-Bus session because
 * WebKit expects one, and software rendering because there is no GPU. Running
 * the binary directly under xvfb-run alone is the common mistake - it starts,
 * then dies on the D-Bus lookup.
 */
export function headlessCommand(app) {
  return `xvfb-run -a -s '-screen 0 1024x768x24' dbus-run-session ${app}`;
}

/**
 * Start an installed app, unless there is nowhere to show it.
 *
 * Returns a result rather than throwing: on a server this is the expected
 * outcome, and the caller has something useful to say about it.
 */
export async function launch(path, { platform, env = process.env }) {
  if (isHeadless(platform, env)) {
    return { started: false, reason: "headless", app: path };
  }
  if (platform === "darwin") {
    await run("open", [path]);
    return { started: true };
  }

  const child = spawn(path, [], { detached: true, stdio: "ignore" });
  // `spawn` reports a bad path ASYNCHRONOUSLY, as an 'error' event. With no
  // listener attached that becomes an unhandled event and Node exits with a raw
  // stack trace - a poor way to say "that file is not executable". Waiting for
  // 'spawn' or 'error' also means the caller is told the truth rather than
  // being congratulated for a process that never existed.
  const failure = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000);
    child.once("error", (e) => {
      clearTimeout(timer);
      resolve(e);
    });
    child.once("spawn", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });

  if (failure) {
    return {
      started: false,
      reason: failure.code === "ENOENT" ? "missing" : "failed",
      app: path,
      error: failure.message,
    };
  }
  child.unref();
  return { started: true };
}

/**
 * Install the downloaded artifact.
 *
 * `silent` only changes the Windows installers. On Linux and macOS the steps
 * are already non-interactive, so the flag is accepted and ignored rather than
 * pretended to mean something.
 */
export async function installApp({ file, how, silent = false }) {
  switch (how) {
    case "appimage": {
      // No installer and no root: copy it into its own directory and mark it
      // executable. It is the whole reason AppImage is the default on Linux.
      const dir = appImageDir();
      const dest = join(dir, basename(file));
      await mkdir(dir, { recursive: true });
      await copyFile(file, dest);
      await chmod(dest, 0o755);
      return { installedAt: dest, note: "no root needed; run `termigo` to start it" };
    }
    case "dmg": {
      const mount = await mountDmg(file);
      try {
        const app = await findAppBundle(mount);
        if (!app) throw new Error(`no .app bundle inside ${basename(file)}`);
        const dest = join("/Applications", basename(app));
        // ditto, not cp: it preserves the code signature, and a launch services
        // cache that disagrees with the bundle makes the app fail to open with
        // no useful message.
        await run("ditto", [app, dest]);
        return { installedAt: dest, note: "copied to /Applications" };
      } finally {
        await run("hdiutil", ["detach", mount, "-quiet"]).catch(() => {});
      }
    }
    case "msi": {
      // /qb shows a progress bar and still surfaces failures; /qn hides them,
      // so full silence is opt-in.
      await run("msiexec", ["/i", file, silent ? "/qn" : "/qb"]);
      return { installedAt: null, note: "installed by Windows Installer" };
    }
    case "nsis": {
      await run(file, silent ? ["/S"] : []);
      return { installedAt: null, note: "installed by the Termigo setup program" };
    }
    case "deb": {
      await run("sudo", ["dpkg", "-i", file]);
      return { installedAt: null, note: "installed by dpkg" };
    }
    case "rpm": {
      // dnf and zypper resolve dependencies, which rpm -U does not; try them
      // first and fall back so this works on the older distributions too.
      const manager = (await which("dnf")) ? "dnf" : (await which("zypper")) ? "zypper" : "rpm";
      await run("sudo", manager === "rpm" ? ["rpm", "-U", file] : [manager, "install", "-y", file]);
      return { installedAt: null, note: `installed by ${manager}` };
    }
    default:
      throw new Error(`no installer for format "${how}"`);
  }
}

async function which(program) {
  const paths = (process.env.PATH ?? "").split(":");
  for (const dir of paths) {
    if (dir && (await exists(join(dir, program)))) return join(dir, program);
  }
  return null;
}

/** Attach a dmg and return its mount point. */
async function mountDmg(file) {
  const out = await capture("hdiutil", ["attach", file, "-nobrowse", "-readonly"]);
  // Every line ends with the mount point as its last tab-separated column.
  const mount = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("/Volumes/"))
    .pop();
  if (!mount) throw new Error(`could not mount ${basename(file)}`);
  return mount;
}

async function findAppBundle(dir) {
  const entries = await readdir(dir).catch(() => []);
  const app = entries.find((e) => e.endsWith(".app"));
  return app ? join(dir, app) : null;
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${command}: ${err || code}`)),
    );
  });
}

/** A fresh directory to download into, outside the project being worked on. */
export async function stagingDir() {
  const dir = join(tmpdir(), `termigo-install-${process.pid}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
