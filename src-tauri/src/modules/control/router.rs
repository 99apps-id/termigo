use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Emitter;
use termigo_control_protocol::{
    AgentRunParams, ControlRequest, ControlResponse, FocusParams, FrontendRequest,
    FrontendResponse, OpenParams, PentestReportParams, PentestRunParams, QueryParams,
    RunCommandParams, METHODS, METHOD_AGENT_RUN, METHOD_CAPABILITIES, METHOD_FOCUS,
    METHOD_IDENTIFY, METHOD_OPEN, METHOD_PENTEST_REPORT, METHOD_PENTEST_RUN, METHOD_PENTEST_STATUS,
    METHOD_PING, METHOD_QUERY, METHOD_RUN_COMMAND, METHOD_STATUS, PROTOCOL_VERSION,
    SERVER_RESPONSE_ID,
};

use super::validation::{
    constant_time_eq, valid_request_id, validate_agent_run_params, validate_open_params,
    validate_pentest_report_params, validate_pentest_run_params, validate_query_params,
    validate_run_command_params,
};
use super::ControlState;

pub const CONTROL_EVENT: &str = "termigo:control-request";
pub const FRONTEND_TIMEOUT: Duration = Duration::from_secs(5);
/// A query waits for the agent's full answer, which can take minutes of tool
/// steps — far beyond the 5s budget of one-shot UI actions like focus/open.
pub const QUERY_FRONTEND_TIMEOUT: Duration = Duration::from_secs(600);
pub const MAX_PENDING_REQUESTS: usize = 32;

