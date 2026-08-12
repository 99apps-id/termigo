use std::{
    collections::{HashMap, VecDeque},
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use serde::Serialize;
use serde_json::Value;

const MAX_WORKSPACE_ENTRIES: usize = 2_500;
const MAX_TEXT_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_TERMINAL_INPUT_BYTES: usize = 16 * 1024;
const MAX_AGENT_PROMPT_BYTES: usize = 32 * 1024;
const MAX_AGENT_EVENTS: usize = 500;
const MAX_AGENT_EVENT_TEXT_BYTES: usize = 8 * 1024;

#[derive(Default)]
struct WorkspaceState(Mutex<Option<PathBuf>>);

#[derive(Default)]
struct TerminalState {
    sessions: Mutex<HashMap<u64, TerminalSession>>,
    next_id: AtomicU64,
}

struct TerminalSession {
    writer: ChildStdin,
    child: Child,
    output: Arc<Mutex<TerminalOutputBuffer>>,
}

#[derive(Default)]
struct TerminalOutputBuffer {
    cursor: u64,
    bytes: usize,
    chunks: VecDeque<TerminalChunk>,
    remaining_readers: usize,
    closed: bool,
}

struct TerminalChunk {
    start: u64,
    contents: String,
}

#[derive(Default)]
struct AgentState {
    runs: Mutex<HashMap<u64, AgentRun>>,
    next_id: AtomicU64,
}

struct AgentRun {
    child: Child,
    output: Arc<Mutex<AgentOutputBuffer>>,
}

#[derive(Default)]
struct AgentOutputBuffer {
    cursor: u64,
    events: VecDeque<AgentEvent>,
    remaining_readers: usize,
    closed: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Vec<FileNode>,
}

#[derive(Serialize)]
struct Workspace {
    path: String,
    tree: Vec<FileNode>,
}

#[derive(Serialize)]
struct FileDocument {
    path: String,
    contents: String,
    language: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalInfo {
    id: u64,
    shell: String,
    cwd: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalRead {
    contents: String,
    cursor: u64,
    closed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentEvent {
    cursor: u64,
    kind: String,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentInfo {
    id: u64,
    provider: String,
    cwd: String,
    access: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRead {
    events: Vec<AgentEvent>,
    cursor: u64,
    closed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStatus {
    available: bool,
    authenticated: bool,
    version: Option<String>,
    detail: String,
}

#[tauri::command]
fn workspace_open(
    path: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<Workspace, String> {
    let root = fs::canonicalize(path).map_err(|error| format!("Cannot access folder: {error}"))?;
    if !root.is_dir() {
        return Err("The selected path is not a folder.".to_owned());
    }
    *state
        .0
        .lock()
        .map_err(|_| "Workspace lock is unavailable.")? = Some(root);
    workspace_snapshot(&state)
}

#[tauri::command]
fn workspace_refresh(state: tauri::State<'_, WorkspaceState>) -> Result<Workspace, String> {
    workspace_snapshot(&state)
}

#[tauri::command]
fn workspace_read_text_file(
    path: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<FileDocument, String> {
    let path = workspace_file(&state, &path)?;
    let bytes = fs::read(&path).map_err(|error| format!("Cannot read file: {error}"))?;
    if bytes.len() > MAX_TEXT_FILE_BYTES {
        return Err("Files larger than 2 MB cannot be opened in the editor yet.".to_owned());
    }
    if bytes.contains(&0) {
        return Err("Binary files cannot be opened in the text editor.".to_owned());
    }
    let contents = String::from_utf8(bytes).map_err(|_| "The file is not valid UTF-8 text.")?;
    Ok(FileDocument {
        path: display_path(&path),
        contents,
        language: language_for_path(&path).to_owned(),
    })
}

#[tauri::command]
fn workspace_save_text_file(
    path: String,
    contents: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    if contents.len() > MAX_TEXT_FILE_BYTES {
        return Err("Files larger than 2 MB cannot be saved in the editor yet.".to_owned());
    }
    let path = workspace_file(&state, &path)?;
    fs::write(&path, contents).map_err(|error| format!("Cannot save file: {error}"))
}

#[tauri::command]
fn terminal_start(
    workspace: tauri::State<'_, WorkspaceState>,
    terminals: tauri::State<'_, TerminalState>,
) -> Result<TerminalInfo, String> {
    let cwd = workspace_root(&workspace)?;
    let mut child = terminal_command(&cwd)
        .spawn()
        .map_err(|error| format!("Cannot start terminal shell: {error}"))?;
    let mut writer = child
        .stdin
        .take()
        .ok_or_else(|| "Cannot open terminal input.".to_owned())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Cannot open terminal output.".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Cannot open terminal errors.".to_owned())?;
    writer
        .write_all(b"chcp 65001 > nul\r\n")
        .and_then(|_| writer.flush())
        .map_err(|error| format!("Cannot configure terminal text encoding: {error}"))?;
    let output = Arc::new(Mutex::new(TerminalOutputBuffer::with_readers(2)));
    let stdout_output = Arc::clone(&output);
    std::thread::spawn(move || read_terminal_output(stdout, stdout_output));
    let stderr_output = Arc::clone(&output);
    std::thread::spawn(move || read_terminal_output(stderr, stderr_output));

    let id = terminals.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    terminals
        .sessions
        .lock()
        .map_err(|_| "Terminal lock is unavailable.".to_owned())?
        .insert(
            id,
            TerminalSession {
                writer,
                child,
                output,
            },
        );

    Ok(TerminalInfo {
        id,
        shell: default_shell_name().to_owned(),
        cwd: display_path(&cwd),
    })
}

#[tauri::command]
fn terminal_write(
    id: u64,
    data: String,
    terminals: tauri::State<'_, TerminalState>,
) -> Result<(), String> {
    if data.len() > MAX_TERMINAL_INPUT_BYTES {
        return Err("Terminal input is too large.".to_owned());
    }
    let mut sessions = terminals
        .sessions
        .lock()
        .map_err(|_| "Terminal lock is unavailable.".to_owned())?;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| "Terminal session is no longer available.".to_owned())?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|error| format!("Cannot send terminal input: {error}"))
}

#[tauri::command]
fn terminal_read(
    id: u64,
    cursor: u64,
    terminals: tauri::State<'_, TerminalState>,
) -> Result<TerminalRead, String> {
    let sessions = terminals
        .sessions
        .lock()
        .map_err(|_| "Terminal lock is unavailable.".to_owned())?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| "Terminal session is no longer available.".to_owned())?;
    let output = session
        .output
        .lock()
        .map_err(|_| "Terminal output is unavailable.".to_owned())?;
    Ok(output.read_since(cursor))
}

#[tauri::command]
fn terminal_close(id: u64, terminals: tauri::State<'_, TerminalState>) -> Result<(), String> {
    let mut session = terminals
        .sessions
        .lock()
        .map_err(|_| "Terminal lock is unavailable.".to_owned())?
        .remove(&id)
        .ok_or_else(|| "Terminal session is no longer available.".to_owned())?;
    let _ = session.child.kill();
    let _ = session.child.wait();
    Ok(())
}

#[tauri::command]
fn agent_status() -> AgentStatus {
    let executable = codex_executable();
    let version = match Command::new(&executable).arg("--version").output() {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if version.is_empty() {
                None
            } else {
                Some(version)
            }
        }
        _ => {
            return AgentStatus {
                available: false,
                authenticated: false,
                version: None,
                detail: "Codex CLI was not found. Install it and sign in with ChatGPT first."
                    .to_owned(),
            };
        }
    };

    let authenticated = Command::new(executable)
        .args(["login", "status"])
        .output()
        .map(|output| {
            output.status.success() && String::from_utf8_lossy(&output.stdout).contains("Logged in")
        })
        .unwrap_or(false);

    AgentStatus {
        available: true,
        authenticated,
        version,
        detail: if authenticated {
            "Connected through the existing Codex ChatGPT sign-in.".to_owned()
        } else {
            "Run `codex login` in a terminal, then sign in with ChatGPT.".to_owned()
        },
    }
}

#[tauri::command]
fn agent_start(
    prompt: String,
    access: String,
    workspace: tauri::State<'_, WorkspaceState>,
    agents: tauri::State<'_, AgentState>,
) -> Result<AgentInfo, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("Write a task for Codex first.".to_owned());
    }
    if prompt.len() > MAX_AGENT_PROMPT_BYTES {
        return Err("Agent prompts are limited to 32 KB.".to_owned());
    }
    let sandbox = match access.as_str() {
        "read-only" => "read-only",
        "workspace-write" => "workspace-write",
        _ => return Err("Unsupported agent access mode.".to_owned()),
    };
    let cwd = workspace_root(&workspace)?;
    let mut child = Command::new(codex_executable())
        .args([
            "exec",
            "--json",
            "--color",
            "never",
            "--skip-git-repo-check",
            "--ephemeral",
            "-s",
            sandbox,
            "-C",
        ])
        .arg(&cwd)
        .arg("-")
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Cannot start Codex CLI: {error}"))?;
    let mut input = child
        .stdin
        .take()
        .ok_or_else(|| "Cannot open Codex input.".to_owned())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Cannot open Codex output.".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Cannot open Codex errors.".to_owned())?;
    if let Err(error) = input
        .write_all(prompt.as_bytes())
        .and_then(|_| input.write_all(b"\n"))
        .and_then(|_| input.flush())
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("Cannot send task to Codex: {error}"));
    }
    drop(input);

    let output = Arc::new(Mutex::new(AgentOutputBuffer::with_readers(2)));
    let stdout_output = Arc::clone(&output);
    std::thread::spawn(move || read_agent_output(stdout, stdout_output));
    let stderr_output = Arc::clone(&output);
    std::thread::spawn(move || read_agent_errors(stderr, stderr_output));

    let id = agents.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    agents
        .runs
        .lock()
        .map_err(|_| "Agent lock is unavailable.".to_owned())?
        .insert(id, AgentRun { child, output });

    Ok(AgentInfo {
        id,
        provider: "Codex CLI".to_owned(),
        cwd: display_path(&cwd),
        access: access.to_owned(),
    })
}

