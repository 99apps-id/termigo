# Termigo — Security & Bug Audit Report
**Repo:** github.com/99apps-id/termigo  
**Date:** 2025-09-10  
**Auditor:** Termigo Agent (automated + manual review)  
**Scope:** Tool reading/execution, Telegram integration, general security

---

## Executive Summary

| Severity | Count | Categories |
|----------|-------|------------|
| CRITICAL | 1 | Regex crash in Telegram HTML renderer |
| HIGH | 2 | Telegram authorization bypass; command injection via newline |
| MEDIUM | 2 | Update replay on restart; potential DoS in control server |
| LOW | 3 | Token in URL, XSS vector in markdown links, pty_write unbounded |

---

## CRITICAL

### 1. Invalid regex crashes `markdownToTelegramHtml` at runtime
**File:** `src/modules/telegram/progressFormat.ts` (~line 185)  
**Function:** `markdownToTelegramHtml`

```typescript
// Step 11 — THIS REGEX IS INVALID IN JAVASCRIPT
text = text.replace(
  /(?<=^|[\s([{])_([^_ \r\n][^_\r\n]*?[^_ \r\n]|\S)_(?=[)\]}'\s.,:;!?]|$)/gm,
  "<i>$1</i>",
);
```

**Bug:** The lookbehind `(?<=^|[\s([{]])` is **variable-length** (`^` is zero-width, `[\s([{]]` is 1 char). JavaScript only supports **fixed-length** lookbehinds. This regex throws a `SyntaxError` at parse time.

**Impact:** Every call to `markdownToTelegramHtml` that reaches step 11 crashes the bot relay. Since this function is used for:
- All Telegram progress messages (`publishProgress`)
- All bot replies (`sendTelegram`, `sendKeyboard`, `editKeyboard`)
- Error messages and status updates

**The bot becomes completely non-functional for any text containing `_italic_` patterns.**

**Proof:**
```javascript
// In any JS engine:
new RegExp("(?<=^|[\\s([{])_)") // SyntaxError: Lookbehind assertion is not fixed length
```

**Fix:** Rewrite the regex using a non-lookbehind approach, e.g.:
```typescript
text = text.replace(/(?:^|[\s([{]])(_([^_ \r\n][^_\r\n]*?[^_ \r\n]|\S)_)(?=[)\]}'\s.,:;!?]|$)/gm, "$1<i>$2</i>");
```
Or use a two-pass approach: first match the surrounding context, then replace.

---

## HIGH

### 2. Telegram authorization bypass — sensitive commands work without pairing
**File:** `src/modules/telegram/bot.ts`  
**Functions:** `handleUpdate` (cases `/approve`, `/deny`, `/mode`, `/scope`)

```typescript
case "/approve": {
  const ownerUserId = useTelegramStore.getState().ownerUserId;
  if (
    ownerUserId &&
    (!msg.from || String(msg.from.id) !== String(ownerUserId))
  ) {
    return;
  }
  // If ownerUserId is NULL (unpaired), ANYONE can approve!
```

**Bug:** The authorization check uses `if (ownerUserId && ...)`. When the bot is **unpaired** (`ownerUserId === null`), the condition short-circuits and the command executes for any user in any chat.

**Affected commands:**
- `/approve` — approve ALL pending tool actions
- `/deny` — deny ALL pending tool actions  
- `/mode` — change agent approval mode (e.g., to "all" = autonomous execution)
- `/scope` — add/remove/toggle pentest scope

**Impact:** If the bot is unpaired (or the pairing state is lost), any Telegram user can:
- Approve dangerous tool executions (file writes, shell commands, network scans)
- Switch the agent to fully autonomous mode
- Modify the pentest scope to include new targets

**Fix:** Require pairing for sensitive commands, or reject when `ownerUserId` is null:
```typescript
if (!ownerUserId || String(msg.from?.id) !== String(ownerUserId)) {
  return;
}
```

