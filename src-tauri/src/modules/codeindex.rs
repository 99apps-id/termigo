//! Code index storage and search, backed by SQLite FTS5.
//!
//! The webview used to keep the whole index in memory (a hand-rolled BM25
//! over every chunk, scanned per query) and persist it as a multi-megabyte
//! JSON copy of the corpus inside the user's repository. FTS5 keeps the
//! index in one database under the app data directory, matches through its
//! own inverted index, and ranks with the built-in `bm25()`.
//!
//! The split of labour is deliberate. The webview still owns chunking and
//! the code-aware tokenizer (camelCase and snake_case splitting, stop
//! words): FTS5's unicode61 tokenizer cannot split identifiers, so the
//! indexed `tokens` column carries the pre-tokenized stream and queries
//! match against it. Rust owns storage, freshness fingerprints, matching,
//! and ranking.
//!
//! The database is a cache: it can always be rebuilt from the tree, so it
//! runs with WAL and relaxed sync, and a failure to open it degrades to an
//! error the caller can retry from, never to a half-written index (every
//! replace is one transaction).

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

use crate::modules::workspace::WorkspaceRegistry;

#[derive(Default)]
pub struct CodeIndexState(pub Mutex<Option<Connection>>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStamp {
    pub path: String,
    pub mtime: i64,
    pub size: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkInput {
    pub start_line: i64,
    pub end_line: i64,
    pub scope_header: Option<String>,
    pub text: String,
    /// The chunk's token stream, space-joined, from the webview tokenizer.
    pub tokens: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInput {
    pub path: String,
    pub mtime: i64,
    pub size: i64,
    /// The file path's token stream, space-joined. Indexed separately with a
    /// high bm25 column weight, which is how a query term naming the file
    /// outranks a term that merely appears in it.
    pub path_tokens: String,
    pub chunks: Vec<ChunkInput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub files: i64,
    pub chunks: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Freshness {
    pub fresh: bool,
    pub files: i64,
    pub chunks: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub start_line: i64,
    pub end_line: i64,
    pub scope_header: Option<String>,
    pub text: String,
    pub score: f64,
}

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("code index: no app data dir: {e}"))?;
    Ok(dir.join("code-index.db"))
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         CREATE TABLE IF NOT EXISTS code_files (
             root  TEXT NOT NULL,
             path  TEXT NOT NULL,
             mtime INTEGER NOT NULL,
             size  INTEGER NOT NULL,
             PRIMARY KEY (root, path)
         );
         CREATE VIRTUAL TABLE IF NOT EXISTS code_chunks USING fts5(
             root UNINDEXED,
             path UNINDEXED,
             start_line UNINDEXED,
             end_line UNINDEXED,
             scope_header UNINDEXED,
             text UNINDEXED,
             tokens,
             path_tokens
         );",
    )
    .map_err(|e| format!("code index: schema init failed: {e}"))
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let path = db_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("code index: cannot create {}: {e}", parent.display()))?;
    }
    let conn = Connection::open(&path)
        .map_err(|e| format!("code index: cannot open {}: {e}", path.display()))?;
    init_schema(&conn)?;
    Ok(conn)
}

fn with_db<T>(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, CodeIndexState>,
    f: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "code index: state lock poisoned".to_string())?;
    if guard.is_none() {
        *guard = Some(open_db(app)?);
    }
    let conn = guard.as_mut().expect("connection just opened");
    f(conn)
}

fn stats_for(conn: &Connection, root: &str) -> Result<IndexStats, String> {
    let files: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM code_files WHERE root = ?1",
            params![root],
            |r| r.get(0),
        )
        .map_err(|e| format!("code index: stats failed: {e}"))?;
    let chunks: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM code_chunks WHERE root = ?1",
            params![root],
            |r| r.get(0),
        )
        .map_err(|e| format!("code index: stats failed: {e}"))?;
    Ok(IndexStats { files, chunks })
}