pub fn route_request(
    mut request: ControlRequest,
    app: &tauri::AppHandle,
    state: &ControlState,
) -> ControlResponse {
    if !valid_request_id(&request.id) {
        return ControlResponse::failure(
            SERVER_RESPONSE_ID,
            "invalid_request",
            "request id must be 1-128 safe ASCII characters",
        );
    }
    if request.protocol != PROTOCOL_VERSION {
        return ControlResponse::failure(
            request.id,
            "unsupported_protocol",
            format!(
                "protocol {} is unsupported; expected {PROTOCOL_VERSION}",
                request.protocol
            ),
        );
    }
    let Some(runtime) = state.0.runtime.get() else {
        return ControlResponse::failure(
            request.id,
            "server_unavailable",
            "control server is not initialized",
        );
    };
    if !constant_time_eq(request.token.as_bytes(), runtime.token.as_bytes()) {
        return ControlResponse::failure(request.id, "unauthorized", "invalid control token");
    }

    match request.method.as_str() {
        METHOD_PING => ControlResponse::success(
            request.id,
            json!({
                "pong": true,
                "app_version": env!("CARGO_PKG_VERSION"),
                "protocol": PROTOCOL_VERSION,
            }),
        ),
        METHOD_CAPABILITIES => ControlResponse::success(
            request.id,
            json!({
                "app_version": env!("CARGO_PKG_VERSION"),
                "protocol": PROTOCOL_VERSION,
                "methods": METHODS,
            }),
        ),
        METHOD_STATUS => {
            let id = request.id.clone();
            let basic = json!({
                "app_version": env!("CARGO_PKG_VERSION"),
                "protocol": PROTOCOL_VERSION,
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "methods": METHODS,
                "ui": Value::Null,
            });
            let response = forward_to_frontend(request, app, state);
            if !response.ok
                && response
                    .error
                    .as_ref()
                    .is_some_and(|e| e.code == "frontend_not_ready")
            {
                ControlResponse::success(id, basic)
            } else {
                response
            }
        }
        METHOD_IDENTIFY => forward_to_frontend(request, app, state),
        METHOD_FOCUS => {
            let params: FocusParams = match serde_json::from_value(request.params.clone()) {
                Ok(params) => params,
                Err(error) => {
                    return ControlResponse::failure(
                        request.id,
                        "invalid_params",
                        format!("invalid focus parameters: {error}"),
                    );
                }
            };
            if let Ok(serialized) = serde_json::to_value(params) {
                request.params = serialized;
            }
            forward_to_frontend(request, app, state)
        }
        METHOD_OPEN => {
            let params: OpenParams = match serde_json::from_value(request.params.clone()) {
                Ok(params) => params,
                Err(error) => {
                    return ControlResponse::failure(
                        request.id,
                        "invalid_params",
                        format!("invalid open parameters: {error}"),
                    );
                }
            };
            match validate_open_params(params, app) {
                Ok(params) => match serde_json::to_value(params) {
                    Ok(params) => {
                        request.params = params;
                        forward_to_frontend(request, app, state)
                    }
                    Err(error) => ControlResponse::failure(
                        request.id,
                        "internal_error",
                        format!("serialize open parameters: {error}"),
                    ),
                },
                Err((code, message)) => ControlResponse::failure(request.id, code, message),
            }
        }
        METHOD_PENTEST_RUN => {
            let params: PentestRunParams = match serde_json::from_value(request.params.clone()) {
                Ok(params) => params,
                Err(error) => {
                    return ControlResponse::failure(
                        request.id,
                        "invalid_params",
                        format!("invalid pentest-run parameters: {error}"),
                    );
                }
            };
            match validate_pentest_run_params(params) {
                Ok(params) => match serde_json::to_value(params) {
                    Ok(params) => {
                        request.params = params;
                        forward_to_frontend(request, app, state)
                    }
                    Err(error) => ControlResponse::failure(
                        request.id,
                        "internal_error",
                        format!("serialize pentest-run parameters: {error}"),
                    ),
                },
                Err((code, message)) => ControlResponse::failure(request.id, code, message),
            }
        }
        METHOD_PENTEST_STATUS => {
            forward_to_frontend(request, app, state)
        }
        METHOD_AGENT_RUN => {
            let params: AgentRunParams = match serde_json::from_value(request.params.clone()) {
                Ok(params) => params,
                Err(error) => {
                    return ControlResponse::failure(
                        request.id,
                        "invalid_params",
                        format!("invalid run parameters: {error}"),
                    );
                }
            };
            match validate_agent_run_params(params) {
                Ok(params) => match serde_json::to_value(params) {
                    Ok(params) => {
                        request.params = params;
                        forward_to_frontend(request, app, state)
                    }
                    Err(error) => ControlResponse::failure(
                        request.id,
                        "internal_error",
                        format!("serialize run parameters: {error}"),
                    ),
                },
                Err((code, message)) => ControlResponse::failure(request.id, code, message),
            }
        }
        METHOD_QUERY => {
            let params: QueryParams = match serde_json::from_value(request.params.clone()) {
                Ok(params) => params,
                Err(error) => {
                    return ControlResponse::failure(
                        request.id,
                        "invalid_params",
                        format!("invalid query parameters: {error}"),
                    );
                }
            };
            match validate_query_params(params) {
                Ok(params) => match serde_json::to_value(params) {
                    Ok(params) => {
                        request.params = params;
                        forward_to_frontend_with_timeout(
                            request,
                            app,
                            state,
                            QUERY_FRONTEND_TIMEOUT,
                        )
                    }
                    Err(error) => ControlResponse::failure(
                        request.id,
                        "internal_error",
                        format!("serialize query parameters: {error}"),
                    ),
                },
                Err((code, message)) => ControlResponse::failure(request.id, code, message),
            }
        }
        METHOD_RUN_COMMAND => {
            let params: RunCommandParams = match serde_json::from_value(request.params.clone()) {
                Ok(params) => params,
                Err(error) => {
                    return ControlResponse::failure(
                        request.id,
                        "invalid_params",
                        format!("invalid run-command parameters: {error}"),
                    );
                }
            };
            match validate_run_command_params(params) {
                Ok(params) => match serde_json::to_value(params) {
                    Ok(params) => {
                        request.params = params;
                        forward_to_frontend(request, app, state)
                    }
                    Err(error) => ControlResponse::failure(
                        request.id,
                        "internal_error",
                        format!("serialize run-command parameters: {error}"),
                    ),
                },
                Err((code, message)) => ControlResponse::failure(request.id, code, message),
            }
        }
        METHOD_PENTEST_REPORT => {
            let params: PentestReportParams = match serde_json::from_value(request.params.clone()) {
                Ok(params) => params,
                Err(error) => {
                    return ControlResponse::failure(
                        request.id,
                        "invalid_params",
                        format!("invalid pentest-report parameters: {error}"),
                    );
                }
            };
            match validate_pentest_report_params(params) {
                Ok(params) => match serde_json::to_value(params) {
                    Ok(params) => {
                        request.params = params;
                        forward_to_frontend(request, app, state)
                    }
                    Err(error) => ControlResponse::failure(
                        request.id,
                        "internal_error",
                        format!("serialize pentest-report parameters: {error}"),
                    ),
                },
                Err((code, message)) => ControlResponse::failure(request.id, code, message),
            }
        }
        _ => ControlResponse::failure(request.id, "unknown_method", "unknown control method"),
    }
}

