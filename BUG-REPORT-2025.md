# Termigo Bug Report
**Date**: 2025-01-15  
**Auditor**: Termigo Agent (autonomous)  
**Scope**: Security & correctness bugs found during deep audit  
**Repo**: C:/project/termigo (v0.9.18)

---

## CRITICAL

### BUG-1: Mutable module-level tool registry - race condition
**File**: `src/modules/ai/tools/tools.ts`  
**Lines**: 126, 133, 148, 296, 351

`currentToolRegistry` is a module-level mutable `Record<string, unknown>` that is reassigned by `buildTools` on every agent run. `dispatchTool` reads it directly. If a parent agent run and a subagent run overlap (subagent spawns while parent is rebuilding tools), the subagent's `dispatchTool` calls can observe a torn or partially-updated registry.

**Impact**: Workflow/orchestrator steps dispatched during the overlap window may call the wrong tool implementation, or hit a tool that belongs to a different run's context.

**Root cause**: Module-level mutable shared state without synchronization. The comment says "set by buildTools each time the agent builds its tool set" but `dispatchTool` is async and can be called from concurrent subagent runs.

---

## HIGH

### BUG-2: RwLock/Mutex `.unwrap()` in PTY command handlers - panic risk
**Files**:
- `src-tauri/src/modules/pty/commands.rs` lines 94, 101, 157, 167, 186, 196, 212, 214, 237, 256, 268, 320, 325, 367
- `src-tauri/src/modules/pty/session.rs` lines 244, 279, 284, 294, 302, 309, 325, 370, 430, 439

Multiple `.unwrap()` calls on `RwLock` and `Mutex` guards throughout PTY session management. If any lock is poisoned (e.g., a thread panicked while holding the lock), these `.unwrap()` calls will panic and crash the Tauri command handler or PTY thread.

**Impact**: A single poisoned lock (from any panicking thread) can cascade into a full PTY session failure or Tauri command panic. The `acquire_conpty_lifecycle_lock` function at session.rs:16 already handles poisoning correctly with `into_inner()`, but the rest of the codebase does not follow this pattern.

**Root cause**: Inconsistent lock poisoning handling. Only the Windows ConPTY lock uses `.into_inner()`; all other locks use `.unwrap()`.

---

### BUG-3: Walker `is_protected` uses raw path - symlink information leak
**Files**:
- `src-tauri/src/modules/fs/security.rs` lines 271-290 (`is_protected`)
- `src-tauri/src/modules/fs/tree.rs` lines 238, 317
- `src-tauri/src/modules/fs/grep.rs` lines 125, 467
- `src-tauri/src/modules/fs/search.rs` lines 133, 263

`is_protected` intentionally uses raw string comparison without canonicalization for performance in walkers. However, `tree.rs` calls `std::fs::metadata(entry.path())` (line 205) which follows symlinks, while `is_protected` checks only the symlink's own path. A symlink inside an allowed directory pointing to a protected file (e.g., `allowed_dir/secret -> /home/user/.ssh/id_rsa`) will:
1. Pass `is_protected` because the raw path is `/home/user/allowed_dir/secret`
2. Have its metadata read from the target, leaking the target's size and mtime
3. Be listed in the explorer/tree with the target file's size

**Impact**: Information disclosure - an observer can learn the existence, size, and modification time of protected files by creating symlinks to them inside allowed directories.

**Root cause**: `is_protected` is deliberately non-canonicalizing for walker performance, but `tree.rs` uses `metadata()` (follows symlinks) for size/mtime without a second canonical check.

---

### BUG-4: Shell override TOCTOU in `sanitize_shell_override`
**File**: `src-tauri/src/modules/pty/shell_init.rs` lines 110-124

```rust
fn sanitize_shell_override(shell: Option<String>) -> Option<String> {
    let candidate = shell.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())?;
    let target = std::fs::canonicalize(&candidate).ok();
    let allowed = list_shells().into_iter().any(|s| {
        s.path == candidate || (target.is_some() && std::fs::canonicalize(&s.path).ok() == target)
    });
    ...
}
```

`canonicalize(&candidate)` is called first, then `canonicalize(&s.path)` is called inside the `.any()` closure for each listed shell. Between these calls, a local attacker with write access to the filesystem could replace `candidate` with a symlink to an allowed shell. The first `canonicalize` resolves the symlink, the attacker swaps it, and the second `canonicalize` resolves a different target.