#[tauri::command]
fn agent_read(
    id: u64,
    cursor: u64,
    agents: tauri::State<'_, AgentState>,
) -> Result<AgentRead, String> {
    let mut runs = agents
        .runs
        .lock()
        .map_err(|_| "Agent lock is unavailable.".to_owned())?;
    let run = runs
        .get_mut(&id)
        .ok_or_else(|| "Agent run is no longer available.".to_owned())?;
    let output = run
        .output
        .lock()
        .map_err(|_| "Agent output is unavailable.".to_owned())?;
    let result = output.read_since(cursor);
    let finished = result.closed;
    drop(output);
    if finished {
        let _ = run.child.try_wait();
        runs.remove(&id);
    }
    Ok(result)
}

#[tauri::command]
fn agent_cancel(id: u64, agents: tauri::State<'_, AgentState>) -> Result<(), String> {
    let mut runs = agents
        .runs
        .lock()
        .map_err(|_| "Agent lock is unavailable.".to_owned())?;
    let run = runs
        .get_mut(&id)
        .ok_or_else(|| "Agent run is no longer available.".to_owned())?;
    let _ = run.child.kill();
    let _ = run.child.wait();
    let mut output = run
        .output
        .lock()
        .map_err(|_| "Agent output is unavailable.".to_owned())?;
    output.append("status", "Codex run cancelled.".to_owned());
    output.closed = true;
    Ok(())
}

