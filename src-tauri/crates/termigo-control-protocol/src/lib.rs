use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;
pub const METHOD_PING: &str = "ping";
pub const METHOD_CAPABILITIES: &str = "capabilities";
pub const METHOD_IDENTIFY: &str = "identify";
pub const METHOD_OPEN: &str = "open";
pub const METHOD_FOCUS: &str = "focus";
pub const METHOD_STATUS: &str = "status";
pub const METHOD_PENTEST_RUN: &str = "pentest-run";
pub const METHOD_PENTEST_STATUS: &str = "pentest-status";
pub const METHOD_PENTEST_REPORT: &str = "pentest-report";
pub const METHOD_AGENT_RUN: &str = "run";
pub const METHOD_QUERY: &str = "query";
pub const METHOD_RUN_COMMAND: &str = "run-command";
pub const METHOD_MODELS_LIST: &str = "models-list";
pub const METHOD_CONFIG_GET: &str = "config-get";
pub const METHOD_CONFIG_SET: &str = "config-set";
pub const METHOD_SECRET_SET: &str = "secret-set";
pub const SERVER_RESPONSE_ID: &str = "server";
pub const METHODS: &[&str] = &[
    METHOD_PING,
    METHOD_CAPABILITIES,
    METHOD_IDENTIFY,
    METHOD_OPEN,
    METHOD_FOCUS,
    METHOD_STATUS,
    METHOD_PENTEST_RUN,
    METHOD_PENTEST_STATUS,
    METHOD_PENTEST_REPORT,
    METHOD_AGENT_RUN,
    METHOD_QUERY,
    METHOD_RUN_COMMAND,
    METHOD_MODELS_LIST,
    METHOD_CONFIG_GET,
    METHOD_CONFIG_SET,
    METHOD_SECRET_SET,
];

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct CallerContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<u32>,
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
pub struct ControlRequest {
    pub protocol: u16,
    pub id: String,
    pub token: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub caller: CallerContext,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ControlError {
    pub code: String,
    pub message: String,
}

impl ControlError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ControlResponse {
    pub protocol: u16,
    pub id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ControlError>,
}

impl ControlResponse {
    pub fn success(id: impl Into<String>, result: Value) -> Self {
        Self {
            protocol: PROTOCOL_VERSION,
            id: id.into(),
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(
        id: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            protocol: PROTOCOL_VERSION,
            id: id.into(),
            ok: false,
            result: None,
            error: Some(ControlError::new(code, message)),
        }
    }
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
pub struct ControlDescriptor {
    pub protocol: u16,
    pub address: String,
    pub token: String,
    pub pid: u32,
    pub app_version: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct FrontendRequest {
    pub id: String,
    pub method: String,
    pub params: Value,
    pub caller: CallerContext,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct FrontendResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ControlError>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct OpenParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    #[serde(default = "default_focus")]
    pub focus: bool,
}

/// Focus the workspace on a tab. `query` is a substring of the tab's title,
/// path or label; the frontend picks the best match.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct FocusParams {
    pub query: String,
}

/// Kick off a pentest against an authorized target through the running app's
/// in-app agent. `target` is added to the app's pentest scope and `category`
/// selects the workflow (recon, web, network, …; empty defaults to recon). The
/// agent still surfaces every command for approval — this only starts the run.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PentestRunParams {
    pub target: String,
    #[serde(default)]
    pub category: String,
}

/// Ask the running app to generate and open the pentest report. `target` is
/// optional: empty means "the last pentest-run target", so `pentest-report`
/// works right after a `pentest-run` without retyping the target.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct PentestReportParams {
    #[serde(default)]
    pub target: String,
}

/// Start a plain agent task through the running app's in-app agent — the
/// generalization of `pentest-run` (no scope fencing, just a prompt). The run
/// still surfaces every tool call for approval.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct AgentRunParams {
    pub prompt: String,
}

