// The published entry point, actually executed.
//
// This file exists because of a shipped bug. The HELP text is one big template
// literal, and a later edit added backticks around `termigo-go` without escaping
// them - which terminated the literal early and made the whole bin a syntax
// error. `npm publish` succeeded, `npm view` showed the right metadata, and the
// package was dead on arrival: `npx termigo` failed before printing anything.
//
// The suite did not catch it because every other test imports from `src/`, and
// nothing had ever loaded `bin/`. A syntax error in the one file users actually
// run is invisible to tests that never run it.
//
// So these spawn the real bin. It is the only check that covers parsing, the
// imports it pulls in, and argument handling together.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const BIN = fileURLToPath(new URL("../bin/termigo.mjs", import.meta.url));

/** Run the bin without a shell, the way a package manager shim would. */
function run(...args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    // Nothing here should need the network; a hang would mean it tried.
    timeout: 20_000,
  });
}

describe("bin/termigo.mjs", () => {
  // The regression test. `--help` parses the whole file and prints the template
  // literal that was broken, so a stray backtick fails here.
  it("parses and prints help", () => {
    const r = run("--help");
    assert.equal(r.status, 0, `help exited ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /install or start the Termigo desktop app/);
    assert.match(r.stdout, /--dry-run/);
  });

  it("prints the version", () => {
    const r = run("--version");
    assert.equal(r.status, 0, `version exited ${r.status}: ${r.stderr}`);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
  });

  // The help text promises this name, and the promise is the reason the
  // companion is not called `termigo`.
  it("mentions termigo-go in the help it prints", () => {
    const r = run("--help");
    assert.match(r.stdout, /termigo-go/);
  });

  it("rejects an unknown option with a non-zero exit and a message", () => {
    const r = run("--definitely-not-an-option");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown option/);
  });

  // Argument errors must be reported, not thrown as a stack trace: this is the
  // first thing a user sees if they mistype a flag.
  it("does not leak a stack trace for a bad argument", () => {
    const r = run("--platform");
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /at Module\.|at Object\.<anonymous>/);
    assert.match(r.stderr, /needs a value/);
  });
});
