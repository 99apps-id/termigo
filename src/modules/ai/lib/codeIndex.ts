import { canonicalDirPath } from "@/lib/path";
import { native } from "./native";

// ─── Types ────────────────────────────────────────────────────────────────

export type CodeChunk = {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  tokens: string[];
  tokenCounts: Map<string, number>;
  scopeHeader?: string;
};

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
    // Split camelCase, PascalCase, or snake_case into sub-tokens
    const subWords = word
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/_/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

    if (subWords.length > 1) {
      for (const sw of subWords) {
        if (sw !== lower) {
          tokens.push(sw);
        }
      }
    }
  }
  return tokens;
}

// ─── Chunking ─────────────────────────────────────────────────────────────

const CHUNK_LINES = 80;
const CHUNK_OVERLAP = 20;

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
      const searchMin = Math.max(start + CHUNK_OVERLAP, end - 15);
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

    // Step BACK by the overlap so the next chunk re-reads the tail of this one.
    // The previous `Math.max(start + CHUNK_OVERLAP, end)` could never be below
    // `end` (the boundary search above only lowers `end` to
    // `start + CHUNK_OVERLAP` at worst), so chunks were strictly adjacent and
    // CHUNK_OVERLAP was dead: a declaration straddling a boundary had its
    // signature in one chunk and its body in the next, and no BM25 chunk ever
    // saw both.
    i = Math.max(start + 1, end - CHUNK_OVERLAP);
    if (i >= lines.length) break;
  }
  return chunks;
}

// ─── Index & BM25 Stats ───────────────────────────────────────────────────

const index = new Map<string, CodeChunk[]>();
const docFrequencies = new Map<string, number>();
let totalChunksCount = 0;
let totalTokensCount = 0;

/** Path -> mtime/size as of the moment the file was indexed. A saved index is
 *  checked against this before it is reused, so an index that describes a tree
 *  that no longer exists cannot answer a search. */
const fileFingerprints = new Map<string, { mtime: number; size: number }>();

let indexedRoot: string | null = null;

/** How many indexable files the last walk returned, including the ones the
 *  build then skipped. Persisted with the cache so the freshness check can
 *  compare like with like (see SerializedCodeIndex). */
let scannedCount = 0;

export function getIndexedRoot(): string | null {
  return indexedRoot;
}

/**
 * Drop `paths` from the in-memory index so the next search re-reads them.
 *
 * Without this the index lived for the whole process lifetime: an agent that
 * edits a file and then searches it was answered from the pre-edit chunk text
 * with the pre-edit line numbers, so every `read_file` at a reported line read
 * the wrong code, and the only recovery was an app restart.
 *
 * Returns how many indexed paths were actually dropped.
 */
export function invalidateIndexedPaths(paths: readonly string[]): number {
  let removed = 0;
  for (const raw of paths) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    const wanted = normalizeIndexKey(raw);
    let key: string | null = null;
    for (const candidate of index.keys()) {
      if (normalizeIndexKey(candidate) === wanted) {
        key = candidate;
        break;
      }
    }
    if (key === null) continue;
    const chunks = index.get(key);
    if (!chunks) continue;
    for (const chunk of chunks) {
      for (const term of new Set(chunk.tokens)) {
        const df = docFrequencies.get(term);
        if (df == null) continue;
        if (df <= 1) docFrequencies.delete(term);
        else docFrequencies.set(term, df - 1);
      }
      totalChunksCount = Math.max(0, totalChunksCount - 1);
      totalTokensCount = Math.max(0, totalTokensCount - chunk.tokens.length);
    }
    index.delete(key);
    fileFingerprints.delete(key);
    removed++;
  }
  return removed;
}

/** Index keys arrive from a glob (forward slashes); fs-change events arrive
 *  with the OS separator, so both sides are folded before comparing. */
function normalizeIndexKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export function clearIndex(): void {
  index.clear();
  docFrequencies.clear();
  fileFingerprints.clear();
  totalChunksCount = 0;
  totalTokensCount = 0;
  scannedCount = 0;
  indexedRoot = null;
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

export const CODE_INDEX_CACHE_REL_PATH = ".termigo/code-index.json";

function codeIndexCachePath(root: string): string {
  return `${canonicalDirPath(root)}/${CODE_INDEX_CACHE_REL_PATH}`;
}

export type SerializedCodeChunk = {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  tokens: string[];
  scopeHeader?: string;
};

export type SerializedCodeFile = {
  path: string;
  mtime: number;
  size: number;
  chunks: SerializedCodeChunk[];
};

/** `version: 3` adds `scanned`: how many indexable files the walk returned,
 *  including the ones the build then skipped (binary, over the size cap,
 *  unreadable). `version: 2` compared the on-disk walk against the number of
 *  files that actually reached the index, so a tree containing even one
 *  skippable file could never validate its own cache: every start rebuilt the
 *  whole index and rewrote the same unusable file. */
export type SerializedCodeIndex = {
  version: 3;
  root: string;
  savedAt: number;
  scanned: number;
  totalChunksCount: number;
  totalTokensCount: number;
  docFrequencies: [string, number][];
  files: SerializedCodeFile[];
};

/** The files an index build may read, from a single glob.
 *
 *  The build and the cache check both go through here, and that is load
 *  bearing: if the two filtered differently, every load would compare a
 *  manifest against a differently shaped one and invalidate a good cache. */
async function collectIndexableFiles(
  root: string,
): Promise<{ path: string; mtime: number; size: number }[]> {
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
  return files;
}

export async function saveIndexCache(root: string | null): Promise<boolean> {
  if (!root || index.size === 0) return false;
  try {
    const dir = `${canonicalDirPath(root)}/.termigo`;
    try {
      await native.createDir(dir);
    } catch {
      // already exists
    }
    const filesList: SerializedCodeFile[] = [];
    for (const [path, chunks] of index.entries()) {
      const fingerprint = fileFingerprints.get(path);
      // No fingerprint means the entry did not come from a file walk; the cache
      // check would reject it on the next load anyway.
      if (!fingerprint) continue;
      filesList.push({
        path,
        mtime: fingerprint.mtime,
        size: fingerprint.size,
        chunks: chunks.map((c) => ({
          path: c.path,
          startLine: c.startLine,
          endLine: c.endLine,
          text: c.text,
          tokens: c.tokens,
          scopeHeader: c.scopeHeader,
        })),
      });
    }
    const payload: SerializedCodeIndex = {
      version: 3,
      root: canonicalDirPath(root),
      savedAt: Date.now(),
      scanned: scannedCount,
      totalChunksCount,
      totalTokensCount,
      docFrequencies: Array.from(docFrequencies.entries()),
      files: filesList,
    };
    await native.writeFile(codeIndexCachePath(root), JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export async function loadIndexCache(
  root: string | null,
): Promise<{ files: number; chunks: number } | null> {
  if (!root) return null;
  try {
    const res = await native.readFile(codeIndexCachePath(root));
    if (res.kind !== "text" || !res.content) return null;
    const data = JSON.parse(res.content) as SerializedCodeIndex;
    // Canonical compare: the same tree spelled with a trailing slash or with
    // Windows backslashes is the same cache. A raw compare dropped a valid
    // index and then overwrote it under the other spelling, so every call paid
    // a full rebuild and neither spelling ever hit.
    if (
      data.version !== 3 ||
      canonicalDirPath(data.root) !== canonicalDirPath(root)
    ) {
      return null;
    }

    // Freshness check. Version and root alone are not enough: that combination
    // was reused forever, so `code_search` kept answering from a tree that had
    // since changed, across restarts and after every edit, with no signal to
    // the caller. One glob of path+mtime+size decides it.
    const onDisk = new Map(
      (await collectIndexableFiles(root)).map((f) => [f.path, f]),
    );
    // Compared against `scanned`, the count the WALK returned, not the number
    // of files that reached the index. Skipped files (binary, over the size
    // cap, unreadable) are part of the tree: counting only indexed ones made
    // the check unsatisfiable whenever a single file was skipped, so the cache
    // was dead on arrival and every start paid a full rebuild.
    if (onDisk.size !== (data.scanned ?? data.files.length)) return null;
    for (const f of data.files) {
      const current = onDisk.get(f.path);
      if (!current || current.mtime !== f.mtime || current.size !== f.size) {
        return null;
      }
    }

    clearIndex();
    indexedRoot = root;
    totalChunksCount = data.totalChunksCount;
    totalTokensCount = data.totalTokensCount;
    for (const [term, freq] of data.docFrequencies) {
      docFrequencies.set(term, freq);
    }
    for (const f of data.files) {
      const chunks: CodeChunk[] = f.chunks.map((c) => {
        const counts = new Map<string, number>();
        for (const t of c.tokens) {
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
        return {
          path: c.path,
          startLine: c.startLine,
          endLine: c.endLine,
          text: c.text,
          tokens: c.tokens,
          tokenCounts: counts,
          scopeHeader: c.scopeHeader,
        };
      });
      fileFingerprints.set(f.path, { mtime: f.mtime, size: f.size });
      index.set(f.path, chunks);
    }
    return { files: data.files.length, chunks: totalChunksCount };
  } catch {
    return null;
  }
}

export async function indexWorkspace(
  root: string | null,
  forceReindex = false,
  persist = false,
): Promise<{ files: number; chunks: number }> {
  if (!root) {
    clearIndex();
    return { files: 0, chunks: 0 };
  }

  if (!forceReindex) {
    const cached = await loadIndexCache(root);
    if (cached && cached.chunks > 0) {
      return cached;
    }
  }

  index.clear();
  docFrequencies.clear();
  fileFingerprints.clear();
  totalChunksCount = 0;
  totalTokensCount = 0;
  scannedCount = 0;
  indexedRoot = root;

  let files = 0;

  for (const hit of await collectIndexableFiles(root)) {
    scannedCount++;
    try {
      const read = await native.readFile(hit.path);
      if (read.kind !== "text" || !read.content) continue;
      if (read.size > 500_000) continue; // Skip huge generated files

      const lines = read.content.replace(/\r\n/g, "\n").split("\n");
      const pieces = chunkLines(lines);
      const indexed: CodeChunk[] = [];

      for (const p of pieces) {
        const tokens = tokenize(p.text);
        const counts = new Map<string, number>();
        const seenInChunk = new Set<string>();

        for (const t of tokens) {
          counts.set(t, (counts.get(t) ?? 0) + 1);
          if (!seenInChunk.has(t)) {
            seenInChunk.add(t);
            docFrequencies.set(t, (docFrequencies.get(t) ?? 0) + 1);
          }
        }

        totalChunksCount++;
        totalTokensCount += tokens.length;

        indexed.push({
          path: hit.path,
          startLine: p.start + 1,
          endLine: p.end,
          text: p.text,
          tokens,
          tokenCounts: counts,
          scopeHeader: p.scopeHeader,
        });
      }

      index.set(hit.path, indexed);
      // Fingerprint the metadata the READ observed, not the glob's: `fs_read_file`
      // stats the file itself, so this is the state the chunks actually describe.
      // Recording the walk's older stat let a file edited mid-walk be cached
      // under its pre-edit fingerprint, which the next load then accepted and
      // served stale chunks from.
      fileFingerprints.set(hit.path, {
        mtime: read.mtime ?? hit.mtime,
        size: read.size || hit.size,
      });
      files++;
    } catch {
      // skip unreadable files
    }
  }

  // Only the workspace root keeps a cache file. Caching any `root` put a
  // multi-megabyte `.termigo/code-index.json` into whatever directory was
  // searched, so indexing a subdirectory or a third-party checkout planted an
  // index inside that tree (13 such directories, 58 MB, in this repository).
  if (files > 0 && persist) {
    await saveIndexCache(root);
  }

  return { files, chunks: totalChunksCount };
}

// ─── Search & Snippet Extraction ──────────────────────────────────────────

function extractCenteredSnippet(
  chunk: CodeChunk,
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

/**
 * Whether `filePath` matches the caller's `path_filter`.
 *
 * Anchored on path segments, not a raw substring: an unanchored
 * `includes("ai")` also matches `src/utils/tail.ts` and `src/detail.ts`, so
 * the filter silently WIDENED the result set the model believed it had
 * narrowed. A filter matches when it equals the whole path, ends at a segment
 * boundary, or starts at one.
 */
export function matchesPathFilter(
  filePath: string,
  filterPath: string,
): boolean {
  const path = filePath.toLowerCase().replace(/\\/g, "/");
  const filter = filterPath
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "");
  if (!filter) return true;
  if (path === filter) return true;
  if (path.endsWith(`/${filter}`)) return true;
  if (path.startsWith(`${filter}/`)) return true;
  return path.includes(`/${filter}/`);
}

/**
 * Searches indexed code using Okapi BM25 scoring with path weighting
 * and exact-match bonus.
 */
export function searchCode(
  query: string,
  maxResults = 10,
  filterPath?: string,
): SearchResult[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || totalChunksCount === 0) return [];

  const k1 = 1.2;
  const b = 0.75;
  const avgdl = Math.max(1, totalTokensCount / totalChunksCount);
  const queryLower = query.toLowerCase().trim();

  const scored: { chunk: CodeChunk; score: number }[] = [];

  for (const [filePath, chunks] of index.entries()) {
    if (filterPath && !matchesPathFilter(filePath, filterPath)) {
      continue;
    }

    const pathLower = filePath.toLowerCase();
    const pathTokens = tokenize(filePath);

    for (const chunk of chunks) {
      let bm25Score = 0;
      const chunkLen = chunk.tokens.length;

      for (const qt of queryTokens) {
        const tf = chunk.tokenCounts.get(qt) ?? 0;
        const df = docFrequencies.get(qt) ?? 0;
        if (df === 0) continue;

        // Smoothed BM25 IDF
        const idf = Math.log(1 + (totalChunksCount - df + 0.5) / (df + 0.5));
        // BM25 term weight
        const num = tf * (k1 + 1);
        const denom = tf + k1 * (1 - b + b * (chunkLen / avgdl));
        const termScore = idf * (num / denom);

        bm25Score += termScore;

        // Path boosting: if query term matches file path/name
        if (pathTokens.includes(qt)) {
          bm25Score += idf * 1.5;
        }
      }

      // Exact substring match bonus
      if (
        queryLower.length > 2 &&
        chunk.text.toLowerCase().includes(queryLower)
      ) {
        bm25Score += 2.5;
      }
      if (queryLower.length > 2 && pathLower.includes(queryLower)) {
        bm25Score += 4.0;
      }

      if (bm25Score > 0) {
        scored.push({ chunk, score: bm25Score });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, maxResults).map(({ chunk, score }) => {
    const windowSize = 8;
    const { snippet, startLine } = extractCenteredSnippet(
      chunk,
      queryTokens,
      windowSize,
    );
    // The snippet holds at most `windowSize` lines starting at `startLine`, so
    // the last line is `startLine + windowSize - 1`. The old `+ windowSize`
    // reported a range one line longer than the text it shipped, and a caller
    // reading to `endLine` pulled in an unrelated line.
    const lastLine = Math.min(
      chunk.endLine,
      startLine + windowSize - 1,
      chunk.startLine + chunk.text.split("\n").length - 1,
    );
    return {
      path: chunk.path,
      startLine,
      endLine: Math.max(startLine, lastLine),
      score: Number(score.toFixed(3)),
      snippet,
      scopeHeader: chunk.scopeHeader,
    };
  });
}

export function getIndexStats(): { files: number; chunks: number } {
  let files = 0;
  let chunks = 0;
  for (const [_, cs] of index) {
    files++;
    chunks += cs.length;
  }
  return { files, chunks };
}