impl AgentOutputBuffer {
    fn with_readers(remaining_readers: usize) -> Self {
        Self {
            remaining_readers,
            ..Self::default()
        }
    }

    fn append(&mut self, kind: &str, text: String) {
        let text = truncate_text(text);
        if text.trim().is_empty() {
            return;
        }
        self.cursor += 1;
        self.events.push_back(AgentEvent {
            cursor: self.cursor,
            kind: kind.to_owned(),
            text,
        });
        while self.events.len() > MAX_AGENT_EVENTS {
            self.events.pop_front();
        }
    }

    fn read_since(&self, cursor: u64) -> AgentRead {
        AgentRead {
            events: self
                .events
                .iter()
                .filter(|event| event.cursor > cursor)
                .cloned()
                .collect(),
            cursor: self.cursor,
            closed: self.closed,
        }
    }

    fn finish_reader(&mut self) {
        self.remaining_readers = self.remaining_readers.saturating_sub(1);
        self.closed = self.remaining_readers == 0;
    }
}

fn read_agent_output<R: Read>(reader: R, output: Arc<Mutex<AgentOutputBuffer>>) {
    let reader = BufReader::new(reader);
    for line in reader.lines() {
        let Ok(line) = line else {
            break;
        };
        let Some((kind, text)) = parse_codex_event(&line) else {
            continue;
        };
        let Ok(mut output) = output.lock() else {
            break;
        };
        output.append(kind, text);
    }
    if let Ok(mut output) = output.lock() {
        output.finish_reader();
    }
}

