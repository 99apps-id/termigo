import { canonicalDirPath } from "@/lib/path";
import { invoke } from "@tauri-apps/api/core";
import { native } from "./native";

// ─── Types ────────────────────────────────────────────────────────────────

export type SearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  scopeHeader?: string;
};

// ─── Tokenizer ────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "because",
  "but",
  "and",
  "or",
  "if",
  "while",
  "about",
  "up",
  "down",
  "this",
  "that",
  "these",
  "those",
  "const",
  "let",
  "var",
  "function",
  "return",
  "import",
  "export",
  "true",
  "false",
  "null",
  "undefined",
]);

/** Words of one character are dropped on purpose: as index terms they
 *  would match nearly everything, and the exact-substring bonus in search
 *  still finds the literal text. Indexing and querying share this one
 *  function, so the policy can never drift between the two sides. */
export function tokenize(text: string): string[] {
  const rawWords = text
    .replace(/[^a-zA-Z0-9_]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

  const tokens: string[] = [];
  for (const word of rawWords) {
    const lower = word.toLowerCase();
    if (!STOP_WORDS.has(lower)) {
      tokens.push(lower);
    }
    // Split camelCase, PascalCase, snake_case, and digit-to-letter humps
    // (sha256Hash -> sha256 + hash) into sub-tokens. A lone sub-token still
    // counts when it differs from the word itself, so an underscore-wrapped
    // stem (__init__, _private) is findable by its stem. One word
    // contributes each sub-token once: fooFoo must not count foo twice.
    const subWords = word
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/_/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

    for (const sw of new Set(subWords)) {
      if (sw !== lower) {
        tokens.push(sw);
      }
    }
  }
  return tokens;
}

// ─── Chunking ─────────────────────────────────────────────────────────────

const CHUNK_LINES = 80;
/** Minimum lines a chunk spans before the next one starts. Despite the
 *  historical name (overlap), chunks are strictly adjacent: this is the
 *  step floor that keeps a boundary snap from producing slivers. */
const CHUNK_MIN_SPAN = 20;

const DECLARATION_BOUNDARY_REGEX =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|impl|trait|fn|def|pub(?:\s*\([^)]+\))?\s+(?:fn|struct|enum|trait|type|impl)|const\s+[A-Z0-9_]+\s*=|var\s+[A-Z0-9_]+\s*=)/;

export function findScopeHeader(
  lines: string[],
  currentLineIndex: number,
): string | null {
  for (let i = currentLineIndex; i >= Math.max(0, currentLineIndex - 25); i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    if (DECLARATION_BOUNDARY_REGEX.test(line)) {
      const match = line.slice(0, 80);
      return match.endsWith("{") || match.endsWith(":")
        ? match
        : `${match} ...`;
    }
  }
  return null;
}

export function chunkLines(
  lines: string[],
): { start: number; end: number; text: string; scopeHeader?: string }[] {
  const chunks: {
    start: number;
    end: number;
    text: string;
    scopeHeader?: string;
  }[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = i;
    let end = Math.min(i + CHUNK_LINES, lines.length);

    // If we are not at the end of the file, prefer breaking at a declaration boundary or empty line
    if (end < lines.length) {
      const searchMin = Math.max(start + CHUNK_MIN_SPAN, end - 15);
      for (let cand = end; cand >= searchMin; cand--) {
        const line = lines[cand]?.trim() ?? "";
        if (DECLARATION_BOUNDARY_REGEX.test(line) || line === "") {
          end = cand;
          break;
        }
      }
    }

    const slice = lines.slice(start, end);
    const scopeHeader = findScopeHeader(lines, start) ?? undefined;
    const text = slice.join("\n");
    chunks.push({ start, end, text, scopeHeader });

    i = Math.max(start + CHUNK_MIN_SPAN, end);
    if (i >= lines.length) break;
  }
  return chunks;
}

// ─── FTS5 index (Rust side) ─────────────────────────────────────────────
//
// Storage, freshness, matching and ranking live in SQLite FTS5 behind the
// codeindex_* commands (src-tauri/src/modules/codeindex.rs). This module
// keeps the parts FTS5 cannot do: the walk, the chunker, and the code-aware
// tokenizer (FTS5's unicode61 tokenizer cannot split camelCase or
// snake_case, so the indexed stream is pre-tokenized here). The database
// sits in the app data directory: nothing is written into the indexed tree
// anymore, where the old JSON cache planted a multi-megabyte copy of the
// corpus as `.termigo/code-index.json`.

type FtsChunkInput = {
  startLine: number;
  endLine: number;
  scopeHeader: string | null;
  text: string;
  /** Space-joined token stream for the chunk. */
  tokens: string;
};

type FtsFileInput = {
  path: string;
  mtime: number;
  size: number;
  /** Space-joined token stream for the file path, indexed with a high
   *  ranking weight so a term naming the file outranks a body mention. */
  pathTokens: string;
  chunks: FtsChunkInput[];
};

