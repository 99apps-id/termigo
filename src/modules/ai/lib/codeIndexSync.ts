// Keeps the code-search index honest while the agent works.
//
// The index is built once per process and used to answer `code_search`. An
// agent edits files constantly, and nothing used to tell the index: a search
// after an `edit` was answered from the pre-edit chunk text with pre-edit line
// numbers, so the follow-up `read_file` read the wrong code for the rest of
// the session. The Rust fs watcher already emits every change, so this is a
// thin subscriber that drops the affected paths; the next search re-reads them.

import { invalidateIndexedPaths } from "./codeIndex";
import { listenFsChanged } from "@/modules/explorer/lib/watch";

let started = false;
let unlisten: (() => void) | null = null;

/** Idempotent: dev double-mounts effects, and a second listener would just
 *  repeat the same invalidation. */
export function startCodeIndexSync(): void {
  if (started) return;
  started = true;
  void listenFsChanged((paths) => {
    if (!Array.isArray(paths) || paths.length === 0) return;
    invalidateIndexedPaths(paths);
  }).then((fn) => {
    unlisten = fn;
  });
}

/** Test/teardown hook. */
export function stopCodeIndexSync(): void {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
  started = false;
}
