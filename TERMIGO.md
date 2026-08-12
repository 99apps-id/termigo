# Termigo

Project memory for coding agents working in this repository.

## Project

- Purpose: terminal-first, AI-native development workspace (desktop + CLI companion).
- Stack: Rust + Tauri 2 + React 19 + TypeScript (desktop); Go 1.26 (CLI).

## Conventions

- CLI: `Set-Location cli; go vet ./...; go test ./...`
- Desktop frontend: `Set-Location desktop; npm run build` (runs `tsc --noEmit && vite build`)
- Rust: `Set-Location desktop/src-tauri; cargo clippy --all-targets -- -D warnings; cargo test`
- Keep the Go CLI dependency-free beyond stdlib + yaml.v3.
- Keep the Rust backend dependency-free beyond serde/serde_json/tauri where possible.
- Never store API keys in config files; provider credentials stay with their CLIs.
- New desktop features follow the existing command surface pattern: Rust command,
  typed wrapper in `desktop/src/types.ts`, React pane in `desktop/src/`.

## Workspace notes

- The legacy Go/Wails prototype (`app.go`, `frontend/`) is kept as a reference;
  new desktop work lands in `desktop/`.
- The CLI is the automation layer: if a workflow is useful headlessly, put it
  in `cli/internal/` first.