type FtsSearchHit = {
  path: string;
  startLine: number;
  endLine: number;
  scopeHeader: string | null;
  text: string;
  score: number;
};

let indexedRoot: string | null = null;
let indexStats = { files: 0, chunks: 0, truncated: false };

export function getIndexedRoot(): string | null {
  return indexedRoot;
}

export function getIndexStats(): {
  files: number;
  chunks: number;
  truncated: boolean;
} {
  return { ...indexStats };
}

/** Forget which root this session indexed. The FTS rows stay in the
 *  database: they are fingerprint-checked before any reuse, so a later
 *  search revalidates instead of trusting them. */
export function clearIndex(): void {
  indexedRoot = null;
  indexStats = { files: 0, chunks: 0, truncated: false };
}

export const INDEXABLE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".rs",
  ".go",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".sql",
  ".sh",
  ".c",
  ".cpp",
  ".h",
  ".html",
  ".css",
];

/** One walk for every extension instead of one walk per extension.
 *  `INDEXABLE_EXTENSIONS` had 19 entries and each got its own full-tree glob. */
export const INDEXABLE_GLOB = `**/*.{${INDEXABLE_EXTENSIONS.map((e) => e.slice(1)).join(",")}}`;

/** Rust caps a glob at 2000 hits. Passing the cap explicitly matters: the old
 *  per-extension calls took the 500 default, so a repository with more than 500
 *  files of one extension was indexed only in part, silently. */
export const MAX_INDEXED_FILES = 2000;

const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  "target",
  "dist",
  "dist-win",
  ".git",
  ".termigo",
  ".vscode",
  "build",
  "coverage",
  ".next",
]);

const IGNORED_FILENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
]);

function shouldSkipPath(path: string): boolean {
  const parts = path.split(/[/\\]/);
  for (const part of parts) {
    if (IGNORED_DIR_NAMES.has(part)) return true;
  }
  const basename = parts[parts.length - 1] ?? "";
  if (IGNORED_FILENAMES.has(basename)) return true;
  if (basename.endsWith(".min.js") || basename.endsWith(".min.css"))
    return true;
  return false;
}

/** Where the pre-FTS5 index kept its JSON cache. The file is no longer
 *  written; a successful FTS5 build deletes the leftover so upgraded
 *  workspaces do not keep a stale multi-megabyte copy of their own code. */
export const CODE_INDEX_CACHE_REL_PATH = ".termigo/code-index.json";

function codeIndexCachePath(root: string): string {
  return `${canonicalDirPath(root)}/${CODE_INDEX_CACHE_REL_PATH}`;
}

/** The files an index build may read, from a single glob.
 *
 *  The build and the freshness check both go through here, and that is load
 *  bearing: if the two filtered differently, every comparison would compare
 *  a manifest against a differently shaped one and invalidate a good index.
 *  `truncated` reports that the walk hit the file cap, so callers can say
 *  the index covers only part of the tree instead of implying it is whole. */
async function collectIndexableFiles(root: string): Promise<{
  files: { path: string; mtime: number; size: number }[];
  truncated: boolean;
}> {
  const result = await native.glob({
    pattern: INDEXABLE_GLOB,
    root,
    maxResults: MAX_INDEXED_FILES,
  });
  const files: { path: string; mtime: number; size: number }[] = [];
  const seen = new Set<string>();
  for (const hit of result.hits) {
    if (seen.has(hit.path)) continue;
    seen.add(hit.path);
    if (shouldSkipPath(hit.path)) continue;
    files.push({ path: hit.path, mtime: hit.mtime ?? 0, size: hit.size ?? 0 });
  }
  return { files, truncated: result.truncated };
}

