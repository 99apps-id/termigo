# Analisis Crush vs Termigo — 2025-06-28

> Crush (github.com/charmbracelet/crush) adalah penerus OpenCode, pengembangan lanjutan dari proyek yang sama. Repo yang dianalisis: commit terbaru, bahasa Go, TUI bubbletea + client/server mode.

---

## 1. Struktur Kode Crush

### Arsitektur tinggi
- **Satu binary Go** (cobra CLI + bubbletea TUI) dengan **dual mode**: lokal (`AppWorkspace`) dan client/server (`ClientWorkspace` via SSE)
- **Backend**: SQLite + sqlc + migrations (sama seperti OpenCode, diperkaya)
- **Agent loop**: `sessionAgent.Run` dengan queue, cancel, accept sequences, dan `publishRunComplete` sebagai sinyal terminal authoritative
- **Tools**: 30+ tool (bash, edit, view, write, grep, glob, ls, web_fetch, web_search, shell, diagnostics, sourcegraph, download, patch, rg, references, todos, crush_info, crush_logs, read_mcp_resource, agent, MCP tools)
- **Provider**: OpenAI, Anthropic, Gemini, Azure, Bedrock, Vertex, Copilot, Ollama, Local, OpenRouter, Vercel (via fantasy + catwalk)
- **MCP**: stdio + SSE, dengan tools, prompts, resources, auth (Docker MCP)
- **Pubsub generic** `Broker[T]` memisahkan service dari UI (sama seperti OpenCode, diperkaya)
- **Permission**: allowlist per tool+action+session+path, `AutoApproveSession`, question service
- **History**: file versioning per session, LSP diagnostic cache
- **Skills**: SKILL.md discovery dengan fastwalk, validasi, XML injection ke system prompt
- **Hooks**: PreToolUse hooks dengan shell commands, decisions (allow/deny/halt), input rewriting, Claude Code compat
- **Loop detection**: SHA-256 signature tool calls + results, window 10 steps, max 5 repeats
- **Coordinator pattern**: membangun agent, handle auth refresh, retry, title generation
- **SSE reconnection**: dengan backoff, degraded mode, workspace recovery
- **Client retirement**: exact teardown
- **Question service**: interactive prompts (yes/no, single/multi choice, free text)

---

## 2. Kelebihan Crush

### Arsitektur
1. **Workspace abstraction** yang bersih: `Workspace` interface dengan `AppWorkspace` ( lokal) dan `ClientWorkspace` (remote via SSE). Ini memungkinkan TUI/CLI/client-server mode dengan interface yang sama.
2. **Agent queue system** yang sophisticated: accept sequences, cancel marks, drainQueueForStep, recursive run untuk queued prompts dengan RunID.
3. **Non-interactive mode** yang matang: `crush run` dengan `-p prompt`, proper exit codes, RunComplete correlation.
4. **SSE reconnection** dengan backoff dan workspace recovery: client bisa reconnect ke server yang restart, dengan exact teardown via client retirement.
5. **Loop detection** berbasis SHA-256 signature: mencegah agent terjebak dalam loop tool calls.
6. **Hooks system** yang powerful: PreToolUse hooks dengan shell commands, allow/deny/halt decisions, input rewriting, Claude Code compatibility.
7. **Skills system** lengkap: SKILL.md discovery, validasi, deduplication, XML injection, disable-model-invocation.
8. **Permission model** yang fleksibel: AutoApproveSession, tool+action+session+path, question service untuk interactive prompts.
9. **MCP tools** dengan stdio + SSE, resources, prompts, auth, Docker MCP.
10. **Error handling** yang robust: cleanup contexts, WithoutCancel, bounded timeouts, recoverPanic.
11. **Question service**: interactive prompts (yes/no, single/multi choice, free text) dengan pubsub pattern.
12. **FileTracker**: read tracking untuk context agent.
13. **LSP diagnostic cache**: cached diagnostic counts.
14. **Shell integration**: embedded POSIX shell, hook execution melalui shell.Run.
15. **Provider options merging**: sophisticated model option handling dengan Anthropic caching pada last tool.
16. **Auth refresh**: OnAuthRefresh hook untuk credentials refresh + retry transparan.
17. **Title generation**: detached context agar tidak blokir Run.
18. **Cancel-before-assistant-creation window**: persistCanceledTurn menangani cancel yang terjadi sebelum assistant message dibuat.

### Kekuatan vs OpenCode
1. Client/server mode dengan SSE
2. Workspace abstraction
3. Agent queue system yang lebih sophisticated
4. Loop detection
5. Hooks system
6. Skills system lengkap
7. Question service
8. Auth refresh + retry
9. FileTracker
10. LSP diagnostic cache
11. MCP resources + prompts + auth
12. Docker MCP
13. Non-interactive mode yang lebih matang
14. RecoverPanic pattern
15. Error handling yang lebih robust