fn replace_root(
    conn: &mut Connection,
    root: &str,
    files: &[FileInput],
) -> Result<IndexStats, String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("code index: cannot begin replace: {e}"))?;
    tx.execute("DELETE FROM code_chunks WHERE root = ?1", params![root])
        .map_err(|e| format!("code index: clear chunks failed: {e}"))?;
    tx.execute("DELETE FROM code_files WHERE root = ?1", params![root])
        .map_err(|e| format!("code index: clear files failed: {e}"))?;
    {
        let mut file_stmt = tx
            .prepare("INSERT INTO code_files (root, path, mtime, size) VALUES (?1, ?2, ?3, ?4)")
            .map_err(|e| format!("code index: prepare failed: {e}"))?;
        let mut chunk_stmt = tx
            .prepare(
                "INSERT INTO code_chunks (root, path, start_line, end_line, scope_header, text, tokens, path_tokens)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(|e| format!("code index: prepare failed: {e}"))?;
        for file in files {
            file_stmt
                .execute(params![root, file.path, file.mtime, file.size])
                .map_err(|e| format!("code index: file insert failed: {e}"))?;
            for chunk in &file.chunks {
                chunk_stmt
                    .execute(params![
                        root,
                        file.path,
                        chunk.start_line,
                        chunk.end_line,
                        chunk.scope_header,
                        chunk.text,
                        chunk.tokens,
                        file.path_tokens,
                    ])
                    .map_err(|e| format!("code index: chunk insert failed: {e}"))?;
            }
        }
    }
    tx.commit()
        .map_err(|e| format!("code index: commit failed: {e}"))?;
    stats_for(conn, root)
}

fn check_fresh(conn: &Connection, root: &str, files: &[FileStamp]) -> Result<Freshness, String> {
    let mut stmt = conn
        .prepare("SELECT path, mtime, size FROM code_files WHERE root = ?1")
        .map_err(|e| format!("code index: freshness prepare failed: {e}"))?;
    let stored = stmt
        .query_map(params![root], |r| {
            Ok((
                r.get::<_, String>(0)?,
                (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?),
            ))
        })
        .map_err(|e| format!("code index: freshness query failed: {e}"))?
        .collect::<Result<HashMap<String, (i64, i64)>, _>>()
        .map_err(|e| format!("code index: freshness read failed: {e}"))?;
    let stats = stats_for(conn, root)?;
    let fresh = stats.chunks > 0
        && stored.len() == files.len()
        && files
            .iter()
            .all(|f| stored.get(&f.path) == Some(&(f.mtime, f.size)));
    Ok(Freshness {
        fresh,
        files: stats.files,
        chunks: stats.chunks,
    })
}

/// One candidate pulled from FTS, before the exact-match bonuses the old
/// engine applied on top of BM25 are folded in.
struct Candidate {
    path: String,
    start_line: i64,
    end_line: i64,
    scope_header: Option<String>,
    text: String,
    score: f64,
}