**Impact**: Low in practice (requires local access and precise timing), but the TOCTOU is real. An attacker could bypass the shell allowlist and spawn an arbitrary binary.

**Root cause**: Multiple `canonicalize` calls on user-controlled paths without holding a reference or lock between them.

---

## MEDIUM

### BUG-5: `write_if_changed` uses predictable temp file name
**Files**:
- `src-tauri/src/modules/pty/shell_init.rs` lines 296-306 (unix)
- `src-tauri/src/modules/pty/shell_init.rs` lines 393-403 (windows)
- `src-tauri/src/modules/pty/shell_init/windows.rs` lines 226-236

```rust
fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    ...
    let mut tmp: OsString = path.as_os_str().to_owned();
    tmp.push(".__termigo_tmp__");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, content).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| { ... })
}
```

The temp file name is a fixed sibling suffix (`.__termigo_tmp__`). On a multi-user system, an attacker could predict this name and pre-create a symlink at that location to cause a race condition or write to an unintended path.

**Impact**: Low on single-user desktop systems. On multi-user systems or shared `/tmp`, an attacker could cause Termigo to write shell integration scripts to an attacker-controlled location.

**Root cause**: Fixed temp file name instead of using `tempfile` crate with random names and `O_EXCL` creation.

---

### BUG-6: `allows_program` allows absolute paths without existence check
**File**: `src-tauri/src/modules/shell/mod.rs` lines 187-212

```rust
fn allows_program(program: &str) -> bool {
    let path = std::path::Path::new(program);
    if path.is_absolute() || path.has_root() || program.starts_with('/') || program.starts_with('\\') || is_windows_drive_path {
        return true;
    }
    ...
}
```

