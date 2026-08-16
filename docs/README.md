# Termigo contributor documentation

This directory holds long-form contributor and maintainer guides. `TERMIGO.md` at the repo root is the living architecture doc and the source of truth; these guides elaborate on specific areas without duplicating it.

If a guide conflicts with `TERMIGO.md`, `TERMIGO.md` wins.

## Getting started

- [TERMIGO.md](../TERMIGO.md) - the architecture source of truth; read this first
- [CONTRIBUTING.md](../CONTRIBUTING.md) - how to contribute, quality bar, project layout

## Feature guides

- [SSH & remote files](SSH.md) - SSH sessions as terminal tabs, host-key
  verification (TOFU), SFTP file explorer, port forwarding.

## Architecture guides

- [Two-process model and IPC command reference](architecture/two-process-model.md) - Rust owns all OS access; the webview talks through `invoke()`. Command catalog and how to add a new command.
- [PTY shell integration](architecture/pty-shell-integration.md) - PTY sessions, shell init scripts, OSC 7 / 133, ConPTY, SPAWN_LOCK, Job Object, WSL.
- [Security model](architecture/security-model.md) - deny-list, SSRF guard, workspace authorization, AI tool approval, IPC allowlist, OSC trust, keychain handling.
- [Module layout](architecture/module-layout.md) - every frontend module, what it owns, and the invariants that are easy to break. Moved out of `TERMIGO.md` so that file fits the project memory the agent receives.
- [Platform and bundle](architecture/platform-and-bundle.md) - window styling per platform, the Tauri capability allowlist, cross-platform conventions, bundle and updater config.
- [AI subsystem](architecture/ai-subsystem.md) - providers, agent, sub-agents, sessions, composer, tools, edit diffs, live context bridge. Includes a walkthrough for adding a new provider.
- [Terminal renderer pool](architecture/terminal-renderer-pool.md) - slot pooling, the DormantRing, and the never-serialize-mid-command invariant.
- [CLI control plane](architecture/cli-control.md) - bundled CLI, authenticated local protocol, caller targeting, packaging, and current platform limits.

## Contributing guides

- [Testing](contributing/testing.md) - the testing contract, how to run checks, and what makes a good core-subsystem test.
