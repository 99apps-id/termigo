use std::path::{Path, PathBuf};

use tauri::Manager;
use termigo_control_protocol::{
    AgentRunParams, OpenParams, PentestReportParams, PentestRunParams, QueryParams,
    RunCommandParams,
};

use crate::modules::{fs, workspace};

pub fn valid_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
}

pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

/// Bound and clean a pentest-run request before it reaches the UI.
pub fn validate_pentest_run_params(
    params: PentestRunParams,
) -> Result<PentestRunParams, (&'static str, String)> {
    const MAX_TARGET_LEN: usize = 2048;
    const MAX_CATEGORY_LEN: usize = 64;
    let target = params.target.trim().to_string();
    if target.is_empty() {
        return Err(("invalid_params", "pentest target is required".to_string()));
    }
    if target.len() > MAX_TARGET_LEN {
        return Err(("invalid_params", "pentest target is too long".to_string()));
    }
    let category = params.category.trim().to_string();
    if category.len() > MAX_CATEGORY_LEN {
        return Err(("invalid_params", "pentest category is too long".to_string()));
    }
    Ok(PentestRunParams { target, category })
}

/// Bound and clean a pentest-report request.
pub fn validate_pentest_report_params(
    params: PentestReportParams,
) -> Result<PentestReportParams, (&'static str, String)> {
    const MAX_TARGET_LEN: usize = 2048;
    let target = params.target.trim().to_string();
    if target.len() > MAX_TARGET_LEN {
        return Err(("invalid_params", "pentest target is too long".to_string()));
    }
    Ok(PentestReportParams { target })
}

/// Bound and clean an agent-run request.
pub fn validate_agent_run_params(
    params: AgentRunParams,
) -> Result<AgentRunParams, (&'static str, String)> {
    const MAX_PROMPT_LEN: usize = 32 * 1024;
    let prompt = params.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(("invalid_params", "agent prompt is required".to_string()));
    }
    if prompt.len() > MAX_PROMPT_LEN {
        return Err(("invalid_params", "agent prompt is too long".to_string()));
    }
    Ok(AgentRunParams { prompt })
}

/// Bound and clean a query request.
pub fn validate_query_params(params: QueryParams) -> Result<QueryParams, (&'static str, String)> {
    const MAX_PROMPT_LEN: usize = 32 * 1024;
    let prompt = params.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(("invalid_params", "query prompt is required".to_string()));
    }
    if prompt.len() > MAX_PROMPT_LEN {
        return Err(("invalid_params", "query prompt is too long".to_string()));
    }
    Ok(QueryParams { prompt })
}

/// Bound a run-command request.
pub fn validate_run_command_params(
    params: RunCommandParams,
) -> Result<RunCommandParams, (&'static str, String)> {
    const MAX_COMMAND_LEN: usize = 256;
    let command = params.command.trim().to_string();
    if command.is_empty() {
        return Err(("invalid_params", "command id is required".to_string()));
    }
    if command.len() > MAX_COMMAND_LEN {
        return Err(("invalid_params", "command id is too long".to_string()));
    }
    Ok(RunCommandParams { command })
}

pub fn validate_open_params(
    params: OpenParams,
    app: &tauri::AppHandle,
) -> Result<OpenParams, (&'static str, String)> {
    let (mut params, canonical) = normalize_open_target(params)?;
    let registry = app
        .try_state::<workspace::WorkspaceRegistry>()
        .ok_or_else(|| {
            (
                "internal_error",
                "workspace registry is unavailable".to_string(),
            )
        })?;
    require_authorized_open_target(&registry, &canonical)?;
    params.path = fs::to_canon(canonical);
    Ok(params)
}

pub fn require_authorized_open_target(
    registry: &workspace::WorkspaceRegistry,
    canonical: &Path,
) -> Result<(), (&'static str, String)> {
    if !registry.is_authorized(canonical) {
        return Err((
            "path_not_accessible",
            format!(
                "path is outside the authorized workspace: {}",
                canonical.display()
            ),
        ));
    }
    Ok(())
}

