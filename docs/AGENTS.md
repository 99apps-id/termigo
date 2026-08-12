# Agents and providers

Termigo drives locally installed coding agents. It never stores API keys:
authentication stays with each provider's own CLI (or local endpoint).

## Supported providers

| ID           | Name            | Kind       | Version flag |
| ---          | ---             | ---        | ---          |
| `codex`      | Codex CLI       | CLI        | `--version`  |
| `claude`     | Claude Code     | CLI        | `--version`  |
| `gemini`     | Gemini CLI      | CLI        | `--version`  |
| `antigravity`| Antigravity     | CLI        | `--version`  |
| `ollama`     | Ollama (local)  | HTTP local | `--version`  |

`termigo doctor` and `termigo agent list` report which ones are installed.

## CLI usage

```powershell
termigo agent list                                  # status of every provider
termigo agent run codex "Explain this repository"   # read-only by default
termigo agent run claude "Fix the failing test" --access workspace-write
termigo agent run ollama "Summarize this code" --model qwen2.5-coder
termigo agent run gemini "Plan the migration" --model gemini-2.5-pro --timeout 300
```

Flags: `--access read-only|workspace-write`, `--model <name>`,
`--endpoint <url>` (Ollama), `--timeout <seconds>`, `-w/--workspace <dir>`.

## Sandbox mapping

| Termigo access    | Codex                | Claude Code           |
| ---               | ---                  | ---                   |
| `read-only`       | `-s read-only`       | `--permission-mode default` |
| `workspace-write` | `-s workspace-write` | `--permission-mode acceptEdits` |

## User configuration

`~/.termigo/config.json` (or `$TERMIGO_HOME/config.json`) holds defaults:

```json
{
  "defaultAgent": "claude",
  "providers": {
    "ollama": { "model": "qwen2.5-coder:latest", "endpoint": "http://localhost:11434" },
    "codex": { "command": "codex" }
  }
}
```

Edit with:

```powershell
termigo config set defaultAgent codex
termigo config provider ollama model qwen3:latest
termigo config provider ollama endpoint http://localhost:11434
```

## Desktop integration

The Agent tab runs Codex through its existing ChatGPT sign-in with an
ephemeral workspace session and a read-only / workspace-write access choice.
All installed providers are detected automatically and shown as chips in the
Agent tab; the CLI drives any of them.
