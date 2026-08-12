use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use serde::Serialize;

const MAX_WORKSPACE_ENTRIES: usize = 2_500;
const MAX_TERMINAL_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_TERMINAL_INPUT_BYTES: usize = 16 * 1024;

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
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/Q", "/K"]);
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

fn default_shell_name() -> &'static str {
    #[cfg(windows)]
    {
        "Command Prompt"
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

fn main() {
    tauri::Builder::default()
        .manage(WorkspaceState::default())
        .manage(TerminalState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            workspace_open,
            workspace_refresh,
            workspace_read_text_file,
            workspace_save_text_file,
            terminal_start,
            terminal_write,
            terminal_read,
            terminal_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Termigo");
}

#[cfg(test)]
mod tests {
    use super::{ignored_name, language_for_path, TerminalOutputBuffer};
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
    fn terminal_output_replays_only_the_new_chunks() {
        let mut output = TerminalOutputBuffer::default();
        output.append("first".to_owned());
        let first_read = output.read_since(0);
        assert_eq!(first_read.contents, "first");
        output.append(" second".to_owned());
        let next_read = output.read_since(first_read.cursor);
        assert_eq!(next_read.contents, " second");
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