fn read_agent_errors<R: Read>(reader: R, output: Arc<Mutex<AgentOutputBuffer>>) {
    let reader = BufReader::new(reader);
    for line in reader.lines() {
        let Ok(line) = line else {
            break;
        };
        let text = line.trim();
        if text.is_empty() {
            continue;
        }
        let Ok(mut output) = output.lock() else {
            break;
        };
        output.append("error", format!("Codex CLI: {text}"));
    }
    if let Ok(mut output) = output.lock() {
        output.finish_reader();
    }
}

fn parse_codex_event(line: &str) -> Option<(&'static str, String)> {
    let event: Value = serde_json::from_str(line).ok()?;
    match event.get("type")?.as_str()? {
        "thread.started" => Some(("status", "Codex session started.".to_owned())),
        "turn.started" => Some(("status", "Codex is working…".to_owned())),
        "turn.completed" => Some(("status", "Codex completed this task.".to_owned())),
        "turn.failed" | "error" => event_message(&event)
            .map(|message| ("error", format!("Codex: {message}")))
            .or_else(|| Some(("error", "Codex could not complete this task.".to_owned()))),
        "item.completed" => {
            let item = event.get("item")?;
            match item.get("type")?.as_str()? {
                "agent_message" => item
                    .get("text")
                    .and_then(Value::as_str)
                    .map(|text| ("assistant", text.to_owned())),
                "error" => {
                    event_message(item).map(|message| ("error", format!("Codex: {message}")))
                }
                _ => None,
            }
        }
        _ => None,
    }
}

fn event_message(value: &Value) -> Option<String> {
    value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| value.get("message").and_then(Value::as_str))
        .or_else(|| value.pointer("/item/text").and_then(Value::as_str))
        .map(str::to_owned)
}

fn truncate_text(text: String) -> String {
    if text.len() <= MAX_AGENT_EVENT_TEXT_BYTES {
        return text;
    }
    let mut end = MAX_AGENT_EVENT_TEXT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n\n[Termigo truncated this event.]", &text[..end])
}

fn codex_executable() -> PathBuf {
    #[cfg(windows)]
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        let bundled = PathBuf::from(local_app_data)
            .join("Programs")
            .join("OpenAI")
            .join("Codex")
            .join("bin")
            .join("codex.exe");
        if bundled.is_file() {
            return bundled;
        }
    }
    PathBuf::from("codex")
}

impl TerminalOutputBuffer {
    fn with_readers(remaining_readers: usize) -> Self {
        Self {
            remaining_readers,
            ..Self::default()
        }
    }

    fn append(&mut self, contents: String) {
        if contents.is_empty() {
            return;
        }
        let length = contents.len();
        self.chunks.push_back(TerminalChunk {
            start: self.cursor,
            contents,
        });
        self.cursor += length as u64;
        self.bytes += length;
        while self.bytes > MAX_TERMINAL_OUTPUT_BYTES {
            let Some(removed) = self.chunks.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(removed.contents.len());
        }
    }

    fn read_since(&self, cursor: u64) -> TerminalRead {
        let earliest_cursor = self
            .chunks
            .front()
            .map(|chunk| chunk.start)
            .unwrap_or(self.cursor);
        let from = cursor.max(earliest_cursor);
        let contents = self
            .chunks
            .iter()
            .filter(|chunk| chunk.start >= from)
            .map(|chunk| chunk.contents.as_str())
            .collect();
        TerminalRead {
            contents,
            cursor: self.cursor,
            closed: self.closed,
        }
    }

    fn finish_reader(&mut self) {
        self.remaining_readers = self.remaining_readers.saturating_sub(1);
        self.closed = self.remaining_readers == 0;
    }
}

fn read_terminal_output<R: Read>(mut reader: R, output: Arc<Mutex<TerminalOutputBuffer>>) {
    let mut buffer = [0_u8; 4_096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => {
                let contents = String::from_utf8_lossy(&buffer[..size]).into_owned();
                let Ok(mut output) = output.lock() else {
                    break;
                };
                output.append(contents);
            }
            Err(_) => break,
        }
    }
    if let Ok(mut output) = output.lock() {
        output.finish_reader();
    }
}