---

## 3. Kelemahan Crush

### Arsitektur
1. **Tidak ada worktree isolation** untuk subagent: semua subagent berbagi workspace yang sama.
2. **Tidak ada PTY/shell session** (langsung exec.Cmd seperti OpenCode): tidak ada shell integration, OSC 7/133, ConPTY, Job Object.
3. **Tidak ada SSH remote**: tidak ada tab SSH, SFTP, host key verification.
4. **Tidak ada webview/editor kaya**: TUI terminal-only, tidak ada xterm.js, CodeMirror, preview surfaces.
5. **Permission model** sederhana (tanpa flow approve/deny UI yang kaya): hanya question service + AutoApproveSession.
6. **Tidak ada concurrency pool/queue global**: setiap session punya queue sendiri, tidak ada pool global untuk subagent.
7. **Tidak ada OS keychain/secret management**: API keys disimpan di config store, bukan keychain.
8. **Tidak ada deny-list path/workspace authorization**: hanya permission model sederhana.
9. **Tidak ada extension sandbox**: tidak ada sistem extensions.
10. **Tidak ada multi-model routing/fallback otomatis**: model dipilih manual.
11. **Tool repetition bug** (monkey patch commented out) - masih ada.
12. **Tidak ada Telegram integration**: tidak ada bot, notifikasi, progress formatting.
13. **Tidak ada web search** bawaan (hanya web_fetch dan web_search tool, tapi tidak ada browsing interface).
14. **Tidak ada editor kaya**: hanya view/edit tool sederhana.
15. **Tidak ada tab system**: hanya session-based, tidak ada splits, tabs, atau pane tree.
16. **Tidak ada theme system** yang kaya: hanya lipgloss styling.

---

## 4. Yang Bisa Diterapkan ke Termigo

### Tinggi (High Priority)

#### 4.1 Workspace Abstraction
Crush menggunakan pattern `Workspace` interface yang sangat bersih:
```go
type Workspace interface {
    // Agent
    AgentRun(ctx, sessionID, prompt, attachments)
    AgentCancel(sessionID)
    AgentIsBusy() bool
    // ... dozens of methods
}
```
Dua implementasi:
- `AppWorkspace`: wrapping local `app.App` instance
- `ClientWorkspace`: wrapping HTTP client SDK untuk remote mode

**Manfaat untuk Termigo:**
- Memungkinkan mode client/server di masa depan (remote Termigo server)
- Interface yang konsisten antara Rust backend dan frontend
- Mudah di-test dengan mock implementations
- Bisa dipakai untuk SSH remote tabs (saat ini menggunakan resolver pattern)

**Adopsi Termigo:**
- Buat `Workspace` interface di Rust yang mendefinisikan semua operasi (agent, fs, shell, ssh, mcp, lsp, settings)
- `LocalWorkspace` wrapping Tauri state langsung
- `RemoteWorkspace` wrapping HTTP/WebSocket client untuk remote mode
- Frontend hanya bergantung pada interface, bukan concrete type

#### 4.2 Agent Queue System dengan Accept Sequences
Crush memiliki queue system yang sangat sophisticated:
- `BeginAccepted`: accept reservation sebelum dispatch
- `acceptSeq`: monotonic sequence number
- `cancelMark`: high-water mark untuk cancel
- `drainQueueForStep`: atomic filtering against concurrent Cancel
- Fold uncanceled prompts tanpa RunID ke active turn
- Queued prompts dengan RunID dijalankan sebagai recursive turn

**Manfaat untuk Termigo:**
- Saat ini subagent pool menggunakan `yieldSlot`, tetapi tidak ada queue per-session
- Jika user mengirim multiple prompt ke session yang sama, yang terakhir dijalankan, yang lain diabaikan
- Crush's approach: fold follow-up prompts ke active turn, atau jalankan sebagai recursive turn

**Adopsi Termigo:**
- Tambah queue per-session di `subagentPool.ts` atau `Agent` class
- Implementasi `yieldSlot` sudah ada, tambah `cancelMark` dan `acceptSeq`
- Fold follow-up prompts tanpa RunID ke active turn
- Queued prompts dengan RunID dijalankan sebagai recursive run

#### 4.3 Loop Detection
Crush menggunakan SHA-256 signature untuk mendeteksi loop:
- Window 10 steps terakhir
- Max 5 repeats per signature
- Signature = hash(toolName + input + result)

**Manfaat untuk Termigo:**
- Saat ini tidak ada loop detection di agent Termigo
- Agent bisa terjebak dalam loop tool calls (misal: repeatedly calling grep dengan query yang sama)
- Loops boros token dan waktu