pub fn normalize_open_target(
    params: OpenParams,
) -> Result<(OpenParams, PathBuf), (&'static str, String)> {
    if params.path.is_empty() || params.path.len() > 16 * 1024 {
        return Err((
            "invalid_params",
            "path must contain 1-16384 bytes".to_string(),
        ));
    }
    if params.line == Some(0) || params.column == Some(0) {
        return Err((
            "invalid_params",
            "line and column are one-based and must be greater than zero".to_string(),
        ));
    }
    let canonical = std::fs::canonicalize(&params.path)
        .map_err(|error| ("path_not_found", format!("cannot open path: {error}")))?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| ("path_not_found", format!("cannot stat path: {error}")))?;
    if !metadata.is_file() {
        return Err((
            "not_a_file",
            format!("path is not a regular file: {}", canonical.display()),
        ));
    }
    Ok((params, canonical))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_params(path: String) -> OpenParams {
        OpenParams {
            path,
            line: None,
            column: None,
            focus: true,
        }
    }

    #[test]
    fn request_ids_are_bounded_and_log_safe() {
        assert!(valid_request_id("1234-55_test.ok"));
        assert!(!valid_request_id(""));
        assert!(!valid_request_id("has a space"));
        assert!(!valid_request_id("line\nbreak"));
        assert!(!valid_request_id(&"x".repeat(129)));
    }

    #[test]
    fn token_comparison_checks_every_byte() {
        assert!(constant_time_eq(b"abcdef", b"abcdef"));
        assert!(!constant_time_eq(b"abcdef", b"abcdeg"));
        assert!(!constant_time_eq(b"short", b"longer"));
    }

    #[test]
    fn open_target_validation_rejects_invalid_bounds_and_directories() {
        let error = normalize_open_target(open_params(String::new())).expect_err("reject empty");
        assert_eq!(error.0, "invalid_params");

        let error = normalize_open_target(open_params("x".repeat(16 * 1024 + 1)))
            .expect_err("reject oversized path");
        assert_eq!(error.0, "invalid_params");

        let mut params = open_params("unused".into());
        params.line = Some(0);
        let error = normalize_open_target(params).expect_err("reject zero line");
        assert_eq!(error.0, "invalid_params");

        let temp = tempfile::tempdir().expect("temp directory");
        let error = normalize_open_target(open_params(temp.path().to_string_lossy().into_owned()))
            .expect_err("reject directory");
        assert_eq!(error.0, "not_a_file");
    }

    #[test]
    fn pentest_report_validation_trims_and_bounds_the_target() {
        let trimmed = validate_pentest_report_params(PentestReportParams {
            target: "  example.com  ".into(),
        })
        .expect("empty target is allowed and trimmed");
        assert_eq!(trimmed.target, "example.com");

        let empty = validate_pentest_report_params(PentestReportParams {
            target: String::new(),
        })
        .expect("empty target (last run) is allowed");
        assert_eq!(empty.target, "");

        let error = validate_pentest_report_params(PentestReportParams {
            target: "x".repeat(2049),
        })
        .expect_err("reject oversized target");
        assert_eq!(error.0, "invalid_params");
    }

    #[test]
    fn agent_run_validation_trims_and_bounds_the_prompt() {
        let trimmed = validate_agent_run_params(AgentRunParams {
            prompt: "  fix the build  ".into(),
        })
        .expect("prompt is trimmed");
        assert_eq!(trimmed.prompt, "fix the build");

        let error = validate_agent_run_params(AgentRunParams {
            prompt: String::new(),
        })
        .expect_err("reject empty prompt");
        assert_eq!(error.0, "invalid_params");

        let error = validate_agent_run_params(AgentRunParams {
            prompt: " ".repeat(32 * 1024 + 1),
        })
        .expect_err("reject oversized prompt");
        assert_eq!(error.0, "invalid_params");
    }

    #[test]
    fn query_validation_trims_and_bounds_the_prompt() {
        let trimmed = validate_query_params(QueryParams {
            prompt: "  what changed?  ".into(),
        })
        .expect("prompt is trimmed");
        assert_eq!(trimmed.prompt, "what changed?");

        let error = validate_query_params(QueryParams {
            prompt: String::new(),
        })
        .expect_err("reject empty prompt");
        assert_eq!(error.0, "invalid_params");

        let error = validate_query_params(QueryParams {
            prompt: "x".repeat(32 * 1024 + 1),
        })
        .expect_err("reject oversized prompt");
        assert_eq!(error.0, "invalid_params");
    }

    #[test]
    fn run_command_validation_trims_and_bounds_the_id() {
        let trimmed = validate_run_command_params(RunCommandParams {
            command: "  settings.open  ".into(),
        })
        .expect("command id is trimmed");
        assert_eq!(trimmed.command, "settings.open");

        let error = validate_run_command_params(RunCommandParams {
            command: String::new(),
        })
        .expect_err("reject empty id");
        assert_eq!(error.0, "invalid_params");

        let error = validate_run_command_params(RunCommandParams {
            command: "x".repeat(257),
        })
        .expect_err("reject oversized id");
        assert_eq!(error.0, "invalid_params");
    }

    #[test]
    fn open_authorization_is_read_only() {
        let authorized = tempfile::tempdir().expect("authorized directory");
        let outside = tempfile::tempdir().expect("outside directory");
        let outside_file = outside.path().join("outside.rs");
        std::fs::write(&outside_file, b"fn main() {}\n").expect("write outside file");
        let outside_file = std::fs::canonicalize(outside_file).expect("canonical outside file");
        let registry = workspace::WorkspaceRegistry::default();
        registry
            .authorize(authorized.path())
            .expect("authorize workspace");

        let error = require_authorized_open_target(&registry, &outside_file)
            .expect_err("reject outside file");

        assert_eq!(error.0, "path_not_accessible");
        assert!(!registry.is_authorized(&outside_file));
    }
}