/// Headless single-shot Q&A for scripting: ask a question, get the agent's
/// final text answer back. The prompt is answered read-only (the frontend
/// wraps it with a directive; mutating tools still need approval). Unlike
/// `run`, the caller waits for the answer, so the server uses a long timeout.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct QueryParams {
    pub prompt: String,
}

/// Invoke a command-palette command by id (e.g. `settings.open`) in the
/// running app. The frontend builds the same command list the palette shows
/// and calls the matching command's run action.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct RunCommandParams {
    pub command: String,
}
/// No parameters: the catalogue is whatever this build ships.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct ModelsListParams {}

/// Read the settings a terminal can meaningfully show. `key` selects one entry,
/// or is empty for the whole set.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct ConfigGetParams {
    #[serde(default)]
    pub key: String,
}

/// Change one setting from the terminal, so onboarding does not mean hand-editing
/// `termigo-settings.json`.
///
/// `value` is untyped because settings differ (a string model id, a bool, a list
/// of tool groups). WHICH keys may be written is decided by the frontend, which
/// owns the settings model and rejects anything outside a known set: an
/// unvalidated "set any key" would make this method a way to write arbitrary
/// values into the app's configuration file.
#[derive(Clone, Deserialize, PartialEq, Serialize)]
pub struct ConfigSetParams {
    pub key: String,
    #[serde(default)]
    pub value: Value,
}

