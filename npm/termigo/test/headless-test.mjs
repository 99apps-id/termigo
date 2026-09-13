// Installing a desktop app on a server is the case that goes wrong quietly: the
// GUI binary is spawned, finds no display, exits, and prints nothing. So the
// display check and the guidance it produces are tested directly.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  headlessCommand,
  headlessNotice,
  isHeadless,
  launch,
} from "../src/install.mjs";

describe("isHeadless", () => {
  it("treats a Linux box with no display as headless", () => {
    assert.equal(isHeadless("linux", {}), true);
    assert.equal(isHeadless("linux", { PATH: "/usr/bin" }), true);
  });

  it("accepts either an X or a Wayland display", () => {
    assert.equal(isHeadless("linux", { DISPLAY: ":0" }), false);
    assert.equal(isHeadless("linux", { WAYLAND_DISPLAY: "wayland-0" }), false);
  });

  // An empty DISPLAY is what an SSH session with X forwarding configured but
  // not established looks like, and it is still no display.
  it("does not count an empty display variable", () => {
    assert.equal(isHeadless("linux", { DISPLAY: "" }), true);
  });

  // macOS and Windows always have a window server; asking is meaningless.
  it("never calls a desktop platform headless", () => {
    assert.equal(isHeadless("darwin", {}), false);
    assert.equal(isHeadless("win32", {}), false);
  });
});

describe("headlessCommand", () => {
  // The D-Bus session is the part people leave out, and without it WebKit
  // starts and then dies on the bus lookup.
  it("includes both xvfb-run and a private dbus session", () => {
    const cmd = headlessCommand("/home/u/.local/share/termigo/Termigo.AppImage");
    assert.match(cmd, /xvfb-run/);
    assert.match(cmd, /dbus-run-session/);
    assert.match(cmd, /Termigo\.AppImage$/);
  });
});

describe("headlessNotice", () => {
  // This text is the entire answer a server user gets. It has to name the exact
  // file that was installed, the command that works, and the two mistakes that
  // would otherwise cost them an evening.
  const notice = headlessNotice("/home/u/.local/share/termigo/Termigo_0.9.11_amd64.AppImage");

  it("names the installed file in the command it prints", () => {
    assert.match(notice, /Termigo_0\.9\.11_amd64\.AppImage/);
  });

  it("warns about the D-Bus session", () => {
    assert.match(notice, /D-Bus/);
  });

  it("warns that a second instance shares the data directory", () => {
    assert.match(notice, /SECOND instance/);
    assert.match(notice, /data directory/);
  });

  it("points at the headless documentation", () => {
    assert.match(notice, /docs\/headless-vps\.md/);
  });

  // The command sits on its own line so it can be copied straight out of the
  // terminal; an inline reference is the difference between usable and not.
  it("puts the command on its own indented line, ending at the file", () => {
    const line = notice.split("\n").find((l) => l.includes("xvfb-run"));
    assert.ok(line, "the command should have a line of its own");
    assert.match(line, /^ {4}xvfb-run -a -s '-screen 0 1024x768x24' dbus-run-session /);
    assert.match(line, /Termigo_0\.9\.11_amd64\.AppImage$/);
  });
});

describe("launch", () => {
  // The whole point of the check: on a server nothing may be spawned, because
  // the failure would be invisible from a detached process.
  it("spawns nothing when there is no display", async () => {
    const result = await launch("/home/u/.local/share/termigo/Termigo.AppImage", {
      platform: "linux",
      env: {},
    });
    assert.deepEqual(result, {
      started: false,
      reason: "headless",
      app: "/home/u/.local/share/termigo/Termigo.AppImage",
    });
  });

  // spawn reports a bad path asynchronously as an 'error' event. Unhandled,
  // that event kills the process with a raw stack trace instead of a message.
  it("reports a missing binary instead of crashing", async () => {
    const result = await launch("/definitely/not/here/termigo", {
      platform: "linux",
      env: { DISPLAY: ":0" },
    });
    assert.equal(result.started, false);
    assert.equal(result.reason, "missing");
    assert.ok(result.error, "should carry the spawn error message");
  });
});