fn terminal_command(cwd: &Path) -> Command {
    #[cfg(windows)]
    {
        let shell = windows_shell();
        let mut command = Command::new(&shell);
        if shell == "cmd.exe" {
            command.args(["/D", "/Q", "/K"]);
        } else {
            // PowerShell family: keep an interactive session running.
            command.args(["-NoLogo", "-NoExit"]);
        }
        command.current_dir(cwd);
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command
    }
    #[cfg(not(windows))]
    {
        let mut command =
            Command::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned()));
        command.current_dir(cwd);
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command
    }
}

// windows_shell prefers PowerShell 7, then Windows PowerShell, then cmd.exe,
// mirroring how terminal users expect a workspace shell to behave.
#[cfg(windows)]
fn windows_shell() -> String {
    for candidate in ["pwsh.exe", "powershell.exe", "cmd.exe"] {
        if executable_on_path(candidate) {
            return candidate.to_owned();
        }
    }
    "cmd.exe".to_owned()
}

#[cfg(windows)]
fn executable_on_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return true;
        }
    }
    false
}

fn default_shell_name() -> &'static str {
    #[cfg(windows)]
    {
        match windows_shell().as_str() {
            "pwsh.exe" => "PowerShell 7",
            "powershell.exe" => "Windows PowerShell",
            _ => "Command Prompt",
        }
    }
    #[cfg(not(windows))]
    {
        "Shell"
    }
}

fn workspace_snapshot(state: &WorkspaceState) -> Result<Workspace, String> {
    let root = workspace_root(state)?;
    let mut count = 0;
    Ok(Workspace {
        path: display_path(&root),
        tree: read_directory(&root, &mut count)?,
    })
}

fn workspace_root(state: &WorkspaceState) -> Result<PathBuf, String> {
    state
        .0
        .lock()
        .map_err(|_| "Workspace lock is unavailable.".to_owned())?
        .clone()
        .ok_or_else(|| "Open a workspace first.".to_owned())
}

fn workspace_file(state: &WorkspaceState, requested: &str) -> Result<PathBuf, String> {
    let root = workspace_root(state)?;
    let path =
        fs::canonicalize(requested).map_err(|error| format!("Cannot access file: {error}"))?;
    if !path.starts_with(&root) {
        return Err("File operations must stay inside the active workspace.".to_owned());
    }
    if !path.is_file() {
        return Err("The selected path is not a file.".to_owned());
    }
    Ok(path)
}

fn read_directory(path: &Path, count: &mut usize) -> Result<Vec<FileNode>, String> {
    let mut nodes = Vec::new();
    let entries = fs::read_dir(path).map_err(|error| format!("Cannot read folder: {error}"))?;
    for entry in entries {
        if *count >= MAX_WORKSPACE_ENTRIES {
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_symlink() || ignored_name(&entry.file_name()) {
            continue;
        }
        *count += 1;
        let entry_path = entry.path();
        let is_dir = file_type.is_dir();
        let children = if is_dir {
            read_directory(&entry_path, count).unwrap_or_default()
        } else {
            Vec::new()
        };
        nodes.push(FileNode {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: display_path(&entry_path),
            is_dir,
            children,
        });
    }
    nodes.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(nodes)
}

fn ignored_name(name: &std::ffi::OsStr) -> bool {
    matches!(
        name.to_string_lossy().as_ref(),
        ".git" | ".idea" | ".next" | ".turbo" | "dist" | "node_modules" | "target" | "vendor"
    )
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn language_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "go" => "go",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "rs" => "rust",
        "py" => "python",
        "html" | "htm" => "html",
        "css" | "scss" | "less" => "css",
        "json" => "json",
        "md" | "mdx" => "markdown",
        "yml" | "yaml" => "yaml",
        "sh" | "ps1" | "bat" | "cmd" => "shell",
        _ => "plaintext",
    }
}