### 3. Command injection via newline in shell validation
**File:** `src-tauri/src/modules/shell/mod.rs`  
**Function:** `validate_shell_command`, `wrap_with_sentinel`, `shell_session_run`

```rust
const SHELL_METACHARACTERS: &[char] = &[';', '|', '&', '$', '(', ')', '<', '>', '`'];
// NOTE: '\n' is MISSING
```

```rust
fn wrap_posix_with_sentinel(command: &str, sentinel: &str) -> String {
    format!(
        "{command}\n__termigo_rc=$?\nprintf '\\n%s%s\\n' '{sentinel}' \"$(pwd)\"\nexit $__termigo_rc\n",
    )
}
```

**Bug:** `validate_shell_command` blocks shell metacharacters but does **not** block newlines (`\n`). A command like:
```
echo hello\nrm -rf /some/path
```
passes validation. When wrapped by `wrap_posix_with_sentinel`, it becomes:
```
echo hello
rm -rf /some/path
__termigo_rc=$?
...
```
The newline acts as a command separator, executing arbitrary additional commands.

**Impact:** An agent (or user via PTY) can inject arbitrary shell commands by including newlines. The sandbox allowlist is bypassed.

**Fix:** Add `'\n'` and `'\r'` to `SHELL_METACHARACTERS`:
```rust
const SHELL_METACHARACTERS: &[char] = &[';', '|', '&', '$', '(', ')', '<', '>', '`', '\n', '\r'];
```

---

## MEDIUM

### 4. Telegram update replay on app restart
**File:** `src/modules/telegram/bot.ts`  
**Variable:** `currentUpdateOffset`

```typescript
let currentUpdateOffset = 0; // module-level, resets on every app restart
```

**Bug:** `currentUpdateOffset` is a module-level variable initialized to `0`. When the app restarts, it resets. The next `getUpdates` call uses `offset=0`, which tells Telegram to return **all unacknowledged updates** from the last ~24-48 hours.

**Impact:**
- Old messages are re-processed on every app restart
- Commands like `/approve`, `/run`, `/new` may execute again
- For a paired bot, this means duplicate runs and potential double-spending of API calls

**Fix:** Persist `currentUpdateOffset` to `localStorage` or the keychain, and restore it on startup. Telegram's `getUpdates` with a persisted offset ensures no replay.

### 5. Control server DoS via pending request exhaustion
**File:** `src-tauri/src/modules/control/router.rs`  
**Constants:** `MAX_PENDING_REQUESTS = 32`, `FRONTEND_TIMEOUT = 5s`

```rust
if pending.len() >= MAX_PENDING_REQUESTS {
    return ControlResponse::failure(id, "server_busy", "too many pending frontend requests");
}
```

**Bug:** The pending map uses a `sync_channel(1)` per request. If the frontend is slow or crashes, pending entries accumulate. Once 32 are pending, ALL new control requests (including `ping`) are rejected. There is no eviction of stale entries other than timeout.

**Impact:** A slow frontend (e.g., during a long agent run) can cause the control server to become unresponsive, blocking CLI commands, SSH sessions, and other IPC.

**Fix:** Add a cleanup sweep for requests older than `FRONTEND_TIMEOUT` before checking the limit.

---

## LOW

### 6. Telegram bot token exposed in URL
**File:** `src/modules/telegram/bot.ts`  
**Functions:** `apiGet`, `apiPost`, `apiPostForm`

```typescript
const res = await fetch(`${API}/bot${token}/${path}`, { signal: reqSignal });
```

**Bug:** The bot token is embedded in the request URL. While Telegram requires this format, the token becomes visible in:
- Browser/webview network logs
- Any proxy or debugging tool in the chain
- Terminal history if the URL is ever logged

**Impact:** Token leakage to logs or debugging tools. In a desktop app this is low risk, but it violates the principle of not putting secrets in URLs.

**Fix:** Not easily fixable due to Telegram API constraints, but ensure no URL logging exists anywhere in the codebase.

### 7. XSS via crafted markdown links in Telegram messages
**File:** `src/modules/telegram/progressFormat.ts`  
**Function:** `markdownToTelegramHtml`, step 13

```typescript
text = text.replace(
  /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
  '<a href="$2">$1</a>',
);
```

**Bug:** The link regex allows any `https?://` URL. While Telegram's HTML parser doesn't execute JavaScript, a malicious URL like `https://example.com"\ onclick="alert(1)` could break out of the `href` attribute if Telegram's parser is ever relaxed or if there's a parser bug.

