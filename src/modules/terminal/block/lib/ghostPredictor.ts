/**
 * Zero-Latency Context-Aware Terminal Ghost Text Engine
 *
 * Provides instant (<1ms) fish-style shell ghost suggestions based on
 * in-memory session history, common developer CLI patterns (Git, pnpm,
 * cargo, docker, python), and local workspace context without network
 * latency or IPC stalls.
 */

export const COMMON_CLI_PATTERNS: readonly string[] = [
  // Git workflows
  "git status",
  "git diff",
  "git diff --staged",
  "git add -A",
  'git commit -m ""',
  "git checkout -b",
  "git branch -a",
  "git pull --ff-only",
  "git push origin HEAD",
  'git stash push -m ""',
  "git stash pop",
  "git log --oneline -n 10",
  // Node / pnpm / npm / yarn / bun
  "pnpm install",
  "pnpm run dev",
  "pnpm run build",
  "pnpm test",
  "pnpm lint",
  "pnpm check-types",
  "npm run dev",
  "npm run build",
  "npm test",
  "bun run dev",
  "bun test",
  // Rust / Cargo
  "cargo check",
  "cargo test --locked",
  "cargo clippy --all-targets --locked",
  "cargo build --release",
  // Go & Python
  "go test ./...",
  "go run main.go",
  "python3 -m pytest",
  "python3 -m venv .venv",
  // Containers & Systems
  "docker compose up -d",
  "docker compose down",
  "docker ps -a",
];

export type GhostPredictorOptions = {
  /** In-memory list of recent commands from terminal history. */
  history?: readonly string[];
  /** Fallback command catalog. */
  patterns?: readonly string[];
};

/**
 * Predicts the full suggestion string given the current input line.
 * Returns null if no high-confidence suggestion matches.
 */
export function predictGhostText(
  line: string,
  options: GhostPredictorOptions = {},
): string | null {
  const trimmed = line.trimStart();
  if (!trimmed || trimmed.length < 2) return null;

  const history = options.history ?? [];
  const patterns = options.patterns ?? COMMON_CLI_PATTERNS;

  // 1. Session & History MRU prefix matching (highest priority)
  for (const item of history) {
    const itemTrimmed = item.trimStart();
    if (
      itemTrimmed.startsWith(trimmed) &&
      itemTrimmed.length > trimmed.length
    ) {
      return itemTrimmed;
    }
  }

  // 2. Curated developer CLI patterns
  for (const pattern of patterns) {
    if (pattern.startsWith(trimmed) && pattern.length > trimmed.length) {
      return pattern;
    }
  }

  return null;
}
