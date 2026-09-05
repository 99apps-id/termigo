use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

use serde_json::Value;
use termigo_control_protocol::{
    ControlRequest, ControlResponse, MAX_MESSAGE_BYTES, SERVER_RESPONSE_ID,
};

use super::router::route_request;
use super::validation::valid_request_id;
use super::ControlState;

pub const IO_TIMEOUT: Duration = Duration::from_secs(7);
pub const MAX_CONNECTIONS: usize = 32;
pub const LISTENER_STACK_BYTES: usize = 256 * 1024;
pub const REQUEST_STACK_BYTES: usize = 512 * 1024;

pub struct ConnectionGuard(pub ControlState);

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.release_connection();
    }
}

pub struct ReadRequestError {
    pub response_id: String,
    pub code: &'static str,
    pub message: String,
}

pub fn read_request(reader: &mut impl BufRead) -> Result<ControlRequest, ReadRequestError> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take((MAX_MESSAGE_BYTES + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|error| ReadRequestError {
            response_id: SERVER_RESPONSE_ID.to_string(),
            code: "io_error",
            message: format!("read request: {error}"),
        })?;
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(ReadRequestError {
            response_id: SERVER_RESPONSE_ID.to_string(),
            code: "message_too_large",
            message: format!("request exceeds {MAX_MESSAGE_BYTES} bytes"),
        });
    }
    if bytes.last() != Some(&b'\n') {
        return Err(ReadRequestError {
            response_id: SERVER_RESPONSE_ID.to_string(),
            code: "invalid_request",
            message: "request must end with a newline".to_string(),
        });
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| ReadRequestError {
        response_id: SERVER_RESPONSE_ID.to_string(),
        code: "invalid_json",
        message: format!("invalid request JSON: {error}"),
    })?;
    let response_id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| valid_request_id(id))
        .unwrap_or(SERVER_RESPONSE_ID)
        .to_string();
    serde_json::from_value(value).map_err(|error| ReadRequestError {
        response_id,
        code: "invalid_json",
        message: format!("invalid request JSON: {error}"),
    })
}

pub fn write_response(stream: &mut TcpStream, response: &ControlResponse) -> std::io::Result<()> {
    let mut bytes = serde_json::to_vec(response).map_err(std::io::Error::other)?;
    bytes.push(b'\n');
    stream.write_all(&bytes)
}

pub fn handle_connection(mut stream: TcpStream, app: &tauri::AppHandle, state: &ControlState) {
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));

    let request = match read_request(&mut BufReader::new(&mut stream)) {
        Ok(request) => request,
        Err(error) => {
            let _ = write_response(
                &mut stream,
                &ControlResponse::failure(error.response_id, error.code, error.message),
            );
            return;
        }
    };
    let response = route_request(request, app, state);
    let _ = write_response(&mut stream, &response);
}

pub fn accept_loop(listener: TcpListener, app: tauri::AppHandle, state: ControlState) {
    for incoming in listener.incoming() {
        if state.0.shutting_down.load(Ordering::Acquire) {
            break;
        }
        let stream = match incoming {
            Ok(stream) => stream,
            Err(error) => {
                if !state.0.shutting_down.load(Ordering::Acquire) {
                    log::warn!("control socket accept failed: {error}");
                }
                continue;
            }
        };

        if state.0.active_connections.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS {
            state.release_connection();
            let mut stream = stream;
            let response = ControlResponse::failure(
                SERVER_RESPONSE_ID,
                "server_busy",
                "too many concurrent control requests",
            );
            let _ = write_response(&mut stream, &response);
            continue;
        }

        let app = app.clone();
        let request_state = state.clone();
        if let Err(error) = thread::Builder::new()
            .name("termigo-control-request".into())
            .stack_size(REQUEST_STACK_BYTES)
            .spawn(move || {
                let _guard = ConnectionGuard(request_state.clone());
                handle_connection(stream, &app, &request_state);
            })
        {
            state.release_connection();
            log::warn!("could not spawn control request thread: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn read_error(bytes: Vec<u8>) -> ReadRequestError {
        match read_request(&mut Cursor::new(bytes)) {
            Ok(_) => panic!("request was unexpectedly accepted"),
            Err(error) => error,
        }
    }

    #[test]
    fn request_reader_enforces_framing_and_size_boundaries() {
        let mut exact = vec![b' '; MAX_MESSAGE_BYTES];
        exact[MAX_MESSAGE_BYTES - 1] = b'\n';
        let error = read_error(exact);
        assert_eq!(error.code, "invalid_json");

        let mut oversized = vec![b' '; MAX_MESSAGE_BYTES];
        oversized.push(b'\n');
        let error = read_error(oversized);
        assert_eq!(error.code, "message_too_large");

        let error = read_error(b"{}".to_vec());
        assert_eq!(error.code, "invalid_request");
    }

    #[test]
    fn request_reader_preserves_a_safe_id_for_shape_errors() {
        let bytes = br#"{"id":"shape-test","protocol":"bad"}
"#;
        let error = read_error(bytes.to_vec());
        assert_eq!(error.code, "invalid_json");
        assert_eq!(error.response_id, "shape-test");
    }
}
