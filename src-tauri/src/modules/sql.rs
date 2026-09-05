//! SQL Explorer - run a query against a user-configured database CLI.
//!
//! Execution is delegated to an installed CLI (`sqlite3`, `duckdb`, `psql`,
//! `mysql`, ...) chosen by the user in Settings. The query is piped over stdin,
//! so it never appears in the process argv and cannot be shell-escaped. The
//! connection string is passed as a single argument (never through a shell), so
//! option-injection and control-byte tricks are rejected up front.

use std::io::Write;
use std::process::{Command, Stdio};

const MAX_OUTPUT_CHARS: usize = 24_000;
const MAX_QUERY_CHARS: usize = 200_000;

/// Engines we know how to drive. Kept small so a typo cannot reach a shell.
fn is_engine(engine: &str) -> bool {
    matches!(
        engine,
        "sqlite3" | "sqlite" | "duckdb" | "psql" | "postgres" | "mysql" | "mariadb"
    )
}

/// Reject control bytes so a crafted connection string or query cannot smuggle
/// terminal escape sequences or an extra command into the child process.
fn has_control_bytes(s: &str) -> bool {
    s.bytes()
        .any(|b| b == 0 || b == 0x1b || (b < 0x20 && b != b'\n' && b != b'\r'))
}

/// Resolve a command name against PATH before spawning it.
fn resolve_program(command: &str) -> std::ffi::OsString {
    if command.contains('/') || command.contains('\\') {
        return command.into();
    }
    which::which(command)
        .map(std::path::PathBuf::into_os_string)
        .unwrap_or_else(|_| command.into())
}

/// Build the argv (engine + connection + any flags) without a shell. For psql
/// we read the query from stdin via `-f -`; sqlite/duckdb/mysql read stdin by
/// default. The connection is a single argv entry, never split.
pub fn build_sql_argv(engine: &str, connection: &str) -> Result<Vec<String>, String> {
    if !is_engine(engine) {
        return Err(format!(
            "unsupported engine \"{engine}\"; expected sqlite3, duckdb, psql, postgres, mysql or mariadb"
        ));
    }
    if connection.trim().is_empty() {
        return Err("connection string cannot be empty".into());
    }
    // A leading "-" would be swallowed as a flag, not a connection; refuse it.
    if connection.starts_with('-') {
        return Err("connection string cannot start with '-'".into());
    }
    if has_control_bytes(connection) {
        return Err("connection string contains control bytes".into());
    }

    // Normalize engine alias to the installed CLI binary name.
    let binary = match engine {
        "sqlite" | "sqlite3" => "sqlite3",
        "postgres" | "psql" => "psql",
        "duckdb" => "duckdb",
        "mysql" => "mysql",
        "mariadb" => "mariadb",
        _ => return Err(format!("unsupported engine \"{engine}\"")),
    };

    let mut argv = vec![binary.to_string()];

    if matches!(binary, "mysql" | "mariadb")
        && (connection.starts_with("mysql://") || connection.starts_with("mariadb://"))
    {
        argv.push(format!("--uri={connection}"));
    } else {
        argv.push(connection.to_string());
    }

    if binary == "psql" {
        // psql reads the script from stdin when given `-f -`.
        argv.push("-f".into());
        argv.push("-".into());
    }
    Ok(argv)
}

/// Validate a query before it is sent to the database engine.
pub fn validate_query(query: &str) -> Result<(), String> {
    if query.trim().is_empty() {
        return Err("query cannot be empty".into());
    }
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(format!(
            "query too long (over {MAX_QUERY_CHARS} characters)"
        ));
    }
    if has_control_bytes(query) {
        return Err("query contains control bytes".into());
    }
    Ok(())
}

/// Run `sql` against `connection` using `engine`, returning stdout (and any
/// stderr). The query is written to the child's stdin and the output is capped.
pub fn run_query(engine: &str, connection: &str, query: &str) -> Result<String, String> {
    let argv = build_sql_argv(engine, connection)?;
    validate_query(query)?;

    let mut cmd = Command::new(resolve_program(&argv[0]));
    cmd.args(&argv[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn {engine}: {e}"))?;
    {
        let stdin = child.stdin.as_mut().ok_or("failed to open child stdin")?;
        stdin
            .write_all(query.as_bytes())
            .map_err(|e| format!("write query to {engine}: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("wait for {engine}: {e}"))?;

    let stdout_text = String::from_utf8_lossy(&output.stdout);
    let stderr_text = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        let err_msg = if !stderr_text.trim().is_empty() {
            stderr_text.trim()
        } else if !stdout_text.trim().is_empty() {
            stdout_text.trim()
        } else {
            "query execution failed"
        };
        return Err(format!("{engine} error: {err_msg}"));
    }

    let mut text = String::with_capacity(MAX_OUTPUT_CHARS.saturating_mul(2));
    text.push_str(&stdout_text);
    if !stderr_text.is_empty() {
        text.push_str("\n[stderr]\n");
        text.push_str(&stderr_text);
    }
    if text.chars().count() > MAX_OUTPUT_CHARS {
        let head: String = text.chars().take(MAX_OUTPUT_CHARS).collect();
        text = format!("{head}\n…[output truncated]…");
    }
    Ok(text)
}

// Async so a slow query never blocks the UI thread: a sync command runs on the
// main thread, and `run_query` shells out to the DB client and waits for it.
#[tauri::command]
pub async fn sql_run(engine: String, connection: String, query: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_query(&engine, &connection, &query))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_sqlite_argv_without_a_shell() {
        let argv = build_sql_argv("sqlite3", "/tmp/app.db").unwrap();
        assert_eq!(argv, vec!["sqlite3", "/tmp/app.db"]);
    }

    #[test]
    fn psql_reads_query_from_stdin() {
        let argv = build_sql_argv("psql", "postgres://u@h/db").unwrap();
        assert_eq!(argv, vec!["psql", "postgres://u@h/db", "-f", "-"]);
    }

    #[test]
    fn normalizes_engine_aliases() {
        let sqlite = build_sql_argv("sqlite", "/tmp/app.db").unwrap();
        assert_eq!(sqlite, vec!["sqlite3", "/tmp/app.db"]);

        let postgres = build_sql_argv("postgres", "postgres://u@h/db").unwrap();
        assert_eq!(postgres, vec!["psql", "postgres://u@h/db", "-f", "-"]);
    }

    #[test]
    fn mysql_uri_uses_uri_flag() {
        let argv = build_sql_argv("mysql", "mysql://root:pass@localhost:3306/db").unwrap();
        assert_eq!(argv, vec!["mysql", "--uri=mysql://root:pass@localhost:3306/db"]);

        let plain = build_sql_argv("mysql", "testdb").unwrap();
        assert_eq!(plain, vec!["mysql", "testdb"]);
    }

    #[test]
    fn refuses_unknown_engine_and_option_injection() {
        assert!(build_sql_argv("rm", "/").is_err());
        assert!(build_sql_argv("sqlite3", "-injection").is_err());
        assert!(build_sql_argv("sqlite3", "\x1b[2J").is_err());
    }

    #[test]
    fn validates_query_bounds() {
        assert!(validate_query("SELECT 1;").is_ok());
        assert!(validate_query("").is_err());
        assert!(validate_query("SELECT 1;\x00").is_err());
        assert!(validate_query(&"x".repeat(MAX_QUERY_CHARS + 1)).is_err());
    }
}