**Impact:** Low risk today, but a future Telegram HTML parser change could turn this into XSS.

**Fix:** Sanitize the URL more strictly (e.g., allow only `[a-zA-Z0-9-._~:/?#\[\]@!$&'()*+,;=%]`).

### 8. `pty_write` has no payload size limit
**File:** `src-tauri/src/modules/pty/commands.rs`  
**Function:** `pty_write`

```rust
let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
    return Err("pty_write: expected raw body".to_string());
};
// bytes are written directly to PTY with no length check
```

**Bug:** The raw IPC body is written directly to the PTY master pipe with no size limit. A malicious or buggy frontend could send megabytes in one request, causing memory pressure and backpressure issues.

**Impact:** DoS via memory exhaustion. In practice, Tauri's IPC layer likely has limits, but this is a defense-in-depth gap.

**Fix:** Add a reasonable cap (e.g., 1 MB) and reject larger payloads.

---

## Additional Notes

### Positive Security Observations
1. **Control token** is 32 bytes (64 hex chars), randomly generated, and compared with constant-time equality.
2. **Descriptor file** is written atomically with `tempfile` + `rename`, mode `0600`.
3. **Path guards** (`guard_read`/`guard_write`) check both literal and canonicalized paths, blocking symlink escapes.
4. **Shell sandbox** uses an allowlist + metacharacter blocking (despite the newline gap).
5. **Secrets storage** uses platform keychains with chunking for oversized values.
6. **PTY output** has backpressure handling with overflow notice instead of silent truncation.
7. **Telegram pairing** uses both chat-level and user-level checks for sensitive operations (when paired).

### Recommendations
1. Fix the regex crash immediately — it makes the entire Telegram feature unusable.
2. Add `'\n'`/`'\r'` to shell metacharacters — this is a critical gap.
3. Require pairing for sensitive Telegram commands, or at least reject when unpaired.
4. Persist the Telegram update offset to prevent replay.
5. Add PTY write payload size limit as defense-in-depth.

---

## Files Reviewed
- `src/modules/telegram/bot.ts`
- `src/modules/telegram/keyring.ts`
- `src/modules/telegram/store.ts`
- `src/modules/telegram/useTelegramBot.ts`
- `src/modules/telegram/progressFormat.ts`
- `src-tauri/src/lib.rs`
- `src-tauri/src/modules/control/mod.rs`
- `src-tauri/src/modules/control/launcher.rs`
- `src-tauri/src/modules/control/router.rs`
- `src-tauri/src/modules/control/server.rs`
- `src-tauri/src/modules/control/validation.rs`
- `src-tauri/src/modules/shell/mod.rs`
- `src-tauri/src/modules/shell/session.rs`
- `src-tauri/src/modules/pty/commands.rs`
- `src-tauri/src/modules/pty/mod.rs`
- `src-tauri/src/modules/pty/session.rs`
- `src-tauri/src/modules/pty/da_filter.rs`
- `src-tauri/src/modules/fs/file.rs`
- `src-tauri/src/modules/fs/security.rs`
- `src-tauri/src/modules/secrets.rs`
- `src-tauri/src/modules/workspace.rs`
- `src-tauri/crates/termigo-control-protocol/src/lib.rs`