// ---------------------------------------------------------------------------
// Git integration
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitFile {
    path: String,
    status: String,
    staged: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStatus {
    branch: String,
    files: Vec<GitFile>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommit {
    hash: String,
    short_hash: String,
    message: String,
    author: String,
    date: String,
}

fn git_command(root: &Path) -> Command {
    let mut command = Command::new("git");
    command.current_dir(root);
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command
}

fn git_output(command: &mut Command) -> Result<String, String> {
    let output = command
        .output()
        .map_err(|error| format!("Cannot run git: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if stderr.is_empty() {
            "git command failed.".to_owned()
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[tauri::command]
fn git_status(state: tauri::State<'_, WorkspaceState>) -> Result<GitStatus, String> {
    let root = workspace_root(&state)?;
    let output = git_output(git_command(&root).args(["status", "--porcelain=v1", "-b"]))?;
    let (branch, files) = parse_git_status(&output);
    Ok(GitStatus { branch, files })
}

// parse_git_status turns `git status --porcelain=v1 -b` output into a branch
// name and a file list. Extracted so it can be unit tested.
fn parse_git_status(output: &str) -> (String, Vec<GitFile>) {
    let mut branch = "(no branch)".to_owned();
    let mut files = Vec::new();
    for line in output.lines() {
        if let Some(head) = line.strip_prefix("## ") {
            // Detached HEAD prints "HEAD (no branch)" (or "(detached at ...)"
            // on older git versions); normalize it for the UI.
            if head.trim() == "HEAD" || head.contains("(no branch)") || head.contains("(detached") {
                branch = "(detached HEAD)".to_owned();
            } else {
                branch = head.split("...").next().unwrap_or(head).trim().to_owned();
                if branch.is_empty() {
                    branch = "(detached HEAD)".to_owned();
                }
            }
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let x = line.as_bytes()[0] as char;
        let y = line.as_bytes()[1] as char;
        let staged = x != ' ' && x != '?';
        let status = if staged { x } else { y };
        let mut path = line[3..].to_owned();
        if let Some(arrow) = path.find(" -> ") {
            path = path[arrow + 4..].to_owned();
        }
        files.push(GitFile {
            path,
            status: status.to_string(),
            staged,
        });
    }
    (branch, files)
}

#[tauri::command]
fn git_diff(
    state: tauri::State<'_, WorkspaceState>,
    path: Option<String>,
    staged: bool,
) -> Result<String, String> {
    let root = workspace_root(&state)?;
    let mut command = git_command(&root);
    command.arg("diff");
    if staged {
        command.arg("--cached");
    }
    if let Some(path) = path {
        let path = workspace_file(&state, &path)?;
        command.arg("--").arg(path);
    }
    git_output(&mut command)
}

#[tauri::command]
fn git_stage(state: tauri::State<'_, WorkspaceState>, paths: Vec<String>) -> Result<(), String> {
    let root = workspace_root(&state)?;
    let mut command = git_command(&root);
    command.arg("add");
    if paths.is_empty() {
        command.arg("-A");
    } else {
        command.arg("--");
        for path in paths {
            command.arg(path);
        }
    }
    git_output(&mut command).map(|_| ())
}

#[tauri::command]
fn git_unstage(state: tauri::State<'_, WorkspaceState>, paths: Vec<String>) -> Result<(), String> {
    let root = workspace_root(&state)?;
    let mut command = git_command(&root);
    command.args(["restore", "--staged", "--"]);
    for path in paths {
        command.arg(path);
    }
    git_output(&mut command).map(|_| ())
}

#[tauri::command]
fn git_commit(state: tauri::State<'_, WorkspaceState>, message: String) -> Result<(), String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Commit message must not be empty.".to_owned());
    }
    let root = workspace_root(&state)?;
    let mut command = git_command(&root);
    command.args(["commit", "-m"]).arg(message);
    git_output(&mut command).map(|_| ())
}

#[tauri::command]
fn git_log(
    state: tauri::State<'_, WorkspaceState>,
    limit: Option<usize>,
) -> Result<Vec<GitCommit>, String> {
    let root = workspace_root(&state)?;
    let limit = limit.unwrap_or(30).clamp(1, 200);
    let mut command = git_command(&root);
    command
        .args(["log", "-n", &limit.to_string(), "--pretty=format:%H%x1f%s%x1f%an%x1f%aI"]);
    let output = git_output(&mut command)?;
    let commits = output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, '\u{1f}');
            let hash = parts.next()?.to_owned();
            let message = parts.next().unwrap_or("").to_owned();
            let author = parts.next().unwrap_or("").to_owned();
            let date = parts.next().unwrap_or("").to_owned();
            Some(GitCommit {
                short_hash: hash.chars().take(8).collect(),
                hash,
                message,
                author,
                date,
            })
        })
        .collect();
    Ok(commits)
}

// ---------------------------------------------------------------------------
// File search
// ---------------------------------------------------------------------------

const MAX_SEARCH_RESULTS: usize = 200;

#[tauri::command]
fn workspace_search_files(
    state: tauri::State<'_, WorkspaceState>,
    query: String,
) -> Result<Vec<String>, String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let root = workspace_root(&state)?;
    let mut results = Vec::new();
    let mut count = 0;
    search_directory(&root, &query, &mut results, &mut count);
    Ok(results)
}

fn search_directory(path: &Path, query: &str, results: &mut Vec<String>, count: &mut usize) {
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        if *count >= MAX_SEARCH_RESULTS {
            return;
        }
        let name = entry.file_name();
        if ignored_name(&name) {
            continue;
        }
        let entry_path = entry.path();
        let name_lower = name.to_string_lossy().to_lowercase();
        let is_dir = entry
            .file_type()
            .map(|file_type| file_type.is_dir())
            .unwrap_or(false);
        if !is_dir && name_lower.contains(query) {
            *count += 1;
            results.push(display_path(&entry_path));
        }
        if is_dir {
            search_directory(&entry_path, query, results, count);
        }
    }
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillInfo {
    name: String,
    description: String,
    path: String,
    scope: String,
}

#[tauri::command]
fn skills_list(state: tauri::State<'_, WorkspaceState>) -> Result<Vec<SkillInfo>, String> {
    let root = workspace_root(&state)?;
    let project_root = root.join(".termigo").join("skills");
    let mut skills = read_skills(&project_root, "project");
    if let Ok(home) = std::env::var("TERMIGO_HOME") {
        skills.append(&mut read_skills(&PathBuf::from(home).join("skills"), "user"));
    } else if let Some(base) = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
    {
        skills.append(&mut read_skills(&base.join(".termigo").join("skills"), "user"));
    }
    skills.sort_by_key(|skill| skill.name.to_lowercase());
    Ok(skills)
}

fn read_skills(root: &Path, scope: &str) -> Vec<SkillInfo> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut skills = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let document = entry.path().join("SKILL.md");
        let Ok(content) = std::fs::read_to_string(&document) else {
            continue;
        };
        let (name, description) = parse_skill_frontmatter(&content);
        let name = if name.is_empty() {
            entry.file_name().to_string_lossy().into_owned()
        } else {
            name
        };
        skills.push(SkillInfo {
            name,
            description,
            path: display_path(&entry.path()),
            scope: scope.to_owned(),
        });
    }
    skills
}

