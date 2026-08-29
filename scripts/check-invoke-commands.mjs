// Guard against the "invoke a Tauri command that was never registered" bug.
//
// A frontend `invoke("foo")` whose `foo` is missing from lib.rs's
// `generate_handler!` list compiles fine and only fails at runtime — exactly how
// the SSH-backup commands (backup_seal / backup_open) shipped broken: the UI
// called them, but they were never registered. This script cross-checks every
// string-literal command name invoked from `src/` against the registered set and
// fails CI if any is missing.
//
// Scope and limits (deliberately conservative to avoid false positives):
//   - Only STRING-LITERAL command names are checked; `invoke(dynamicVar)` and
//     template literals can't be verified statically and are skipped.
//   - `plugin:*` commands (dialog, store, opener, …) are provided by Tauri
//     plugins, not `generate_handler!`, so the colon excludes them naturally.
//   - Test files are skipped: they mock `invoke` with fake command names.
//
// CLI: node scripts/check-invoke-commands.mjs   (exit 1 on any missing command)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const libRs = join(root, "src-tauri", "src", "lib.rs");

// Command names that are intentionally invoked dynamically or handled elsewhere.
// Keep empty unless a real, understood exception appears — every entry here is a
// hole in the guard.
const ALLOWLIST = new Set([]);

/** Recursively collect .ts/.tsx files under a dir, skipping tests. */
function collectSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSources(full));
    } else if (
      /\.(ts|tsx)$/.test(entry) &&
      !/\.(test|spec)\.(ts|tsx)$/.test(entry)
    ) {
      out.push(full);
    }
  }
  return out;
}

// `invoke("cmd")` / `invoke<T>('cmd')` / `.invoke("cmd")` — first arg a string
// literal of an unqualified command name (no colon → not a plugin command).
const INVOKE_RE =
  /\binvoke\s*(?:<[^>]*>)?\s*\(\s*["'`]([a-zA-Z_][a-zA-Z0-9_]*)["'`]/g;

function collectInvoked(files) {
  const found = new Map(); // command -> first "file:line"
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(INVOKE_RE)) {
      const name = m[1];
      if (found.has(name)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      found.set(name, `${file.slice(root.length + 1)}:${line}`);
    }
  }
  return found;
}

/** Registered command names from lib.rs's generate_handler! block. */
function collectRegistered() {
  const text = readFileSync(libRs, "utf8");
  const start = text.indexOf("generate_handler![");
  if (start === -1) {
    console.error("check-invoke-commands: generate_handler! not found in lib.rs");
    process.exit(2);
  }
  const end = text.indexOf("]", start);
  const block = text.slice(start + "generate_handler![".length, end);
  const names = new Set();
  for (const raw of block.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    // `module::command` → `command`; bare `command` → `command`.
    const name = token.split("::").pop().trim();
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) names.add(name);
  }
  return names;
}

const invoked = collectInvoked(collectSources(srcDir));
const registered = collectRegistered();

const missing = [...invoked.keys()].filter(
  (name) => !registered.has(name) && !ALLOWLIST.has(name),
);

if (missing.length > 0) {
  console.error(
    `\n✗ ${missing.length} Tauri command(s) invoked from the frontend are NOT registered in src-tauri/src/lib.rs:\n`,
  );
  for (const name of missing.sort()) {
    console.error(`  - ${name}  (first used at ${invoked.get(name)})`);
  }
  console.error(
    "\nAdd them to generate_handler![...] (and their #[tauri::command] fn), or\n" +
      "if the name is genuinely dynamic/handled elsewhere, add it to ALLOWLIST\n" +
      "in scripts/check-invoke-commands.mjs with a comment saying why.\n",
  );
  process.exit(1);
}

console.log(
  `✓ all ${invoked.size} invoked Tauri commands are registered (${registered.size} registered total)`,
);
