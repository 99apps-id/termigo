//! Persisted line annotations for git diffs.
//!
//! Comments are stored per-repo at `<repo>/.git/termigo-diff-comments.json`.
//! The file is written atomically with a temp-file rename so a crash mid-write
//! cannot corrupt the existing annotations.
//!
//! All paths handed to this module must already be authorized by the caller.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::modules::git::errors::{GitError, Result};
use crate::modules::git::types::GitDiffComment;
use crate::modules::git::utils::{canonical_dir, ResolvedGitDirectory};
use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};

#[derive(Default)]
pub struct GitDiffCommentState;

fn comments_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".git").join("termigo-diff-comments.json")
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Serialize, Deserialize)]
struct GitDiffCommentsFile {
    comments: Vec<GitDiffComment>,
    updated_at: i64,
}

fn read_file(path: &Path) -> Result<Vec<GitDiffComment>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(path).map_err(GitError::Io)?;
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let batch: GitDiffCommentsFile = serde_json::from_slice(&bytes)
        .map_err(|e| GitError::command("read_diff_comments", e.to_string()))?;
    Ok(batch.comments)
}

fn write_file(path: &Path, comments: &[GitDiffComment]) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    let batch = GitDiffCommentsFile {
        comments: comments.to_vec(),
        updated_at: now_millis(),
    };
    let bytes = serde_json::to_vec_pretty(&batch)
        .map_err(|e| GitError::command("serialize_diff_comments", e.to_string()))?;
    fs::write(&tmp, bytes).map_err(GitError::Io)?;
    fs::rename(&tmp, path).map_err(GitError::Io)?;
    Ok(())
}

fn resolve_repo(
    registry: &WorkspaceRegistry,
    cwd: &str,
    workspace: &WorkspaceEnv,
) -> Result<ResolvedGitDirectory> {
    let cwd = canonical_dir(registry, cwd, workspace)?;
    if !registry.is_authorized(&cwd.local_path) {
        return Err(GitError::PathOutsideWorkspace(cwd.local_path));
    }
    Ok(cwd)
}

pub fn list_comments(
    registry: &WorkspaceRegistry,
    cwd: &str,
    workspace: &WorkspaceEnv,
) -> Result<Vec<GitDiffComment>> {
    let repo = resolve_repo(registry, cwd, workspace)?;
    let path = comments_path(Path::new(&repo.git_path));
    read_file(&path)
}

pub fn add_comment(
    registry: &WorkspaceRegistry,
    cwd: &str,
    workspace: &WorkspaceEnv,
    comment: GitDiffComment,
) -> Result<GitDiffComment> {
    let repo = resolve_repo(registry, cwd, workspace)?;
    let path = comments_path(Path::new(&repo.git_path));
    let mut comments = read_file(&path)?;
    let normalized = normalize_comment(&comment);
    comments.retain(|c| c.id != normalized.id);
    comments.push(normalized.clone());
    write_file(&path, &comments)?;
    Ok(normalized)
}

pub fn update_comment(
    registry: &WorkspaceRegistry,
    cwd: &str,
    workspace: &WorkspaceEnv,
    id: &str,
    patch: serde_json::Value,
) -> Result<Option<GitDiffComment>> {
    let repo = resolve_repo(registry, cwd, workspace)?;
    let path = comments_path(Path::new(&repo.git_path));
    let mut comments = read_file(&path)?;
    let mut updated = false;
    for c in &mut comments {
        if c.id == id {
            if let Some(body) = patch.get("body").and_then(|v| v.as_str()) {
                c.body = body.trim().to_string();
                c.updated_at = Some(now_millis());
                updated = true;
            }
            if let Some(selected_text) = patch.get("selectedText").and_then(|v| v.as_str()) {
                c.selected_text = Some(selected_text.trim().to_string());
                updated = true;
            }
        }
    }
    if updated {
        write_file(&path, &comments)?;
        Ok(comments.into_iter().find(|c| c.id == id))
    } else {
        Ok(None)
    }
}

pub fn remove_comment(
    registry: &WorkspaceRegistry,
    cwd: &str,
    workspace: &WorkspaceEnv,
    id: &str,
) -> Result<bool> {
    let repo = resolve_repo(registry, cwd, workspace)?;
    let path = comments_path(Path::new(&repo.git_path));
    let mut comments = read_file(&path)?;
    let len = comments.len();
    comments.retain(|c| c.id != id);
    if comments.len() != len {
        write_file(&path, &comments)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn list_for_file(
    registry: &WorkspaceRegistry,
    cwd: &str,
    workspace: &WorkspaceEnv,
    file_path: &str,
) -> Result<Vec<GitDiffComment>> {
    let all = list_comments(registry, cwd, workspace)?;
    let normalized = file_path.replace('\\', "/");
    Ok(all
        .into_iter()
        .filter(|c| c.file_path == normalized)
        .collect())
}

fn normalize_comment(comment: &GitDiffComment) -> GitDiffComment {
    let mut c = comment.clone();
    c.file_path = c.file_path.replace('\\', "/");
    if c.side != "old" {
        c.side = "new".to_string();
    }
    c.body = c.body.trim().to_string();
    if let Some(st) = &c.selected_text {
        c.selected_text = Some(st.trim().to_string());
    }
    c
}
