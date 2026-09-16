# Analisis OpenCode vs Termigo - 2025-06-28

> OpenCode (github.com/opencode-ai/opencode) sudah diarsip dan pindah ke [Crush](https://github.com/charmbracelet/crush). Repo yang dianalisis: commit terbaru sebelum arsip, bahasa Go, TUI bubbletea.

---

## 1. Struktur Kode OpenCode

### Arsitektur tinggi
- **Satu binary Go** (cobra CLI + bubbletea TUI)
- **Backend**: SQLite via sqlc + migrations
- **Agent loop**: sinkron `processGeneration` yang memanggil `streamAndHandleEvents` berulang kali sampai model berhenti memanggil tool
- **Tools**: `file`, `shell`, `grep`, `glob`, `ls`, `view`, `write`, `edit`, `patch`, `bash`, `fetch`, `sourcegraph`, `diagnostics`, `agent` (subagent)
- **Provider**: OpenAI, Anthropic, Gemini, Azure, Bedrock, Vertex, Copilot, Ollama, Local
- **MCP**: stdio + SSE
- **LSP**: client wrapper dengan diagnostic cache + file watcher
- **Pubsub**: generic `Broker[T]` berbasis channel + `sync.RWMutex`
- **Session**: persisted di SQLite, di-pubsub untuk update realtime ke TUI
- **Permission**: allowlist per `tool_name + action + session_id + path`, dengan `AutoApproveSession`
- **History**: file versioning (initial / updated) per session
- **Diff**: unified diff + syntax highlight Chroma + go-udiff

### Alur request
```
CLI (--prompt) atau TUI
  -> app.RunNonInteractive / tea.Program
    -> agent.Run (async goroutine, publish via pubsub)
      -> processGeneration (loop)
        -> streamAndHandleEvents
          -> provider.StreamResponse (streaming events)
          -> processEvent (update message: content, reasoning, tool calls)
          -> tool.Run (sinkron, blocking)
        -> append tool results, loop lagi jikaFinishReasonToolUse
    -> result dikembalikan via channel / pubsub ke TUI
```

### Kekuatan
1. **Sederhana dan fokus** - satu repo, satu binary, tidak ada webview/PTY/SSH, sehingga mental model jelas
2. **Pubsub generic** - `Broker[T]` memisahkan service dari UI dengan benar; subscriber bisa di-add/di-remove tanpa mengubah service
3. **Non-interactive mode** - `opencode -p "prompt" -f json` sangat berguna untuk scripting; spinner + quiet flag
4. **Agent tool + cost aggregation** - subagent (tool `agent`) mengumpulkan cost ke parent session
5. **MCP stdio + SSE** - implementasi lebih ringkas dibanding Termigo (tidak ada pool yang kompleks)
6. **Permission auto-approve** - `AutoApproveSession` mematikan prompt untuk satu sesi
7. **History / file versioning** - track perubahan file per session dengan version `initial` / updated
8. **Diff + Chroma** - syntax highlight terintegrasi untuk tool results
9. **LSP diagnostic cache** - cache diagnostics per URI dengan `IsFileOpen` guard
10. **RecoverPanic pattern** - semua goroutine punya defer panic recovery + persist error

### Kelemahan
1. **Tidak ada isolation worktree** - subagent `agent` tool berjalan di session yang sama, berisiko bentrok file writes
2. **Tidak ada PTY/shell session** - shell tool menggunakan `exec.Cmd` langsung, bukan PTY persistent
3. **Tidak ada SSH remote** - semua operasi lokal
4. **Tidak ada webview** - TUI saja, tidak bisa render rich diff/editor seperti CodeMirror
5. **Permission model sederhana** - tidak ada flow approval dengan tombol approve/deny seperti Termigo; hanya boolean channel
6. **Tidak ada concurrency control** - `activeRequests` menggunakan `sync.Map` + `IsSessionBusy`, tapi tidak ada pool/queue global
7. **Tidak ada secret/keychain** - API keys di config file/env var, tidak ada OS keychain integration
8. **Tidak ada security boundary** - tidak ada deny-list path, shell allowlist, atau workspace authorization
9. **Tidak ada extension sandbox** - semua tool berjalan di proses utama
10. **Tidak ada routing model** - satu agent, satu model per agent config; tidak ada multi-model routing atau fallback otomatis
11. **Tool repetition** - ada komentar "monkey patch for Copilot Sonnet-4 tool repetition obfuscation" tapi tidak diimplementasi
12. **Thundering herd LSP** - semua LSP client di-init paralel tanpa rate limit

---

## 2. Apa yang Bisa Diterapkan ke Termigo

### A. Output & Agent Response

| Ide | Sumber | Dampak |
|---|---|---|
| **Non-interactive AI mode di CLI** | `cmd/root.go` + `app.RunNonInteractive` | `termigo ai run "prompt"` bisa mengeluarkan output JSON/text tanpa harus buka TUI. Berguna untuk scripting dan CI. |
| **Format output JSON/text** | `internal/format/format.go` | Termigo AI bisa mendukung `--json` untuk structured output (tool calls, usage, cost). |
| **Spinner + quiet flag** | `format/spinner.go` | UX yang lebih baik untuk long-running AI di CLI. |

### B. Subagent & Worktree

| Ide | Sumber | Dampak |
|---|---|---|
| **Cost aggregation parent** | `agent-tool.go` - `parentSession.Cost += updatedSession.Cost` | Subagent Termigo sudah punya yieldSlot; menambahkan cost tracking ke parent akan lebih akurat. |
| **Subagent stateless contract** | Agent tool description: "Each agent invocation is stateless" | Memaksa prompt subagent mandiri; bisa jadi pattern untuk Termigo `run_subagents` agar prompt lebih deterministic. |
| **Auto-approve session** | `permission/permission.go` - `AutoApproveSession` | Untuk batch subagent atau harness, bisa auto-approve seluruh sesi agar tidak perlu approve berkali-kali. |

### C. Tool

| Ide | Sumber | Dampat |
|---|---|---|
| **Tool response metadata** | `tools/tools.go` - `ToolResponse.Metadata` | Termigo tool bisa tambahkan metadata (e.g., `filePath`, `lineCount`, `diffHunks`) untuk UI yang lebih kaya. |
| **Session/Message context key** | `tools/tools.go` - `SessionIDContextKey` | Pattern ini sudah mirip Termigo; bisa disatukan menjadi typed context. |
| **Shell quoting helper** | `tools/shell/shell.go` - `shellQuote` | Berguna untuk tool shell Termigo agar argument aman. |

### D. Routing

| Ide | Sumber | Dampak |
|---|---|---|
| **Provider factory dengan options** | `provider/provider.go` - `WithOpenAIOptions`, `WithGeminiOptions` | Termigo bisa adopting builder pattern untuk `buildConfiguredLanguageModel` agar lebih extensible. |
| **Event streaming typed** | `provider/provider.go` - `EventContentDelta`, `EventToolUseStart` | Termigo AI SDK v6 sudah punya stream; mapping ke typed event bisa memperkaya UI. |

### E. CLI

| Ide | Sumber | Dampak |
|---|---|---|
| **Cobra + non-interactive flag** | `cmd/root.go` - `--prompt`, `--output-format`, `--quiet` | Termigo Go CLI bisa menambahkan `termigo ai run "prompt"` untuk single-shot AI tanpa TUI. |
| **Setup subscriptions dengan timeout** | `cmd/root.go` - `setupSubscriber` dengan 2 detik timeout + slow consumer warning | Mencegah goroutine pubsub terbengkalai jika TUI lambat. |

### F. MCP

| Ide | Sumber | Dampak |
|---|---|---|
| **MCP stdio + SSE yang ringkas** | `mcp-tools.go` - `getTools(ctx, name, m, permissions, c)` | Termigo MCP pool bisa disederhanakan; OpenCode tidak ada pool, langsung invoke per request. |
| **Tool wrapping dengan permission guard** | `mcp-tools.go` - `permission.Service` di `mcpTool` | Setiap MCP tool check permission sebelum execute; pattern ini bisa ditambahkan ke Termigo MCP tools. |

### G. Harness

| Ide | Sumber | Dampat |
|---|---|---|
| **Non-interactive mode sebagai harness** | `app.RunNonInteractive` | Termigo bisa pakai ini sebagai base untuk `termigo harness run dataset`. Sudah ada `cli/internal/harness`, bisa diadopsi pattern OpenCode. |
| **Session title generation async** | `agent.go` - `generateTitle` di goroutine terpisah | Termigo bisa auto-generate tab title untuk AI session tanpa blocking UI. |

---

## 3. Rekomendasi Prioritas

| Prioritas | Perubahan | Alasan |
|---|---|---|
| **Tinggi** | Tambah `termigo ai run` (non-interactive mode) | Langsung meningkatkan produktivitas CLI, low effort, high value. |
| **Tinggi** | Tool response metadata (`filePath`, `lineCount`) | Memperkaya rendering di AI chat dan approval UI. |
| **Sedang** | Permission auto-approve per session | Berguna untuk batch subagent / harness. |
| **Sedang** | Chroma syntax highlight untuk diff | Meningkatkan kualitas diff rendering di editor/preview. |
| **Rendah** | Adopsi `RecoverPanic` + `ErrorPersist` di CLI | Sudah ada pattern yang cukup, bisa diserap untuk konsistensi. |

---

## 4. Catatan Penting

- OpenCode sudah **diarsip** dan pindah ke **Crush** (charmbracelet). Perubahan di Crush mungkin lebih maju, tapi arsitektur intinya mirip.
- OpenCode **tidak punya** fitur-fitur yang membuat Termigo unik: webview, PTY, SSH, worktree isolation, security model. Itu adalah **asset Termigo**, bukan celah.
- Beberapa "kekurangan" OpenCode sebenarnya **kesalahan arsitektur yang disengaja** untuk menjaga kesederhanaan TUI terminal.

---

*Analisis ini dilakukan dengan membaca sumber OpenCode secara langsung (clone + baca file) dan disintesis dengan pengetahuan arsitektur Termigo.*
