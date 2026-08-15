// Guards the wiring a new preference has to complete to be usable.
//
// Adding a preference touches five places: the Preferences type, DEFAULT_
// PREFERENCES, a KEY_ constant, loadPreferences, and the key -> PrefKey map in
// onPreferencesChange. Miss only the last and everything still compiles and
// persists; the live store simply never hears about the write, so the UI keeps
// the value it read at startup and the setting appears to do nothing until the
// app is restarted. That happened to agentApprovalMode.
//
// Reading the source is deliberate: the map is a literal inside a function, so
// there is nothing importable to assert against.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(__dirname, "store.ts"),
  "utf8",
);

/** `const KEY_FOO = "foo";` */
function declaredKeys(): string[] {
  return [...source.matchAll(/^const (KEY_[A-Z0-9_]+)\s*=/gm)].map((m) => m[1]);
}

/** `[KEY_FOO]: "foo",` inside onPreferencesChange. */
function routedKeys(): string[] {
  const start = source.indexOf("export async function onPreferencesChange");
  expect(start).toBeGreaterThan(-1);
  return [...source.slice(start).matchAll(/\[(KEY_[A-Z0-9_]+)\]:/g)].map(
    (m) => m[1],
  );
}

describe("preference key routing", () => {
  it("routes every declared preference key to the live store", () => {
    const missing = declaredKeys().filter((k) => !routedKeys().includes(k));
    expect(
      missing,
      `these keys persist but never reach usePreferencesStore, so changing them ` +
        `only takes effect after a restart: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("finds the keys at all, so a refactor cannot silently pass this suite", () => {
    expect(declaredKeys().length).toBeGreaterThan(20);
    expect(routedKeys().length).toBeGreaterThan(20);
  });

  it("routes the approval mode, which regressed exactly this way", () => {
    expect(routedKeys()).toContain("KEY_AGENT_APPROVAL_MODE");
  });
});
