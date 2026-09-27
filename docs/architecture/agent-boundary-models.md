# Agent boundary and permission models

This guide compares how other agentic coding tools draw the line between what an
agent may do on its own and what needs the operator, and records where
termigo-neo sits. It exists so the posture decision stays auditable instead of
resting on recollection, and so a future change can point at a reference instead
of re-running the research.

`TERMIGO.md` wins if anything here conflicts with it. For termigo's own
internals see [security model](security-model.md).

## Evidence

Every row is grounded in one of these, and the tables mark which:

- **[L]** read from a local install on this machine (2026-09-27): version string,
  CLI help output, or config file.
- **[S]** the vendor's `SECURITY.md` shipped inside that install.
- **[D]** vendor documentation or prior knowledge, not verifiable offline.

| Tool | Version observed | Evidence |
| --- | --- | --- |
| Claude Code | npm global; win32 shim does not launch (see note) | [L] partial, [D] |
| Codex CLI | `codex-cli 0.147.0` | [L] |
| Gemini CLI | `0.55.1` | [L] |
| Muse Code | `1.3.0 (1.3.0-R3401.1)` | [L] |
| Hermes Agent | installed venv, `~/.config` config | [L] [S] |
| OpenClaw | `2026.7.1-2` | [L] |
| termigo-neo | `5419372` | [L] |

`claude --version` fails on this machine with `Program 'claude.exe' failed to
run: The specified executable is not a valid application for this OS platform`,
so Claude Code's flags could not be read here. Its row uses `~/.claude/settings.json`
[L] plus documented behavior [D].

## 1. The consent gate

| Tool | Default | Mode vocabulary | Rule model | Escape hatch |
| --- | --- | --- | --- | --- |
| Claude Code | asks | `default`, `acceptEdits`, `plan`, `bypassPermissions` [D] | `permissions.allow` / `deny` / `ask` with `Bash(<program> <args>)` and path patterns [L] | `--dangerously-skip-permissions` [D] |
| Codex CLI | asks, sandboxed | sandbox `read-only` / `workspace-write` / `danger-full-access`, plus `-a untrusted` approval policy [L] | approval policy presets, trusted-command set (`ls`, `cat`, `sed`), `-c sandbox_permissions=[...]` [L] | `--dangerously-bypass-approvals-and-sandbox`, documented as "EXTREMELY DANGEROUS. Intended solely for running in environments that are externally sandboxed" [L] |
| Gemini CLI | asks | `--approval-mode default` / `auto_edit` / `yolo` / `plan` (read-only) [L] | Policy Engine; `--allowed-tools` is deprecated in its favor [L] | `--yolo` ("Automatically accept all actions") [L] |
| Muse Code | approval and sandbox both ON | `--approval-mode untrusted` / `on-request` / `never` (default `on-request`), `--permission-profile <ID>`, `--approval-judge on` by default [L] | approved network rules with `effect` and `durability` (`local_persistent`), `--workspace` registers policy-gated tools [L] | `--yolo` = "Disable approval and sandboxing and trust this workspace for this run" [L] |
| Hermes Agent | approval gate on | `/yolo ON` toggle, shown as a `YOLO` badge in the status bar [L] | destructive-pattern denylist plus an operator prompt; per-session approval queue (`tools/approval.py`) [L] [S] | `/yolo ON` [L] |
| OpenClaw | per agent | per-agent `security` and `ask` settings [L] | `askFallback: "allowlist"`, `autoAllowSkills`; approvals brokered over a local socket [L] | `ask: "off"` for a given agent [L] |
| termigo-neo | no gate | `ask` / `edits` / `all` exist but are aliases [L] | allow / ask / deny engine with globs, first-match-wins, persisted to `.termigo/approvals.json`; deny rules still refuse, allow and ask are moot [L] | the default is the escape hatch: `DEFAULT_APPROVAL_MODE = "all"` [L] |

## 2. Boundaries that are not the gate

