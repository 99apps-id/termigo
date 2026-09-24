// Guard against the docs catalog drifting away from the real command surface.
//
// `docs/architecture/two-process-model.md` carries the catalog of Tauri commands
// the webview may call. It is hand-maintained, so it rots in both directions: a
// command can be registered and never documented, or documented and no longer
// exist. The first is what shipped for most of this file's life (82 of 162
// commands were undocumented, and whole modules had no section at all), and the
// second is the one a reader actually trips over, because a nonexistent command
// in the catalog reads like an API you can call.
//
// Checks, both directions, against the catalog's own shape:
//   - missing: registered in `generate_handler!` but absent from a catalog entry.
//   - stale:   present as a catalog entry but not registered.
//
// Scope and limits (deliberately conservative to avoid false positives):
//   - Only the `generate_handler!` block is treated as the registration source.
//     Commands added elsewhere would have to be added here too.
//   - A catalog entry is a backticked identifier that OPENS a list item, the
//     shape every section of the catalog uses. Prose is not enough on purpose:
//     `lsp_*` spent a long time described in detail in Implementation notes and
//     was still missing from the catalog, which is exactly the gap a reader
//     scanning the command list would hit. Names with a hyphen (crate and file
//     names) cannot match, so ordinary prose and code snippets are inert.
//
// CLI: node scripts/check-doc-commands.mjs   (exit 1 on drift)
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const libRs = join(root, "src-tauri", "src", "lib.rs");
const docMd = join(
  root,
  "docs",
  "architecture",
  "two-process-model.md",
);

const BACKTICK = String.fromCharCode(96);

/** Registered command names from lib.rs's generate_handler! block. */
function collectRegistered() {
  const text = readFileSync(libRs, "utf8").replaceAll("\r\n", "\n");
  const start = text.indexOf("generate_handler![");
  if (start === -1) {
    console.error(
      "check-doc-commands: generate_handler! not found in src-tauri/src/lib.rs",
    );
    process.exit(2);
  }
  const end = text.indexOf("]", start);
  const block = text.slice(start + "generate_handler![".length, end);
  const names = new Set();
  for (const raw of block.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    // `module::command` -> `command`; bare `command` -> `command`.
    const name = token.split("::").pop().trim();
    if (/^[a-z_][a-z0-9_]*$/.test(name)) names.add(name);
  }
  return names;
}

/**
 * Catalog entries: a list item whose very first token is a backticked
 * identifier, e.g. "- `pty_open` - create a new PTY session". Multiple commands
 * may share one bullet separated by " / ", so every leading run of
 * backticked-identifier-slash pairs is taken.
 */
function collectCatalogEntries(doc) {
  const found = new Map(); // name -> line number
  const item = new RegExp(`^\\s*[-*]\\s+((?:${BACKTICK}[a-z_][a-z0-9_]*${BACKTICK}\\s*/?\\s*)+)`);
  const name = new RegExp(`${BACKTICK}([a-z_][a-z0-9_]*)${BACKTICK}`, "g");
  const lines = doc.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = item.exec(lines[i]);
    if (!head) continue;
    for (const m of head[1].matchAll(name)) {
      if (!found.has(m[1])) found.set(m[1], i + 1);
    }
  }
  return found;
}

const registered = collectRegistered();
const doc = readFileSync(docMd, "utf8").replaceAll("\r\n", "\n");
const catalog = collectCatalogEntries(doc);

const missing = [...registered].filter((n) => !catalog.has(n)).sort();
const stale = [...catalog.keys()].filter((n) => !registered.has(n)).sort();

if (missing.length > 0 || stale.length > 0) {
  if (missing.length > 0) {
    console.error(
      `\n✗ ${missing.length} Tauri command(s) registered in generate_handler! ` +
        `have no entry in the docs/architecture/two-process-model.md catalog:\n`,
    );
    for (const name of missing) console.error(`  - ${name}`);
    console.error(
      "\nAdd them to the catalog under their module's section. A description in\n" +
        "prose elsewhere does not count: the catalog is where a reader looks.\n",
    );
  }
  if (stale.length > 0) {
    console.error(
      `\n✗ ${stale.length} catalog entr(ies) in two-process-model.md name no ` +
        `registered command:\n`,
    );
    for (const name of stale) {
      console.error(`  - ${name}  (doc line ${catalog.get(name)})`);
    }
    console.error(
      "\nRemove or correct them: a documented command that does not exist sends\n" +
        "readers to an API that will fail at runtime.\n",
    );
  }
  process.exit(1);
}

console.log(
  `✓ docs catalog matches generate_handler!: ${registered.size} registered, ` +
    `${catalog.size} catalogued, 0 missing, 0 stale`,
);