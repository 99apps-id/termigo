import { native } from "./native";

// ─── Types ────────────────────────────────────────────────────────────────

export type CodeChunk = {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  tokens: string[];
  tokenCounts: Map<string, number>;
};

export type SearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
};

// ─── Tokenizer ────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off", "over",
  "under", "again", "further", "then", "once", "here", "there", "when",
  "where", "why", "how", "all", "both", "each", "few", "more", "most",
  "other", "some", "such", "no", "nor", "not", "only", "own", "same",
  "so", "than", "too", "very", "just", "because", "but", "and", "or",
  "if", "while", "about", "up", "down", "this", "that", "these", "those",
  "const", "let", "var", "function", "return", "import", "export",
  "true", "false", "null", "undefined",
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

function chunkLines(lines: string[]): { start: number; end: number; text: string }[] {
  const chunks: { start: number; end: number; text: string }[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = i;
    const end = Math.min(i + CHUNK_LINES, lines.length);
    const text = lines.slice(start, end).join("\n");
    chunks.push({ start, end, text });
    i += CHUNK_LINES - CHUNK_OVERLAP;
    if (i >= lines.length) break;
    if (i < start + CHUNK_OVERLAP) i = start + CHUNK_OVERLAP;
  }
  return chunks;
}

// ─── Index & BM25 Stats ───────────────────────────────────────────────────

const index = new Map<string, CodeChunk[]>();
const docFrequencies = new Map<string, number>();
let totalChunksCount = 0;
let totalTokensCount = 0;

export const INDEXABLE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".md",
  ".json", ".yaml", ".yml", ".toml", ".sql", ".sh", ".c",
  ".cpp", ".h", ".html", ".css",
];

const IGNORED_PATH_PARTS = [
  "/node_modules/", "\\node_modules\\",
  "/target/", "\\target\\",
  "/dist/", "\\dist\\",
  "/dist-win/", "\\dist-win\\",
  "/.git/", "\\.git\\",
  "/.termigo/", "\\.termigo\\",
  "/.vscode/", "\\.vscode\\",
  "/build/", "\\build\\",
  "/coverage/", "\\coverage\\",
  "/.next/", "\\.next\\",
];

const IGNORED_FILENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
]);

function shouldSkipPath(path: string): boolean {
  for (const part of IGNORED_PATH_PARTS) {
    if (path.includes(part)) return true;
  }
  const basename = path.split(/[/\\]/).pop() ?? "";
  if (IGNORED_FILENAMES.has(basename)) return true;
  if (basename.endsWith(".min.js") || basename.endsWith(".min.css")) return true;
  return false;
}

export async function indexWorkspace(
  root: string | null,
): Promise<{ files: number; chunks: number }> {
  if (!root) return { files: 0, chunks: 0 };
  index.clear();
  docFrequencies.clear();
  totalChunksCount = 0;
  totalTokensCount = 0;

  let files = 0;

  for (const ext of INDEXABLE_EXTENSIONS) {
    try {
      const result = await native.glob({ pattern: `**/*${ext}`, root });
      for (const hit of result.hits) {
        if (shouldSkipPath(hit.path)) continue;
        try {
          const read = await native.readFile(hit.path);
          if (read.kind !== "text" || !read.content) continue;
          if (read.size > 500_000) continue; // Skip huge generated files

          const lines = read.content.split("\n");
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
            });
          }

          index.set(hit.path, indexed);
          files++;
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // ignore glob errors
    }
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
  let endIdx = Math.min(lines.length, startIdx + windowSize);
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
    if (filterPath && !filePath.toLowerCase().includes(filterPath.toLowerCase())) {
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
      if (queryLower.length > 2 && chunk.text.toLowerCase().includes(queryLower)) {
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
    const { snippet, startLine } = extractCenteredSnippet(chunk, queryTokens, 8);
    return {
      path: chunk.path,
      startLine,
      endLine: Math.min(chunk.endLine, startLine + 8),
      score: Number(score.toFixed(3)),
      snippet,
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
