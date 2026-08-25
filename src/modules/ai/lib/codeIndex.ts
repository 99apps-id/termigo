import { native } from "./native";

// ─── Types ────────────────────────────────────────────────────────────────

export type CodeChunk = {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  tokens: string[];
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
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
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

// ─── Index ────────────────────────────────────────────────────────────────

const index = new Map<string, CodeChunk[]>();

export async function indexWorkspace(root: string | null): Promise<{ files: number; chunks: number }> {
  if (!root) return { files: 0, chunks: 0 };
  index.clear();

  const extensions = [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".md"];
  let files = 0;
  let chunks = 0;

  for (const ext of extensions) {
    try {
      const result = await native.glob({ pattern: `**/*${ext}`, root });
      for (const hit of result.hits) {
        try {
          const read = await native.readFile(hit.path);
          if (read.kind !== "text" || !read.content) continue;
          const lines = read.content.split("\n");
          const pieces = chunkLines(lines);
          const indexed = pieces.map((p) => {
            const chunk: CodeChunk = {
              path: hit.path,
              startLine: p.start + 1,
              endLine: p.end,
              text: p.text,
              tokens: tokenize(p.text),
            };
            return chunk;
          });
          index.set(hit.path, indexed);
          files++;
          chunks += indexed.length;
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // ignore glob errors
    }
  }

  return { files, chunks };
}

export function searchCode(query: string, maxResults = 10): SearchResult[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const scored: { chunk: CodeChunk; score: number }[] = [];

  for (const chunks of index.values()) {
    for (const chunk of chunks) {
      let score = 0;
      for (const qt of queryTokens) {
        const tf = chunk.tokens.filter((t) => t === qt).length;
        if (tf > 0) score += tf / (1 + Math.log(chunk.tokens.length + 1));
      }
      if (score > 0) scored.push({ chunk, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, maxResults).map(({ chunk, score }) => {
    const lines = chunk.text.split("\n");
    const snippet = lines.slice(0, 8).join("\n");
    return {
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score,
      snippet: snippet + (lines.length > 8 ? "\n..." : ""),
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