/// Store an API key through the platform-correct path (the OS keychain on macOS
/// and Windows, a 0600 `secrets.json` in the app data dir on Linux), so the
/// terminal never has to know how a secret is persisted - and never writes one
/// itself.
#[derive(Clone, Deserialize, PartialEq, Serialize)]
pub struct SecretSetParams {
    /// The provider id whose key is being set.
    pub provider: String,
    /// The key itself. Never echoed back or logged.
    pub value: String,
}
fn default_focus() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_round_trips_without_caller_context() {
        let raw = json!({
            "protocol": PROTOCOL_VERSION,
            "id": "42",
            "token": "secret",
            "method": METHOD_PING,
            "params": {}
        });
        let request: ControlRequest = serde_json::from_value(raw).expect("deserialize request");
        assert_eq!(request.caller, CallerContext::default());
        assert_eq!(request.method, METHOD_PING);
    }

    #[test]
    fn response_shapes_are_unambiguous() {
        let success = ControlResponse::success("1", json!({ "pong": true }));
        assert!(success.ok);
        assert!(success.result.is_some());
        assert!(success.error.is_none());

        let failure = ControlResponse::failure("2", "invalid_request", "bad request");
        assert!(!failure.ok);
        assert!(failure.result.is_none());
        assert_eq!(failure.error.expect("error").code, "invalid_request");
    }

    #[test]
    fn open_defaults_to_focusing_the_target() {
        let params: OpenParams =
            serde_json::from_value(json!({ "path": "/tmp/a" })).expect("deserialize open params");
        assert!(params.focus);
    }

    #[test]
    fn focus_requires_a_query() {
        let params: FocusParams =
            serde_json::from_value(json!({ "query": "src/App.tsx" })).expect("deserialize focus");
        assert_eq!(params.query, "src/App.tsx");
        assert!(METHODS.contains(&METHOD_FOCUS));
        assert!(METHODS.contains(&METHOD_STATUS));
    }

    #[test]
    fn pentest_run_defaults_category_to_empty() {
        let params: PentestRunParams = serde_json::from_value(json!({ "target": "example.com" }))
            .expect("deserialize pentest");
        assert_eq!(params.target, "example.com");
        assert_eq!(params.category, "");
        assert!(METHODS.contains(&METHOD_PENTEST_RUN));
    }

    #[test]
    fn pentest_report_defaults_target_to_empty() {
        let params: PentestReportParams =
            serde_json::from_value(json!({})).expect("deserialize report params without a target");
        assert_eq!(params.target, "");

        let with_target: PentestReportParams = serde_json::from_value(json!({
            "target": "example.com"
        }))
        .expect("deserialize report params with a target");
        assert_eq!(with_target.target, "example.com");

        assert!(METHODS.contains(&METHOD_PENTEST_STATUS));
        assert!(METHODS.contains(&METHOD_PENTEST_REPORT));
    }

    #[test]
    fn terminal_config_methods_are_advertised() {
        // The CLI decides what it can offer from `capabilities`, so a method
        // missing here means the terminal silently cannot do it.
        for method in [
            METHOD_MODELS_LIST,
            METHOD_CONFIG_GET,
            METHOD_CONFIG_SET,
            METHOD_SECRET_SET,
        ] {
            assert!(METHODS.contains(&method), "{method} must be advertised");
        }
    }

    #[test]
    fn config_get_defaults_to_the_whole_set() {
        let params: ConfigGetParams = serde_json::from_value(json!({})).expect("deserialize");
        assert_eq!(params.key, "");

        let one: ConfigGetParams =
            serde_json::from_value(json!({ "key": "defaultModelId" })).expect("deserialize");
        assert_eq!(one.key, "defaultModelId");
    }

    #[test]
    fn config_set_carries_an_untyped_value() {
        // Settings differ in shape, so the value is not typed here; the
        // frontend validates which keys may be written at all.
        let text: ConfigSetParams = serde_json::from_value(json!({
            "key": "defaultModelId",
            "value": "deepseek-v4-pro"
        }))
        .expect("deserialize a string value");
        assert_eq!(text.key, "defaultModelId");
        assert_eq!(text.value, json!("deepseek-v4-pro"));

        let flag: ConfigSetParams = serde_json::from_value(json!({
            "key": "toolSearchEnabled",
            "value": true
        }))
        .expect("deserialize a bool value");
        assert_eq!(flag.value, json!(true));

        let list: ConfigSetParams = serde_json::from_value(json!({
            "key": "disabledToolGroups",
            "value": ["browser", "sql"]
        }))
        .expect("deserialize a list value");
        assert_eq!(list.value, json!(["browser", "sql"]));

        // A value is optional so `config-set` can clear a setting.
        let cleared: ConfigSetParams =
            serde_json::from_value(json!({ "key": "defaultModelId" })).expect("deserialize");
        assert!(cleared.value.is_null());
    }

    #[test]
    fn secret_set_names_the_provider_and_never_echoes_the_key() {
        let params: SecretSetParams = serde_json::from_value(json!({
            "provider": "deepseek",
            "value": "sk-test"
        }))
        .expect("deserialize secret-set");
        assert_eq!(params.provider, "deepseek");
        assert_eq!(params.value, "sk-test");

        // A Debug/Serialize round trip must not be the reason a key leaks into a
        // log, so the struct carries no Debug impl that prints the value.
        let encoded = serde_json::to_string(&params).expect("serialize");
        assert!(encoded.contains("sk-test"), "the request must carry the key");
        assert!(METHODS.contains(&METHOD_SECRET_SET));
    }

    #[test]
    fn agent_run_round_trips_the_prompt() {
        let params: AgentRunParams = serde_json::from_value(json!({
            "prompt": "fix the build"
        }))
        .expect("deserialize agent run");
        assert_eq!(params.prompt, "fix the build");
        assert!(METHODS.contains(&METHOD_AGENT_RUN));
    }

    #[test]
    fn query_round_trips_the_prompt() {
        let params: QueryParams = serde_json::from_value(json!({
            "prompt": "what is in TERMIGO.md?"
        }))
        .expect("deserialize query");
        assert_eq!(params.prompt, "what is in TERMIGO.md?");
        assert!(METHODS.contains(&METHOD_QUERY));
    }

    #[test]
    fn run_command_round_trips_the_id() {
        let params: RunCommandParams = serde_json::from_value(json!({
            "command": "settings.open"
        }))
        .expect("deserialize run-command");
        assert_eq!(params.command, "settings.open");
        assert!(METHODS.contains(&METHOD_RUN_COMMAND));
    }
}