// parse_skill_frontmatter reads `name` and `description` from a SKILL.md YAML
// header without pulling in a YAML dependency.
fn parse_skill_frontmatter(content: &str) -> (String, String) {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (String::new(), String::new());
    }
    let mut name = String::new();
    let mut description = String::new();
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if let Some(value) = line.strip_prefix("name:") {
            name = value.trim().to_owned();
        } else if let Some(value) = line.strip_prefix("description:") {
            description = value.trim().to_owned();
        }
    }
    (name, description)
}

// ---------------------------------------------------------------------------
// Agent providers
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderStatus {
    id: String,
    name: String,
    available: bool,
    version: Option<String>,
    detail: String,
}

const PROVIDER_TARGETS: &[(&str, &str)] = &[
    ("codex", "Codex CLI"),
    ("claude", "Claude Code"),
    ("gemini", "Gemini CLI"),
    ("ollama", "Ollama (local)"),
];

#[tauri::command]
fn agent_providers() -> Vec<ProviderStatus> {
    PROVIDER_TARGETS
        .iter()
        .map(|(id, name)| {
            let mut status = ProviderStatus {
                id: (*id).to_owned(),
                name: (*name).to_owned(),
                available: false,
                version: None,
                detail: format!("{name} was not found on PATH."),
            };
            if let Ok(output) = Command::new(id).arg("--version").output() {
                if output.status.success() {
                    let version = String::from_utf8_lossy(&output.stdout)
                        .trim()
                        .to_owned();
                    status.available = true;
                    status.version = if version.is_empty() { None } else { Some(version) };
                    status.detail = "Installed and ready.".to_owned();
                }
            }
            status
        })
        .collect()
}

