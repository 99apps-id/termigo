import { native } from "./native";

/**
 * Repository Map Engine & Semantic Architecture Extractor
 *
 * Provides a compact, high-signal architectural map of the workspace
 * (directory topology + key exported declarations/types/functions) for
 * instant semantic context injection into the agent's prompt.
 */

export const REPOMAP_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".rs",
  ".go",
  ".py",
  ".vue",
  ".svelte",
  ".c",
  ".cpp",
  ".h",
];

const REPOMAP_GLOB = `**/*.{${REPOMAP_EXTENSIONS.map((e) => e.slice(1)).join(",")}}`;

const IGNORED_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  "dist-win",
  ".git",
  ".termigo",
  ".vscode",
  ".idea",
  "build",
  "coverage",
  ".next",
  "out",
  ".turbo",
]);

const IGNORED_FILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "go.sum",
]);

export function shouldSkipRepoMapPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  for (const part of parts) {
    if (IGNORED_DIRS.has(part)) return true;
  }
  const basename = parts[parts.length - 1] ?? "";
  if (IGNORED_FILES.has(basename)) return true;
  if (basename.endsWith(".min.js") || basename.endsWith(".min.css"))
    return true;
  return false;
}

/**
 * Regular expressions for extracting high-signal declarations across
 * TypeScript/JavaScript, Rust, Go, and Python.
 */
const TS_DECL_REGEX =
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const)\s+([a-zA-Z0-9_$]+)/;
const RUST_DECL_REGEX =
  /^\s*pub(?:\s*\([^)]+\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type)\s+([a-zA-Z0-9_]+)/;
const GO_DECL_REGEX =
  /^\s*(?:func(?:\s*\([^)]+\))?\s+([A-Z][a-zA-Z0-9_]*)|type\s+([A-Z][a-zA-Z0-9_]*)\s+(?:struct|interface))/;
const PY_DECL_REGEX = /^\s*(?:def|class)\s+([a-zA-Z0-9_]+)/;

/**
 * Extract key exported or top-level symbols from file content.
 */
export function extractKeyDeclarations(
  content: string,
  maxSymbols = 8,
): string[] {
  if (!content) return [];
  const lines = content.split("\n");
  const symbols = new Set<string>();

  for (const line of lines) {
    if (symbols.size >= maxSymbols) break;
    const trimmed = line.trimEnd();
    if (
      !trimmed ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("#")
    ) {
      continue;
    }

    // TypeScript / JavaScript
    const tsMatch = trimmed.match(TS_DECL_REGEX);
    if (tsMatch?.[1]) {
      symbols.add(tsMatch[1]);
      continue;
    }

    // Rust
    const rustMatch = trimmed.match(RUST_DECL_REGEX);
    if (rustMatch?.[1]) {
      symbols.add(rustMatch[1]);
      continue;
    }

    // Go (exported functions / structs / interfaces start with uppercase)
    const goMatch = trimmed.match(GO_DECL_REGEX);
    if (goMatch) {
      const sym = goMatch[1] || goMatch[2];
      if (sym) {
        symbols.add(sym);
        continue;
      }
    }

    // Python
    const pyMatch = trimmed.match(PY_DECL_REGEX);
    if (pyMatch?.[1] && !pyMatch[1].startsWith("_")) {
      symbols.add(pyMatch[1]);
    }
  }

  return Array.from(symbols);
}

export type FileSymbolEntry = {
  relPath: string;
  symbols: string[];
};

/**
 * Format a list of file entries and their extracted symbols into a compact outline.
 */
export function formatRepoTree(
  entries: FileSymbolEntry[],
  maxChars = 2500,
): string {
  if (entries.length === 0) return "";

  // Sort files for consistent, hierarchical structure
  const sorted = entries
    .slice()
    .sort((a, b) => a.relPath.localeCompare(b.relPath));

  const lines: string[] = [];
  let currentLen = 0;
  let includedCount = 0;

  for (const entry of sorted) {
    const symbolSuffix =
      entry.symbols.length > 0 ? ` (${entry.symbols.join(", ")})` : "";
    const line = `- ${entry.relPath}${symbolSuffix}`;

    if (currentLen + line.length + 1 > maxChars) {
      const remaining = sorted.length - includedCount;
      if (remaining > 0) {
        lines.push(`... (+${remaining} more files)`);
      }
      break;
    }

    lines.push(line);
    currentLen += line.length + 1;
    includedCount++;
  }

  return lines.join("\n");
}

