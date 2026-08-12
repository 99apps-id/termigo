use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::Serialize;

const MAX_WORKSPACE_ENTRIES: usize = 2_500;

#[derive(Default)]
struct WorkspaceState(Mutex<Option<PathBuf>>);

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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            workspace_open,
            workspace_refresh,
            workspace_read_text_file,
            workspace_save_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Termigo");
}

#[cfg(test)]
mod tests {
    use super::{ignored_name, language_for_path};
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
}