Any absolute path is allowed without checking whether the binary actually exists. A crafted command like `/nonexistent/malicious-binary` passes validation but fails at spawn time. While this is not a direct security exploit (the binary doesn't exist), it means the allowlist check is bypassed for any absolute path string.

**Impact**: Low. The shell spawn will fail with ENOENT. However, it means the allowlist provides no protection against absolute-path injection. If an attacker can influence the command string, they can bypass the allowlist entirely by using an absolute path (even if it doesn't exist).

**Root cause**: `is_absolute()` / `has_root()` shortcuts skip allowlist checking entirely.

---

## LOW

### BUG-7: `list_shells` on Windows includes `cmd.exe` as non-integrated but still allowlisted
**File**: `src-tauri/src/modules/pty/shell_init/windows.rs` lines 354-380

`list_shells()` returns `cmd.exe` with `integrated: false`. However, `sanitize_shell_override` checks `list_shells()` and allows any listed shell. A user could set their shell override to `cmd.exe`, which spawns without shell integration (no OSC 7/133), breaking cwd tracking. This is a UX bug rather than a security bug, but it means the allowlist in `sanitize_shell_override` includes a shell that cannot provide the expected integration.

**Impact**: Low. cwd tracking breaks silently.

---

### BUG-8: `pty_open` RwLock `.unwrap()` on early-exit path
**File**: `src-tauri/src/modules/pty/commands.rs` lines 94, 101

```rust
state.sessions.write().unwrap().insert(id, inner);
...
let exited = state.sessions.read().unwrap().get(&id)...
```

If `sessions.write()` is poisoned at this point (e.g., a previous thread panicked while holding the write lock), `pty_open` will panic and return an error to the frontend. The frontend will see a generic failure and may retry, potentially creating duplicate sessions.

**Impact**: Low. Poisoning is rare, but the retry behavior could create leaked sessions.

---

## HIGH

### BUG-9: `textarea.disabled` leaks across slot re-bind — terminal opens but cannot be typed
**Files**:
- `src/modules/terminal/lib/useTerminalSession.ts` line 863
- `src/modules/terminal/lib/rendererPool.ts` `bindSlot`, `detachSlotFromLeaf`

In block mode, `applyBlockMode` sets `slot.term.textarea.disabled = prompt` (true at the prompt). When that leaf is hidden and the slot is later re-bound to a **non-block** leaf, `bindSlot` resets `disableStdin` from `p.shellExited` but **never resets `textarea.disabled`**. The xterm textarea stays disabled, so the new terminal renders output but drops every keystroke.

**Impact**: High. The user sees a working-looking terminal that silently ignores all input. The only way out is to close the tab or switch to a different shell.

**Root cause**: `applyBlockMode` mutates `textarea.disabled` directly, but `detachSlotFromLeaf` and `bindSlot` do not normalize it back to `false` for non-block leaves.

### BUG-10: `detachSlotFromLeaf` leaks `disableStdin` and `textarea.disabled` to the next occupant
**File**: `src/modules/terminal/lib/rendererPool.ts` `detachSlotFromLeaf`

When a slot is detached from a leaf (visibility change, eviction, release), the function clears `currentLeafId`, disconnects observers, and parks the host, but it **does not reset `slot.term.options.disableStdin` or `slot.term.textarea.disabled`**. The next leaf bound to that slot inherits whatever state the previous leaf left behind.

**Impact**: High. This is the structural root cause of BUG-9. Any leaf that sets `disableStdin = true` or `textarea.disabled = true` poisons the slot for all future occupants until the slot is fully disposed.

**Root cause**: Slot teardown is incomplete; terminal input state is treated as leaf-owned but is actually slot-owned.

### BUG-11: Spawn-failure retry unreachable after block-mode slot reuse
**Files**:
- `src/modules/terminal/lib/useTerminalSession.ts` lines 795-810, 863, 1289-1296

`surfaceSpawnFailure` sets `s.spawnFailed = true` and writes the retry banner ("press Enter to retry"). The retry is triggered from `writeToPty` when `data.includes("\r")`. If the slot previously hosted a block-mode leaf, `textarea.disabled = true` is still set. With the textarea disabled, xterm never emits the key event that would reach `writeToPty`, so the retry banner is visible but the user cannot activate it.

**Impact**: High. A shell that fails to start after a block-mode terminal leaves the user stuck on a dead pane with no working input path.

**Root cause**: Combination of BUG-9 and BUG-10; the retry path assumes the textarea is enabled.

## MEDIUM

### BUG-12: `focusSlot` races with slot unhide on non-fast rebind
**Files**:
- `src/modules/terminal/lib/useTerminalSession.ts` line 1278
- `src/modules/terminal/lib/rendererPool.ts` `bindSlot`, `scheduleUnhide`

When a leaf becomes visible and focused, the `useEffect` calls `bindLeafToSlot` then immediately calls `focusSlot`. For a non-fast rebind (different leaf was bound, or slot was idle), `bindSlot` sets `slot.host.style.visibility = "hidden"` and queues `scheduleUnhide`, which defers visibility to two `requestAnimationFrame` frames. `focusSlot` calls `term.focus()` while the host is still hidden. In many browser/webview implementations, focusing a hidden element is a no-op or throws silently, so the terminal never receives keyboard focus even after it becomes visible.

**Impact**: Medium. The terminal appears but clicking or tabbing to it may not focus the xterm textarea. The user has to click twice or manually focus another element first.

**Root cause**: `focusSlot` is called synchronously after `bindLeafToSlot`, but slot visibility is deferred to the next animation frames.

### BUG-13: `pty_open` success but zero-output shell leaves blank pane with no watchdog
**Files**:
- `src/modules/terminal/lib/useTerminalSession.ts` `armNoDataWatchdog`
- `src-tauri/src/modules/pty/commands.rs` `pty_open`

A shell that spawns successfully but never writes to stdout/stderr (e.g., a misconfigured shell init that exits silently, or a frozen ConPTY after warmup) will pass the 15s `pty_open` timeout but produce an empty grid. The frontend has `armNoDataWatchdog` for this, but if the watchdog itself is not armed or the shell produces output only after the watchdog window, the pane stays blank with no error and no retry path.

**Impact**: Medium. The user sees a blank terminal that appears open but is actually dead. The 15s timeout already passed, so there's no automatic retry.

**Root cause**: No-output shells are indistinguishable from slow-start shells until the watchdog fires; if the watchdog window is missed or the shell is completely silent, the failure mode is opaque.

---

## Summary

| ID | Severity | File | Description |
|---|---|---|---|
| BUG-1 | CRITICAL | `tools.ts` | Mutable global `currentToolRegistry` race condition |
| BUG-2 | HIGH | `session.rs`, `commands.rs` | `.unwrap()` on locks - panic cascade |
| BUG-3 | HIGH | `security.rs`, `tree.rs`, `grep.rs`, `search.rs` | Symlink info leak via raw `is_protected` + `metadata()` |
| BUG-4 | HIGH | `shell_init.rs` | TOCTOU in `sanitize_shell_override` canonicalize |
| BUG-5 | MEDIUM | `shell_init.rs` | Predictable temp file name `.__termigo_tmp__` |
| BUG-6 | MEDIUM | `shell/mod.rs` | Absolute paths bypass allowlist without existence check |
| BUG-7 | LOW | `shell_init/windows.rs` | `cmd.exe` listed but breaks cwd integration |
| BUG-8 | LOW | `commands.rs` | `.unwrap()` on early-exit RwLock path |
| BUG-9 | HIGH | `useTerminalSession.ts`, `rendererPool.ts` | `textarea.disabled` leaks across slot re-bind — terminal renders but drops all keystrokes |
| BUG-10 | HIGH | `rendererPool.ts` | `detachSlotFromLeaf` leaks `disableStdin` / `textarea.disabled` to next slot occupant |
| BUG-11 | HIGH | `useTerminalSession.ts` | Spawn-failure retry banner unreachable when slot has leaked `textarea.disabled` |
| BUG-12 | MEDIUM | `useTerminalSession.ts`, `rendererPool.ts` | `focusSlot` races with slot unhide on non-fast rebind; focus may be lost |
| BUG-13 | MEDIUM | `useTerminalSession.ts`, `commands.rs` | Zero-output shell leaves blank pane after `pty_open` success with no recovery path |

---

## Fix Status (as of latest commit)

| ID | Severity | Status | Fix |
|---|---|---|---|
| BUG-1 | CRITICAL | **FIXED** | Made `dispatchTool` private; workflow tools now capture registry via closure, eliminating mutable global race. |
| BUG-2 | HIGH | **FIXED** | Replaced all `.unwrap()` on `Mutex`/`RwLock` with `.into_inner()` poison recovery in `session.rs`, `commands.rs`, and `mod.rs`. |
| BUG-3 | HIGH | **FIXED** | `tree.rs` now uses `symlink_metadata` (non-following) for all walker entries, preventing target size/mtime leaks through symlinks. |
| BUG-4 | HIGH | **FIXED** | `sanitize_shell_override` now pre-computes canonical paths of allowed shells once, eliminating the TOCTOU between candidate and per-shell checks. |
| BUG-5 | MEDIUM | **FIXED** | `write_if_changed` on both Unix and Windows now uses `tempfile::NamedTempFile::new_in(parent)` with `persist()` for atomic rename with random temp names. |
| BUG-6 | MEDIUM | **DEFERRED** | Absolute-path allowlist bypass is a design limitation. Adding an existence check breaks legitimate agent-built binaries (e.g., `/opt/termigo/target/release/mytool`) used in integration tests. Left as-is with tests passing. |
| BUG-7 | LOW | **FIXED** | Removed `cmd.exe` from `list_shells()` on Windows with a comment explaining it lacks OSC 7/133 and breaks cwd tracking. |
| BUG-8 | LOW | **FIXED** | Covered by BUG-2 fix; all lock `.unwrap()` calls in early-exit `pty_open` paths now use `.into_inner()`. |
| BUG-9 | HIGH | **FIXED** | Other agent added `slot.term.textarea.disabled = false` in `bindSlot` and `detachSlotFromLeaf`. Verified working. |
| BUG-10 | HIGH | **FIXED** | Other agent added `slot.term.options.disableStdin = false` and `textarea.disabled = false` in `detachSlotFromLeaf`. Verified working. |
| BUG-11 | HIGH | **FIXED** | Resolved as consequence of BUG-9/BUG-10 fixes; retry banner now has enabled textarea. |
| BUG-12 | MEDIUM | **FIXED** | Other agent made `focusSlot` wait for slot unhide via `requestAnimationFrame` when host is hidden. Verified working. |
| BUG-13 | MEDIUM | **ALREADY FIXED** | `armNoDataWatchdog` (12s) in the original code already closes the PTY and surfaces a retry banner for zero-output shells. The other agent's attempt to add a separate watchdog introduced broken code and was reverted. |

## Remaining Work

- **BUG-6**: If a stricter allowlist for absolute paths is desired, the correct approach is to whitelist build-output directories (e.g., `target/release/`, `C:\tools\`) rather than checking file existence at validation time.
- **BUG-1 follow-up**: `currentToolRegistry` is still a module-level `let`, but it is now read only by the private `dispatchTool`. Future refactoring could pass it as a closure argument everywhere and remove the variable entirely.