| Tool | OS sandbox | Network policy | Own-config protection | Workspace trust | Audit trail |
| --- | --- | --- | --- | --- | --- |
| Claude Code | optional sandbox mode [D] | domain allowlist in sandbox mode [D] | settings and hooks are not agent-writable [D] | trust prompt per folder [D] | session transcripts [L] |
| Codex CLI | yes, default: `read-only` / `workspace-write` / `danger-full-access`, `sandbox` subcommand, `[windows] sandbox = "unelevated"` [L] | `workspace-write` with automatic review routing [L] | hooks require persisted trust; `--dangerously-bypass-hook-trust` exists to skip it [L] | `[projects.'<path>'] trust_level = "trusted"` recorded per project [L] | session rollouts under `~/.codex/sessions` [L] |
| Gemini CLI | `--sandbox` [L] | not observed [L] | not observed | `--skip-trust` flags trust as the exception [L] | history under `~/.gemini/history` [L] |
| Muse Code | yes: `muse sandbox windows check` / `setup`; `--sandbox-network restricted` / `enabled` / `proxy-only` (default `proxy-only`) [L] | network rules are first-class policy, e.g. an allow rule for `api.github.com:443` with `durability: local_persistent` [L] | approval policy lives outside the workspace (`~/.config/muse/approval-policy.json`), with a lock file [L] | `~/.config/muse/trust.json` records per-project `decision: "trusted"`; `--trust-workspace` is per run and not saved [L] | session event logs on by default, `--no-session-log` opts out [L] |
| Hermes Agent | yes: terminal backend in container, remote host, or cloud sandbox; whole-process wrap via its own image or OpenShell [S] | two Docker networks plus an egress proxy allowlist, aimed at injection-driven exfiltration [S] | refuses file-tool writes to its own config, with the reason spelled out in code (`tools/file_tools.py`) [L] | plugin and skill install are operator-review boundaries [S] | plugin and cron surfaces, not a unified audit log [L] |
| OpenClaw | Docker sandbox mode per skill, plus an OpenShell sandbox plugin [L] | `@openclaw/proxyline`, loopback blocked by default, allowlist for exceptions [L] | approval broker owns the decision; `exec-approvals.json` is a credential, not plain config [L] | onboarding records `securityAcknowledgedAt` [L] | per-agent `audit/<agent>.jsonl` [L] |
| termigo-neo | none: "keeps no sandbox: every program runs, bare name or path" (`shell/mod.rs:33`) [L] | none for agent tools; the Rust SSRF guard covers only the AI HTTP proxy [L] | write wall on both routes: `write_refusal` in `fs/security.rs` refuses the hook and MCP registries, other agents' workspace config, `.git/**`, credential directories, extension bundles, and the audit log, and it is shared by `fs_write_file` and `validate_shell_command` [L] | none | app-scoped JSONL per day, written by `audit_append` in Rust and locked by the write wall [L] |

## 3. What each one says about its own gate

The strongest signal is that the products with a sandbox describe the approval
gate as an accident guard, not a defense.

Hermes Agent, `SECURITY.md` section 2.2:

> The only security boundary against an adversarial LLM is the operating system.
> Nothing inside the agent process constitutes containment, not the approval
> gate, not output redaction, not any pattern scanner, not any tool allowlist.

and section 2.4: "Shell is Turing-complete; a denylist over shell strings is
structurally incomplete. The gate catches cooperative-mode mistakes, not
adversarial output." Its scope section lists heuristic bypasses as explicitly
out of scope for security reports, and code behaving contrary to its own
documented trust model as in scope.

OpenClaw ships the same framing in its libraries. `@openclaw/fs-safe`: "This is
a library-level guardrail, not OS-level isolation. It does not replace
containers, seccomp, AppArmor, or filesystem permissions."
`@openclaw/proxyline`: "Proxyline is a Node-process runtime, not an
operating-system sandbox. Code can still bypass it by using raw `net`, raw
`tls`, custom native networking..." 