**Adopsi Termigo:**
- Tambah loop detection di `Agent` class (Rust atau TS)
- Compute signature dari tool calls + results dalam step terakhir
- Jika signature muncul >5x dalam 10 step terakhir, halt turn dengan error message
- Bisa dilakukan di `lib/repairToolCall.ts` atau `lib/agent.ts`

#### 4.4 Hooks System
Crush memiliki PreToolUse hooks:
- Shell commands yang dijalankan sebelum tool use
- Decisions: allow/deny/halt
- Input rewriting: hook bisa modifikasi tool input
- Deduplication by command string
- Concurrent execution dengan timeout
- Claude Code compatibility

**Manfaat untuk Termigo:**
- Saat ini approval system sudah ada (approve/deny), tetapi tidak ada pre-execution hooks
- Hooks bisa digunakan untuk:
  - Auto-approve certain tools (misal: `grep` dan `glob` untuk exploration)
  - Auto-deny dangerous commands (misal: `rm -rf /`)
  - Rewrite tool input (misal: tambah `--safe-mode` flag)
  - Logging/auditing tool calls
  - Integration dengan external systems

**Adopsi Termigo:**
- Tambah `hooks` module di `src/modules/ai/`
- Configuration: `hooks.json` atau di `settings.json`
- Implementasi `PreToolUse` hook runner
- Support untuk allow/deny/halt decisions
- Support untuk input rewriting
- Claude Code compatibility untuk existing hook scripts

### Sedang (Medium Priority)

#### 4.5 Skills System
Crush memiliki skills system yang lengkap:
- SKILL.md discovery dengan fastwalk
- Validasi (name, description, frontmatter)
- Deduplication (user skills override builtin)
- XML injection ke system prompt
- DisableModelInvocation flag
- Builtin skills

**Manfaat untuk Termigo:**
- Saat ini Termigo memiliki `.termigo/skills/` untuk procedural knowledge, tetapi tidak ada discovery atau injection ke system prompt
- Skills bisa digunakan untuk:
  - Domain-specific knowledge (misal: Termigo development guide)
  - Tool-specific instructions (misal: cara menggunakan grep efektif)
  - Workflow automation (misal: standard commit message format)
  - Auto-injection ke system prompt tanpa manual context

**Adopsi Termigo:**
- Implementasi skills discovery di Rust backend (mirip Crush)
- Parse SKILL.md dengan frontmatter YAML
- Inject skills XML ke system prompt sebelum agent run
- Support builtin skills (dibundle dengan app) dan user skills (di workspace)
- Validasi: name pattern, max lengths, frontmatter required
- DisableModelInvocation flag

#### 4.6 Question Service
Crush memiliki question service untuk interactive prompts:
- Types: yes/no, single_choice, multi_choice, free_text
- Pubsub pattern: publish request, block on channel, resolve when UI answers
- Max 5 questions per batch, max 5 choices per question
- Validation dengan error messages untuk LLM

**Manfaat untuk Termigo:**
- Saat ini approval system hanya approve/deny
- Question service bisa digunakan untuk:
  - Multi-step approval (misal: "File ini sensitif, apakah Anda yakin? Pilih: [Ya, Baca saja, Batal]")
  - Parameter gathering (misal: tool butuh argumen, tanyakan ke user)
  - Confirmation dialogs (misal: "Hapus 3 files? [Ya, Tidak, Batal]")

**Adopsi Termigo:**
- Tambah question service di Rust backend
- Frontend component untuk rendering questions (modal/dialog)
- Support untuk multiple question types
- Integration dengan AI agent (agent bisa memanggil `question` tool)
- Validation dan error messages

#### 4.7 SSE Reconnection + Workspace Recovery
Crush memiliki SSE reconnection dengan:
- Exponential backoff (initial, max)
- Degraded mode detection
- Workspace recovery (re-create workspace dari cached snapshot)
- Client retirement untuk exact teardown
- Subscription goroutine yang bisa reconnect tanpa user intervention

**Manfaat untuk Termigo:**
- Saat ini Termigo menggunakan Tauri IPC (bukan SSE), tetapi pattern yang sama bisa diterapkan
- Jika frontend crash dan restart, bisa reconnect ke existing sessions
- Jika backend restart, bisa recover state

**Adopsi Termigo:**
- Implementasi reconnection logic di frontend untuk Tauri events
- Cache session state di Rust backend
- Frontend bisa "re-attach" ke existing sessions setelah restart
- Recovery mechanism untuk lost connections

### Rendah (Low Priority)

#### 4.8 RecoverPanic + ErrorPersist Pattern
Crush memiliki `RecoverPanic` di Go CLI dan `ErrorPersist` untuk menyimpan errors.

**Adopsi Termigo:**
- Tambah panic recovery di Rust backend (Rust sudah punya panic=abort by default, tapi bisa ditambahkan untuk critical sections)
- Error persistence untuk debugging