export async function indexWorkspace(
  root: string | null,
  forceReindex = false,
): Promise<{ files: number; chunks: number; truncated: boolean }> {
  if (!root) {
    clearIndex();
    return { files: 0, chunks: 0, truncated: false };
  }
  const canonicalRoot = canonicalDirPath(root);
  const { files, truncated } = await collectIndexableFiles(canonicalRoot);

  if (!forceReindex) {
    // Freshness is one fingerprint comparison on the Rust side: when the
    // tree is unchanged, no file is read and no chunk is rebuilt, across
    // restarts as well as within a session. A failed check (first run, no
    // database yet) falls through to the build below.
    try {
      const fresh = await invoke<{
        fresh: boolean;
        files: number;
        chunks: number;
      }>("codeindex_check_fresh", {
        root: canonicalRoot,
        files: files.map((f) => ({
          path: f.path,
          mtime: f.mtime,
          size: f.size,
        })),
      });
      if (fresh.fresh) {
        indexedRoot = canonicalRoot;
        indexStats = { files: fresh.files, chunks: fresh.chunks, truncated };
        return { ...indexStats };
      }
    } catch {
      // fall through to a rebuild
    }
  }

  const inputs: FtsFileInput[] = [];
  for (const hit of files) {
    // A file the build cannot index still gets a row (with no chunks) when
    // the skip is a property of the file itself. Freshness compares the
    // glob against the stored rows, so an unrecorded empty or oversized
    // file would invalidate the whole index on every single search.
    const unindexed: FtsFileInput = {
      path: hit.path,
      mtime: hit.mtime,
      size: hit.size,
      pathTokens: tokenize(hit.path).join(" "),
      chunks: [],
    };
    if (hit.size > 500_000) {
      inputs.push(unindexed); // Huge generated file; never worth the read.
      continue;
    }
    try {
      const read = await native.readFile(hit.path);
      if (read.kind !== "text" || !read.content || read.size > 500_000) {
        inputs.push(unindexed);
        continue;
      }

      const lines = read.content.replace(/\r\n/g, "\n").split("\n");
      const pieces = chunkLines(lines);
      inputs.push({
        path: hit.path,
        mtime: hit.mtime,
        size: hit.size,
        pathTokens: tokenize(hit.path).join(" "),
        chunks: pieces.map((p) => ({
          startLine: p.start + 1,
          endLine: p.end,
          scopeHeader: p.scopeHeader ?? null,
          text: p.text,
          tokens: tokenize(p.text).join(" "),
        })),
      });
    } catch {
      // Unreadable right now (permissions, a write in flight): leave the
      // file unrecorded, so the next search retries the build instead of
      // trusting a fingerprint for content that was never seen.
    }
  }

  const stats = await invoke<{ files: number; chunks: number }>(
    "codeindex_replace_root",
    { root: canonicalRoot, files: inputs },
  );
  indexedRoot = canonicalRoot;
  indexStats = { files: stats.files, chunks: stats.chunks, truncated };
  void deleteLegacyCache(canonicalRoot);
  return { ...indexStats };
}

/** Remove a pre-FTS5 JSON cache from the tree, best effort. The old index
 *  wrote it into the workspace itself; leaving it behind would keep a stale
 *  copy of the corpus on disk that nothing reads anymore. */
async function deleteLegacyCache(root: string): Promise<void> {
  try {
    await native.deletePath(codeIndexCachePath(root));
  } catch {
    // already gone, or not ours to remove
  }
}

// ─── Search & Snippet Extraction ──────────────────────────────────────────

function extractCenteredSnippet(
  chunk: { text: string; startLine: number },
  queryTokens: string[],
  windowSize = 8,
): { snippet: string; startLine: number } {
  const lines = chunk.text.split("\n");
  if (lines.length <= windowSize) {
    return { snippet: chunk.text, startLine: chunk.startLine };
  }

  let bestLine = 0;
  let maxMatches = -1;
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    let matches = 0;
    for (const qt of queryTokens) {
      if (lineLower.includes(qt)) matches++;
    }
    if (matches > maxMatches) {
      maxMatches = matches;
      bestLine = i;
    }
  }

  const half = Math.floor(windowSize / 2);
  let startIdx = Math.max(0, bestLine - half);
  const endIdx = Math.min(lines.length, startIdx + windowSize);
  if (endIdx - startIdx < windowSize) {
    startIdx = Math.max(0, endIdx - windowSize);
  }

  const snippetLines = lines.slice(startIdx, endIdx);
  const snippet =
    (startIdx > 0 ? "...\n" : "") +
    snippetLines.join("\n") +
    (endIdx < lines.length ? "\n..." : "");

  return { snippet, startLine: chunk.startLine + startIdx };
}

/** The distinct tokens a query searches for, in first-use order. FTS5
 *  matches them with OR; a repeated term must not count twice. */
export function queryTokens(query: string): string[] {
  return [...new Set(tokenize(query))];
}

/**
 * Searches indexed code with FTS5: bm25 ranking over the pre-tokenized
 * chunk stream, path-token weighting, and exact substring bonuses (the
 * bonuses are applied on the Rust side). Snippets are centered here, where
 * the chunk text already is.
 */
export async function searchCode(
  query: string,
  maxResults = 10,
  filterPath?: string,
): Promise<SearchResult[]> {
  if (!indexedRoot || indexStats.chunks === 0) return [];
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];

  const hits = await invoke<FtsSearchHit[]>("codeindex_search", {
    root: indexedRoot,
    queryTokens: tokens,
    queryText: query,
    maxResults,
    filterPath: filterPath ?? null,
  });

  return hits.map((hit) => {
    const { snippet, startLine } = extractCenteredSnippet(
      { text: hit.text, startLine: hit.startLine },
      tokens,
      8,
    );
    // The reported range covers exactly the lines the snippet shows: the
    // window is 8 lines, so its last line is startLine + shown - 1, never
    // startLine + 8.
    const shownLines = snippet.split("\n").filter((l) => l !== "...").length;
    return {
      path: hit.path,
      startLine,
      endLine: Math.min(hit.endLine, startLine + Math.max(0, shownLines - 1)),
      score: hit.score,
      snippet,
      scopeHeader: hit.scopeHeader ?? undefined,
    };
  });
}