fn main() {
    tauri::Builder::default()
        .manage(WorkspaceState::default())
        .manage(TerminalState::default())
        .manage(AgentState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            workspace_open,
            workspace_refresh,
            workspace_read_text_file,
            workspace_save_text_file,
            workspace_search_files,
            skills_list,
            terminal_start,
            terminal_write,
            terminal_read,
            terminal_close,
            git_status,
            git_diff,
            git_stage,
            git_unstage,
            git_commit,
            git_log,
            agent_status,
            agent_providers,
            agent_start,
            agent_read,
            agent_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Termigo");
}

#[cfg(test)]
mod tests {
    use super::{
        ignored_name, language_for_path, parse_codex_event, parse_git_status,
        parse_skill_frontmatter, AgentOutputBuffer, TerminalOutputBuffer,
    };
    use std::path::Path;

    #[test]
    fn detects_supported_editor_languages() {
        assert_eq!(language_for_path(Path::new("main.rs")), "rust");
        assert_eq!(language_for_path(Path::new("component.tsx")), "typescript");
        assert_eq!(language_for_path(Path::new("README")), "plaintext");
    }

    #[test]
    fn omits_generated_directories_from_the_explorer() {
        assert!(ignored_name(std::ffi::OsStr::new("node_modules")));
        assert!(ignored_name(std::ffi::OsStr::new(".git")));
        assert!(!ignored_name(std::ffi::OsStr::new("src")));
    }

    #[test]
    fn parses_git_status_lines() {
        let sample = "## main...origin/main [ahead 1]\n M modified.txt\nA  staged.txt\n?? new.txt\nR  old.txt -> moved.txt\n";
        let (branch, files) = parse_git_status(sample);
        assert_eq!(branch, "main");
        assert_eq!(files.len(), 4);

        assert_eq!(files[0].path, "modified.txt");
        assert_eq!(files[0].status, "M");
        assert!(!files[0].staged);

        assert_eq!(files[1].path, "staged.txt");
        assert_eq!(files[1].status, "A");
        assert!(files[1].staged);

        assert_eq!(files[2].path, "new.txt");
        assert_eq!(files[2].status, "?");
        assert!(!files[2].staged);

        assert_eq!(files[3].path, "moved.txt");
    }

    #[test]
    fn parses_detached_git_head() {
        let (branch, files) = parse_git_status("## HEAD (no branch)\n");
        assert_eq!(branch, "(detached HEAD)");
        assert!(files.is_empty());
    }

    #[test]
    fn parses_skill_frontmatter() {
        let (name, description) =
            parse_skill_frontmatter("---\nname: review\ndescription: Review the change set.\n---\n\nBody.\n");
        assert_eq!(name, "review");
        assert_eq!(description, "Review the change set.");
    }

    #[test]
    fn skill_without_frontmatter_has_no_metadata() {
        let (name, description) = parse_skill_frontmatter("just instructions");
        assert!(name.is_empty());
        assert!(description.is_empty());
    }

    #[test]
    fn terminal_output_replays_only_the_new_chunks() {
        let mut output = TerminalOutputBuffer::default();
        output.append("first".to_owned());
        let first_read = output.read_since(0);
        assert_eq!(first_read.contents, "first");
        output.append(" second".to_owned());
        let next_read = output.read_since(first_read.cursor);
        assert_eq!(next_read.contents, " second");
    }

    #[test]
    fn codex_agent_messages_are_extracted_from_json_events() {
        let event = parse_codex_event(
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Hello from Codex"}}"#,
        )
        .expect("parse agent message");
        assert_eq!(event.0, "assistant");
        assert_eq!(event.1, "Hello from Codex");
    }

    #[test]
    fn agent_output_reads_only_new_events() {
        let mut output = AgentOutputBuffer::default();
        output.append("status", "Started".to_owned());
        let first = output.read_since(0);
        assert_eq!(first.events.len(), 1);
        output.append("assistant", "Completed".to_owned());
        let next = output.read_since(first.cursor);
        assert_eq!(next.events.len(), 1);
        assert_eq!(next.events[0].text, "Completed");
    }

    #[cfg(windows)]
    #[test]
    fn windows_shell_pipe_returns_command_output() {
        use std::{
            io::Write,
            process::{Command, Stdio},
        };

        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/Q", "/K"]);
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        let mut child = command.spawn().expect("start cmd.exe");
        let mut input = child.stdin.take().expect("open cmd.exe input");
        input
            .write_all(b"echo termigo-pipe\r\nexit\r\n")
            .expect("send cmd.exe input");
        drop(input);
        let output = child.wait_with_output().expect("read cmd.exe output");
        assert!(String::from_utf8_lossy(&output.stdout).contains("termigo-pipe"));
    }
}