#### 4.9 Shell Quoting Helper
Crush memiliki shell quoting helper untuk tool shell.

**Adopsi Termigo:**
- Saat ini shell tool di Termigo sudah ada, tetapi bisa ditambahkan quoting helper untuk cross-platform compatibility

#### 4.10 Tool Response Metadata
Crush tool responses memiliki metadata:
- `filePath`, `lineCount`, `diffHunks`
- `crush_info` tool dengan system info

**Adopsi Termigo:**
- Tambah metadata ke tool responses di Rust backend
- Frontend bisa render metadata secara kaya (misal: line numbers, diff stats)
- `termigo_info` tool dengan system info

---

## 5. Perbandingan Langsung

| Fitur | Termigo | Crush | OpenCode |
|---|---|---|---|
| **Arsitektur** | Tauri 2 (Rust + React) | Go (TUI + Client/Server) | Go (TUI) |
| **PTY/Shell** | Yes (portable-pty, ConPTY, Job Object) | No (exec.Cmd) | No (exec.Cmd) |
| **SSH Remote** | Yes (tabs, SFTP, host key TOFU) | No | No |
| **Webview/Editor** | Yes (xterm.js, CodeMirror) | No (TUI only) | No (TUI only) |
| **Worktree Isolation** | Yes (subagent) | No | No |
| **Agent Queue** | yieldSlot + pool | Accept sequences + drain | Simple queue |
| **Loop Detection** | No | Yes (SHA-256 signature) | No |
| **Hooks** | No | Yes (PreToolUse) | No |
| **Skills** | Partial (`.termigo/skills/`) | Yes (SKILL.md) | No |
| **Question Service** | No | Yes | No |
| **SSE Reconnection** | N/A (Tauri IPC) | Yes | N/A |
| **MCP** | Yes (stdio + SSE) | Yes (stdio + SSE) | No |
| **Permission** | Approve/Deny + deny-list | AutoApproveSession + question | AutoApproveSession |
| **Non-interactive Mode** | `termigo ai run` | `crush run -p` | `opencode -p` |
| **Client/Server** | No | Yes | No |
| **LSP** | Yes | Yes (cached diagnostics) | No |
| **History/Versioning** | No | Yes | Yes |
| **Diff + Highlight** | Yes | Yes (Chroma) | Yes |
| **Telegram** | Yes | No | No |
| **Extensions** | Yes (sandboxed workers) | No | No |
| **OS Keychain** | Yes (secrets_*) | No | No |
| **Multi-model Routing** | Yes (PROVIDERS) | Manual selection | Manual selection |

---

## 6. Rekomendasi Adopsi

### Prioritas Tinggi
1. **Workspace Abstraction** - Membuat `Workspace` interface di Rust untuk konsistensi dan testability
2. **Agent Queue System** - Queue per-session dengan accept sequences dan cancel marks
3. **Loop Detection** - SHA-256 signature detection untuk mencegah agent loops
4. **Hooks System** - PreToolUse hooks dengan allow/deny/halt decisions dan input rewriting

### Prioritas Sedang
5. **Skills System** - SKILL.md discovery dan injection ke system prompt
6. **Question Service** - Interactive prompts untuk agent (multi-step approval, parameter gathering)
7. **SSE Reconnection Pattern** - Untuk frontend recovery setelah restart

### Prioritas Rendah
8. **Tool Response Metadata** - `filePath`, `lineCount`, `diffHunks`
9. **System Info Tool** - `termigo_info` seperti `crush_info`
10. **Shell Quoting Helper** - Untuk cross-platform compatibility

---

## 7. Catatan Penting

Crush adalah proyek yang **sangat matang** dan menunjukkan evolusi signifikan dari OpenCode. Beberapa pola yang sangat worth adopting:

1. **Workspace abstraction** adalah pattern yang sangat powerful untuk memisahkan UI dari backend logic.
2. **Agent queue system** dengan accept sequences adalah solusi yang elegant untuk masalah concurrent access ke session yang sama.
3. **Loop detection** adalah fitur yang sering diabaikan tetapi sangat penting untuk production-grade agent.
4. **Hooks system** menambahkan layer extensibility yang luar biasa tanpa mengubah core agent logic.

Namun, Termigo memiliki keunggulan yang tidak dimiliki Crush:
- PTY/shell integration yang lengkap
- SSH remote tabs
- Webview dengan editor kaya
- Worktree isolation untuk subagent
- OS keychain untuk secrets
- Telegram integration
- Extension sandbox

Kombinasi keduanya akan menghasilkan agentic terminal emulator yang sangat powerful.

---

*Analisis dilakukan dengan membaca ~50 file kunci dari repo Crush (C:/project/crush).*