fn search(
    conn: &Connection,
    root: &str,
    query_tokens: &[String],
    query_text: &str,
    max_results: usize,
    filter_path: Option<&str>,
) -> Result<Vec<SearchHit>, String> {
    // Terms come from the webview tokenizer, whose alphabet is [a-z0-9_];
    // strip anything else anyway so a crafted term cannot break out of the
    // quoted MATCH phrase.
    let terms: Vec<String> = query_tokens
        .iter()
        .map(|t| {
            t.chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect::<String>()
        })
        .filter(|t| !t.is_empty())
        .collect();
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let match_expr = format!(
        "{{tokens path_tokens}} : ({})",
        terms
            .iter()
            .map(|t| format!("\"{t}\""))
            .collect::<Vec<_>>()
            .join(" OR ")
    );
    let limit = max_results.clamp(1, 100);
    // Over-fetch, then re-rank with the exact-match bonuses and cut. The
    // bonuses are worth up to 6.5 points, so a merely-good bm25 row can
    // still earn its place in the final list.
    let fetch = (limit * 4).min(400);
    let mut stmt = conn
        .prepare(
            "SELECT path, start_line, end_line, scope_header, text,
                    bm25(code_chunks, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 5.0)
             FROM code_chunks
             WHERE root = ?1 AND code_chunks MATCH ?2
               AND (?3 IS NULL OR path LIKE '%' || ?3 || '%')
             ORDER BY bm25(code_chunks, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 5.0)
             LIMIT ?4",
        )
        .map_err(|e| format!("code index: search prepare failed: {e}"))?;
    let rows = stmt
        .query_map(params![root, match_expr, filter_path, fetch as i64], |r| {
            Ok(Candidate {
                path: r.get(0)?,
                start_line: r.get(1)?,
                end_line: r.get(2)?,
                scope_header: r.get(3)?,
                text: r.get(4)?,
                // bm25() returns lower-is-better (negative) values.
                score: -r.get::<_, f64>(5)?,
            })
        })
        .map_err(|e| format!("code index: search failed: {e}"))?;
    let mut candidates: Vec<Candidate> = Vec::new();
    for row in rows {
        candidates.push(row.map_err(|e| format!("code index: search read failed: {e}"))?);
    }

    let query_lower = query_text.trim().to_lowercase();
    let mut hits: Vec<SearchHit> = candidates
        .into_iter()
        .map(|c| {
            let mut score = c.score;
            if query_lower.len() > 2 {
                if c.text.to_lowercase().contains(&query_lower) {
                    score += 2.5;
                }
                if c.path.to_lowercase().contains(&query_lower) {
                    score += 4.0;
                }
            }
            SearchHit {
                path: c.path,
                start_line: c.start_line,
                end_line: c.end_line,
                scope_header: c.scope_header,
                text: c.text,
                score: (score * 1000.0).round() / 1000.0,
            }
        })
        .collect();
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits.truncate(limit);
    Ok(hits)
}

#[tauri::command]
pub fn codeindex_replace_root(
    app: tauri::AppHandle,
    state: tauri::State<'_, CodeIndexState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    root: String,
    files: Vec<FileInput>,
) -> Result<IndexStats, String> {
    crate::modules::workspace::require_authorized(&registry, std::path::Path::new(&root))?;
    with_db(&app, &state, |conn| replace_root(conn, &root, &files))
}