export type RepoMapCache = {
  root: string;
  cachedAt: number;
  content: string;
};

const repoMapMemoryCache = new Map<string, RepoMapCache>();
const CACHE_TTL_MS = 60_000; // 60 seconds TTL

export function clearRepoMapCache(): void {
  repoMapMemoryCache.clear();
}

/**
 * Generate a compact Repository Map for the given workspace root.
 */
export async function generateRepoMap(
  root: string,
  opts: { maxFiles?: number; maxChars?: number } = {},
): Promise<string | null> {
  if (!root) return null;
  const maxFiles = opts.maxFiles ?? 60;
  const maxChars = opts.maxChars ?? 2500;

  try {
    const globRes = await native.glob({
      pattern: REPOMAP_GLOB,
      root,
      maxResults: 300,
    });

    const candidateFiles: { path: string; relPath: string }[] = [];
    const rootNorm = root.replace(/\\/g, "/").replace(/\/+$/, "");

    for (const hit of globRes.hits) {
      if (shouldSkipRepoMapPath(hit.path)) continue;
      const pathNorm = hit.path.replace(/\\/g, "/");
      const relPath = pathNorm.startsWith(`${rootNorm}/`)
        ? pathNorm.slice(rootNorm.length + 1)
        : hit.path;

      candidateFiles.push({ path: hit.path, relPath });
    }

    if (candidateFiles.length === 0) return null;

    // Prioritize key source files (shorter paths, core source folders)
    candidateFiles.sort((a, b) => {
      const score = (p: string) => {
        let s = 0;
        if (
          p.startsWith("src/") ||
          p.startsWith("lib/") ||
          p.startsWith("cli/")
        )
          s += 20;
        if (
          p.endsWith("index.ts") ||
          p.endsWith("main.go") ||
          p.endsWith("main.rs") ||
          p.endsWith("lib.rs") ||
          p.endsWith("App.tsx")
        )
          s += 15;
        if (
          p.includes(".test.") ||
          p.includes(".spec.") ||
          p.includes("_test.")
        )
          s -= 10;
        s -= p.split("/").length * 2;
        return s;
      };
      return score(b.relPath) - score(a.relPath);
    });

    const selected = candidateFiles.slice(0, maxFiles);
    const entries: FileSymbolEntry[] = [];

    // Read top-level declarations concurrently in batches
    const BATCH_SIZE = 10;
    for (let i = 0; i < selected.length; i += BATCH_SIZE) {
      const batch = selected.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (item) => {
          const res = await native.readFile(item.path);
          if (res.kind === "text") {
            const symbols = extractKeyDeclarations(res.content);
            return { relPath: item.relPath, symbols };
          }
          return { relPath: item.relPath, symbols: [] };
        }),
      );

      for (const r of results) {
        if (r.status === "fulfilled" && r.value) {
          entries.push(r.value);
        }
      }
    }

    const tree = formatRepoTree(entries, maxChars);
    if (!tree) return null;

    return `## REPOSITORY MAP (Compact Top-Level Architecture)\n${tree}`;
  } catch {
    return null;
  }
}

/**
 * Retrieve cached RepoMap or generate a fresh one if missing or expired.
 */
export async function getOrGenerateRepoMap(
  root: string | null,
  opts: { maxFiles?: number; maxChars?: number } = {},
): Promise<string | null> {
  if (!root) return null;
  const now = Date.now();
  const cached = repoMapMemoryCache.get(root);
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.content;
  }

  const generated = await generateRepoMap(root, opts);
  if (generated) {
    repoMapMemoryCache.set(root, {
      root,
      cachedAt: now,
      content: generated,
    });
  }
  return generated;
}

/**
 * Format the RepoMap as a markdown block for inclusion into the system prompt.
 */
export function formatRepoMapBlock(repoMap: string | null): string {
  if (!repoMap?.trim()) return "";
  return `\n\n${repoMap.trim()}`;
}