pub fn forward_to_frontend(
    request: ControlRequest,
    app: &tauri::AppHandle,
    state: &ControlState,
) -> ControlResponse {
    forward_to_frontend_with_timeout(request, app, state, FRONTEND_TIMEOUT)
}

pub fn forward_to_frontend_with_timeout(
    request: ControlRequest,
    app: &tauri::AppHandle,
    state: &ControlState,
    timeout: Duration,
) -> ControlResponse {
    if !state.0.frontend_ready.load(Ordering::Acquire) {
        return ControlResponse::failure(
            request.id,
            "frontend_not_ready",
            "Termigo is still restoring its workspace; try again shortly",
        );
    }

    let id = request.id.clone();
    let (sender, receiver) = mpsc::sync_channel(1);
    {
        let mut pending = state.0.pending.lock().expect("control pending poisoned");
        if pending.len() >= MAX_PENDING_REQUESTS {
            return ControlResponse::failure(
                id,
                "server_busy",
                "too many pending frontend requests",
            );
        }
        if pending.contains_key(&id) {
            return ControlResponse::failure(id, "duplicate_id", "request id is already pending");
        }
        pending.insert(id.clone(), sender);
    }

    let frontend_request = FrontendRequest {
        id: id.clone(),
        method: request.method,
        params: request.params,
        caller: request.caller,
    };
    if let Err(error) = app.emit_to("main", CONTROL_EVENT, frontend_request) {
        state
            .0
            .pending
            .lock()
            .expect("control pending poisoned")
            .remove(&id);
        return ControlResponse::failure(
            id,
            "frontend_unavailable",
            format!("could not reach Termigo UI: {error}"),
        );
    }

    match receiver.recv_timeout(timeout) {
        Ok(response) if response.ok => {
            ControlResponse::success(id, response.result.unwrap_or(Value::Null))
        }
        Ok(response) => {
            let error = response.error.unwrap_or_else(|| {
                termigo_control_protocol::ControlError::new(
                    "frontend_error",
                    "frontend request failed",
                )
            });
            ControlResponse::failure(id, error.code, error.message)
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            state
                .0
                .pending
                .lock()
                .expect("control pending poisoned")
                .remove(&id);
            ControlResponse::failure(id, "frontend_timeout", "Termigo UI did not respond in time")
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => ControlResponse::failure(
            id,
            "frontend_unavailable",
            "Termigo UI response channel closed",
        ),
    }
}

#[tauri::command]
pub fn control_frontend_ready(state: tauri::State<'_, ControlState>, ready: bool) {
    state.0.frontend_ready.store(ready, Ordering::Release);
}

#[tauri::command]
pub fn control_respond(
    state: tauri::State<'_, ControlState>,
    request_id: String,
    response: FrontendResponse,
) -> bool {
    let sender = state
        .0
        .pending
        .lock()
        .expect("control pending poisoned")
        .remove(&request_id);
    sender.is_some_and(|sender| sender.send(response).is_ok())
}