#[tauri::command]
pub fn codeindex_check_fresh(
    app: tauri::AppHandle,
    state: tauri::State<'_, CodeIndexState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    root: String,
    files: Vec<FileStamp>,
) -> Result<Freshness, String> {
    crate::modules::workspace::require_authorized(&registry, std::path::Path::new(&root))?;
    with_db(&app, &state, |conn| check_fresh(conn, &root, &files))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn codeindex_search(
    app: tauri::AppHandle,
    state: tauri::State<'_, CodeIndexState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    root: String,
    query_tokens: Vec<String>,
    query_text: String,
    max_results: usize,
    filter_path: Option<String>,
) -> Result<Vec<SearchHit>, String> {
    crate::modules::workspace::require_authorized(&registry, std::path::Path::new(&root))?;
    with_db(&app, &state, |conn| {
        search(
            conn,
            &root,
            &query_tokens,
            &query_text,
            max_results,
            filter_path.as_deref(),
        )
    })
}

#[tauri::command]
pub fn codeindex_stats(
    app: tauri::AppHandle,
    state: tauri::State<'_, CodeIndexState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    root: String,
) -> Result<IndexStats, String> {
    crate::modules::workspace::require_authorized(&registry, std::path::Path::new(&root))?;
    with_db(&app, &state, |conn| stats_for(conn, &root))
}

#[tauri::command]
pub fn codeindex_clear(
    app: tauri::AppHandle,
    state: tauri::State<'_, CodeIndexState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    root: String,
) -> Result<(), String> {
    crate::modules::workspace::require_authorized(&registry, std::path::Path::new(&root))?;
    with_db(&app, &state, |conn| {
        conn.execute("DELETE FROM code_chunks WHERE root = ?1", params![root])
            .map_err(|e| format!("code index: clear failed: {e}"))?;
        conn.execute("DELETE FROM code_files WHERE root = ?1", params![root])
            .map_err(|e| format!("code index: clear failed: {e}"))?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        init_schema(&conn).expect("schema");
        conn
    }

    fn file(path: &str, chunks: Vec<(&str, &str)>) -> FileInput {
        FileInput {
            path: path.to_string(),
            mtime: 10,
            size: 100,
            path_tokens: path.to_lowercase().replace(['/', '.', '-'], " "),
            chunks: chunks
                .into_iter()
                .enumerate()
                .map(|(i, (text, tokens))| ChunkInput {
                    start_line: (i * 80 + 1) as i64,
                    end_line: ((i + 1) * 80) as i64,
                    scope_header: None,
                    text: text.to_string(),
                    tokens: tokens.to_string(),
                })
                .collect(),
        }
    }

    #[test]
    fn fts5_is_compiled_in_and_searches() {
        let mut conn = memory_db();
        let stats = replace_root(
            &mut conn,
            "/repo",
            &[file(
                "src/auth/session.ts",
                vec![("fn validate token", "validate token session")],
            )],
        )
        .expect("replace");
        assert_eq!(stats.files, 1);
        assert_eq!(stats.chunks, 1);
        let hits = search(
            &conn,
            "/repo",
            &["validate".to_string()],
            "validate",
            10,
            None,
        )
        .expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "src/auth/session.ts");
    }

    #[test]
    fn path_tokens_outrank_body_mentions() {
        let mut conn = memory_db();
        replace_root(
            &mut conn,
            "/repo",
            &[
                file(
                    "src/auth/token.ts",
                    vec![("export const x = 1", "export const x")],
                ),
                file(
                    "src/other/thing.ts",
                    vec![(
                        "token token token everywhere",
                        "token token token everywhere",
                    )],
                ),
            ],
        )
        .expect("replace");
        let hits =
            search(&conn, "/repo", &["token".to_string()], "token", 10, None).expect("search");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "src/auth/token.ts");
    }

    #[test]
    fn freshness_tracks_fingerprints() {
        let mut conn = memory_db();
        replace_root(
            &mut conn,
            "/repo",
            &[file("src/a.ts", vec![("alpha", "alpha")])],
        )
        .expect("replace");
        let stamp = |mtime: i64, size: i64| FileStamp {
            path: "src/a.ts".to_string(),
            mtime,
            size,
        };
        assert!(
            check_fresh(&conn, "/repo", &[stamp(10, 100)])
                .expect("fresh")
                .fresh
        );
        assert!(
            !check_fresh(&conn, "/repo", &[stamp(11, 100)])
                .expect("stale mtime")
                .fresh
        );
        assert!(
            !check_fresh(&conn, "/repo", &[])
                .expect("missing file")
                .fresh
        );
    }

    #[test]
    fn roots_are_isolated_and_clearable() {
        let mut conn = memory_db();
        replace_root(
            &mut conn,
            "/a",
            &[file("src/a.ts", vec![("alpha", "alpha")])],
        )
        .expect("replace a");
        replace_root(&mut conn, "/b", &[file("src/b.ts", vec![("beta", "beta")])])
            .expect("replace b");
        assert_eq!(
            search(&conn, "/a", &["beta".to_string()], "beta", 10, None)
                .expect("search a")
                .len(),
            0
        );
        codeindex_clear_conn(&conn, "/a");
        assert_eq!(stats_for(&conn, "/a").expect("stats").chunks, 0);
        assert_eq!(stats_for(&conn, "/b").expect("stats").chunks, 1);
    }

    fn codeindex_clear_conn(conn: &Connection, root: &str) {
        conn.execute("DELETE FROM code_chunks WHERE root = ?1", params![root])
            .unwrap();
        conn.execute("DELETE FROM code_files WHERE root = ?1", params![root])
            .unwrap();
    }
}