Codex CLI encodes the same idea in a flag name: the bypass is "EXTREMELY
DANGEROUS" and intended only where something else already sandboxes the process.

## 4. Where termigo-neo differs

Not "more permissive", which would be a setting. The fork also dropped
invariants that every other tool here keeps.

| Invariant | Kept by | termigo-neo |
| --- | --- | --- |
| Consent before a mutating call | all six | no: every call is auto-approved |
| Rules with deny winning over allow | Claude Code, Codex, Gemini, Muse, OpenClaw, Hermes | engine present in `approvalRules.ts`, but allow and ask never apply |
| Agent cannot write the config that governs it | Claude Code, Codex (hook trust), Muse (out of workspace), Hermes (`file_tools.py`), OpenClaw (socket broker) | partly: the write wall closes hooks, MCP, other agents' config, git hooks, credentials, and the audit log on both routes. `.termigo/approvals.json` stays writable through the fs route, because the approval dialog writes it through the same path and that layer cannot tell the click from an agent call |
| Hooks require trust before they run | Codex (persisted hook trust), Claude Code (user-owned settings), Hermes (operator review) | no: a hook runs on every matching tool event with no prompt (`fs/security.rs:118`) |
| OS-level sandbox | Codex, Muse, Hermes, OpenClaw, Gemini, Claude Code (optional) | no |
| Network or egress policy for agent commands | Muse, Hermes, OpenClaw | no |
| Workspace trust gate | Codex, Muse, Gemini, Claude Code, OpenClaw | no |
| Audit trail of what the agent ran | OpenClaw, Muse, Codex, Claude Code | yes: `<app_data_dir>/audit/<date>.jsonl`, one line per tool call, status distinguishing `ok`, `error`, and a wall `refused` |

The point is narrow and worth stating plainly: a gate-free default is a legitimate
product choice, and this fork makes it deliberately. What is not a choice is
losing self-protection while keeping silent-exec config, because that is the one
gap no other tool in this table accepts.

## 5. What termigo-neo already has

The machinery is in-tree and tested, which makes any future posture change a
wiring job rather than a build:

- `src/modules/ai/lib/approvalPolicy.ts` - modes, exec and edit tiers, the auto-approval decision.
- `src/modules/ai/lib/approvalRules.ts` - allow / ask / deny rules, glob matching, first-match-wins, `.termigo/approvals.json` round trip, `upsertRule`, subagent gate.
- `src/modules/ai/lib/approvalQueue.ts`, `store/approvalQueueStore.ts`, `lib/approvalExpiry.ts`, `lib/approvalResume.ts` - queue, deadlines, and resume semantics.
- `src/modules/ai/hooks/useAutoApproval.ts` - the responder that answers what the mode delegates.
- `src-tauri/src/modules/fs/security.rs` - `write_refusal`, the single source of truth for the write deny-list, consulted by both the fs route and the shell route.
- `src-tauri/src/modules/audit.rs` - the host-written audit log, plus `src/modules/ai/lib/auditLog.ts` for the entry shape and redaction.

And one mechanism no tool in the table has: `src/modules/ai/lib/pentestScope.ts`
auto-approves in-scope read-tier recon and refuses out-of-scope targets, which is
a semantic scope fence rather than a generic allow or deny pattern.

## 6. Reproducing this

```powershell
# versions
codex --version; gemini --version; muse --version

# safety flags, per tool
codex --help | Select-String 'sandbox|approval|dangerous|trust'
gemini --help | Select-String 'approval-mode|sandbox|trust|allowed'
muse --help | Select-String 'approval|sandbox|yolo|trust|disable'

# local policy
Get-Content ~/.codex/config.toml
Get-Content ~/.config/muse/approval-policy.json, ~/.config/muse/trust.json
Get-Content ~/.claude/settings.json
Get-Content ~/.openclaw/openclaw.json, ~/.openclaw/exec-approvals.json
```

Treat `~/.openclaw/exec-approvals.json` and `~/.config/muse/auth.json` as
credentials rather than configuration when copying output around.
