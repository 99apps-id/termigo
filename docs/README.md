# Termigo contributor documentation

This directory holds long-form contributor and maintainer guides. `TERMIGO.md` at the repo root is the living architecture doc and the source of truth; these guides elaborate on specific areas without duplicating it.

If a guide conflicts with `TERMIGO.md`, `TERMIGO.md` wins.

## Getting started

- [CHANGELOG.md](../CHANGELOG.md) - release notes for every tagged version
- [TERMIGO.md](../TERMIGO.md) - the architecture source of truth; read this first
- [AGENTS.md](../AGENTS.md) - guidelines for AI coding agents
- [USER.md](../USER.md) - user preferences and operational instructions
- [CONTRIBUTING.md](../CONTRIBUTING.md) - how to contribute, quality bar, project layout

## Feature guides

- [SSH & remote files](SSH.md) - SSH sessions as terminal tabs, host-key
  verification (TOFU), SFTP file explorer, port forwarding.

## Visual tour

- [Open Excel and create table](termigo-open-excel-create-table.png) - AI agent automating data analysis, spreadsheet creation, and opening Microsoft Excel directly from the terminal.
- [Browser integration](termigo-browser-windows.png) - Terminal workspace with embedded browser tab.
- [Remote VPS over SSH](termigo-remote-vps.png) - Remote filesystem exploration and terminal session over SSH.
- [Antigravity CLI](termigo-running-antigravity-cli.png) - Running interactive AI coding agents inside Termigo.
- [Extensions manager](termigo-settings-extensions.png) - Installing and configuring tools and extensions.
- [Harness profiles](termigo-settings-harness.png) - Agent runtime execution and prompt configuration.
- [Model picker](termigo-model-picker.png) - BYOK model and provider selection.
- [Telegram companion](termigo-telegram.png) - Remote companion bot for approvals and queries.
- [Themes](termigo-themes.png) - Theme and palette customization.

## Architecture guides

- [Two-process model and IPC command reference](architecture/two-process-model.md) - Rust owns all OS access; the webview talks through `invoke()`. Command catalog and how to add a new command.
- [PTY shell integration](architecture/pty-shell-integration.md) - PTY sessions, shell init scripts, OSC 7 / 133, ConPTY, SPAWN_LOCK, Job Object, WSL.
- [Security model](architecture/security-model.md) - open execution environment, Git worktrees, SSRF guard, AI tool approval, IPC allowlist, OSC trust, keychain handling.
- [Agent boundary and permission models](architecture/agent-boundary-models.md) - how Claude Code, Codex CLI, Gemini CLI, Muse Code, Hermes Agent, and OpenClaw gate and sandbox an agent, and where termigo-neo sits.
- [Module layout](architecture/module-layout.md) - every frontend module, what it owns, and the invariants that are easy to break. Moved out of `TERMIGO.md` so that file fits the project memory the agent receives.
- [Platform and bundle](architecture/platform-and-bundle.md) - window styling per platform, the Tauri capability allowlist, cross-platform conventions, bundle and updater config.
- [AI subsystem](architecture/ai-subsystem.md) - providers, agent, sub-agents, sessions, composer, tools, edit diffs, live context bridge. Includes a walkthrough for adding a new provider.
- [Agent failure recovery](architecture/agent-failure-recovery.md) - what the agent does when the MCP server, an HTTP request, find_tools, an LLM call, or a subagent spawn fails.
- [Terminal renderer pool](architecture/terminal-renderer-pool.md) - slot pooling, the DormantRing, and the never-serialize-mid-command invariant.
- [CLI control plane](architecture/cli-control.md) - bundled CLI, authenticated local protocol, caller targeting, the Go companion's terminal commands, packaging, and current platform limits.
- [Extensions and the sandbox](architecture/extensions.md) - the extension manifest, the contribution registries, and the Web Worker sandbox model that keeps untrusted code off the main UI thread.

## Contributing guides

- [Testing](contributing/testing.md) - the testing contract, how to run checks, and what makes a good core-subsystem test.
