// WebdriverIO config for Termigo's end-to-end smoke tests.
//
// tauri-driver is a small Rust proxy (`cargo install tauri-driver`) that sits
// between WebDriver and the platform webview driver — WebKitWebDriver on Linux,
// msedgedriver on Windows (macOS is unsupported by tauri-driver). It launches
// the built Termigo binary and speaks WebDriver to its webview, so these tests
// exercise the REAL app: the Rust backend, the IPC surface, and the webview UI
// together — the integration layer unit tests can't reach.
//
// Prereqs (see e2e/README.md): a release build of the app, `tauri-driver` on
// PATH, and the native webview driver for the OS on PATH.
import { type ChildProcess, spawn } from "node:child_process";
import { platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const isWindows = platform() === "win32";
const binaryName = isWindows ? "termigo.exe" : "termigo";

// The built binary tauri-driver launches. Release by default; point
// TERMIGO_E2E_BINARY at a debug build (or a bundle) to override.
const application =
  process.env.TERMIGO_E2E_BINARY ??
  resolve(here, "..", "src-tauri", "target", "release", binaryName);

// On Windows tauri-driver needs to be told where msedgedriver.exe is; on Linux
// it finds WebKitWebDriver on PATH. Set TAURI_DRIVER_NATIVE to override.
const nativeDriverArgs = process.env.TAURI_DRIVER_NATIVE
  ? ["--native-driver", process.env.TAURI_DRIVER_NATIVE]
  : [];

let tauriDriver: ChildProcess | undefined;

export const config: WebdriverIO.Config = {
  runner: "local",
  tsConfigPath: resolve(here, "tsconfig.json"),
  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1,
  hostname: "127.0.0.1",
  port: 4444,
  capabilities: [
    {
      // biome-ignore lint/suspicious/noExplicitAny: tauri:options is a driver
      // capability WebdriverIO's types don't model.
      "tauri:options": { application },
    } as any,
  ],
  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 120_000 },
  logLevel: "warn",
  waitforTimeout: 30_000,
  connectionRetryCount: 3,

  // Boot tauri-driver before the session and tear it down after.
  onPrepare: () => {
    tauriDriver = spawn("tauri-driver", nativeDriverArgs, {
      stdio: [null, process.stdout, process.stderr],
    });
    tauriDriver.on("error", (e) => {
      console.error("tauri-driver failed to start:", e);
      process.exit(1);
    });
  },
  onComplete: () => {
    tauriDriver?.kill();
  },
};
