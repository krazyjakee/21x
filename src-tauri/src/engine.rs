use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{ChildStdin, Command},
    sync::{oneshot, watch, Mutex as AsyncMutex, Semaphore},
    time::timeout,
};

const MAX_FRAME: usize = 1024 * 1024;
const MAX_PENDING: usize = 128;
const MAX_QUEUED_BYTES: usize = 4 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(30);
const NODE_VERSION: &str = "v22.23.2";

#[derive(Clone, Debug, Serialize)]
pub struct EngineError {
    pub code: &'static str,
    pub message: &'static str,
}

impl EngineError {
    pub fn new(code: &'static str) -> Self {
        let message = match code {
            "BACKPRESSURE" => "Engine capacity exceeded.",
            "TIMEOUT" => "Engine operation timed out.",
            "INVALID_ARGUMENTS" => "Invalid operation arguments.",
            "UNKNOWN_OPERATION" => "Unknown operation.",
            "UNAUTHORIZED" => "Caller is not authorized.",
            "INVALID_FRAME" => "Invalid engine protocol frame.",
            "INVALID_RESULT" => "Invalid engine operation result.",
            "FRAME_TOO_LARGE" => "Engine protocol frame exceeds the size limit.",
            "CANCELLED" => "Engine operation cancelled.",
            _ => "Engine unavailable.",
        };
        Self { code, message }
    }
}

struct Pending {
    bootstrap: bool,
    operation: String,
    sender: oneshot::Sender<Result<Value, EngineError>>,
}

struct Inner {
    stdin: AsyncMutex<ChildStdin>,
    pending: Mutex<HashMap<String, Pending>>,
    epoch: Mutex<String>,
    next_id: AtomicU64,
    closed: AtomicBool,
    queue_bytes: Arc<Semaphore>,
    request_slots: Arc<Semaphore>,
    stop: watch::Sender<bool>,
    exited: watch::Receiver<bool>,
}

#[derive(Clone)]
pub struct Engine(Arc<Inner>);

// A cancelled Rust invoke releases its pending slot as well as a timeout does.
struct PendingGuard {
    engine: Engine,
    id: String,
    write_started: bool,
    written: bool,
    completed: bool,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.engine.0.pending.lock().unwrap().remove(&self.id);
        if self.completed {
            return;
        }
        if self.write_started && !self.written {
            self.engine.disconnect(EngineError::new("CANCELLED"));
        } else if self.written && !self.engine.0.closed.load(Ordering::SeqCst) {
            let engine = self.engine.clone();
            let id = self.id.clone();
            tokio::spawn(async move {
                engine.cancel(&id).await;
            });
        }
    }
}

impl Engine {
    pub async fn start(resource_root: PathBuf, profile_root: PathBuf) -> Result<Self, EngineError> {
        let resource_root =
            std::fs::canonicalize(resource_root).map_err(|_| EngineError::new("DISCONNECTED"))?;
        let profile_root =
            std::fs::canonicalize(profile_root).map_err(|_| EngineError::new("DISCONNECTED"))?;
        let executable =
            resource_root
                .join("node")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
        let entry = resource_root.join("service/feasibility.mjs");
        if !executable.is_file() || !entry.is_file() {
            return Err(EngineError::new("DISCONNECTED"));
        }
        let executable =
            std::fs::canonicalize(executable).map_err(|_| EngineError::new("DISCONNECTED"))?;
        let entry = std::fs::canonicalize(entry).map_err(|_| EngineError::new("DISCONNECTED"))?;
        if !executable.starts_with(&resource_root) || !entry.starts_with(&resource_root) {
            return Err(EngineError::new("DISCONNECTED"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if std::fs::metadata(&executable)
                .map_err(|_| EngineError::new("DISCONNECTED"))?
                .permissions()
                .mode()
                & 0o111
                == 0
            {
                return Err(EngineError::new("DISCONNECTED"));
            }
        }
        let mut command = Command::new(executable);
        command
            .arg(entry)
            .current_dir(resource_root.join("service"))
            .env_clear()
            .env("TWENTYONEX_PROFILE_ROOT", &profile_root)
            .env("TWENTYONEX_RESOURCE_ROOT", &resource_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for key in ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut child = command
            .spawn()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
        let (stop, mut stop_rx) = watch::channel(false);
        let (exited_tx, exited) = watch::channel(false);
        let engine = Self(Arc::new(Inner {
            stdin: AsyncMutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            epoch: Mutex::new(String::new()),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            queue_bytes: Arc::new(Semaphore::new(MAX_QUEUED_BYTES)),
            request_slots: Arc::new(Semaphore::new(MAX_PENDING)),
            stop,
            exited,
        }));
        let monitor = engine.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = child.wait() => {},
                _ = stop_rx.changed() => { let _ = child.start_kill(); let _ = child.wait().await; }
            }
            monitor.disconnect(EngineError::new("DISCONNECTED"));
            let _ = exited_tx.send(true);
        });
        let reader = engine.clone();
        tokio::spawn(async move {
            let mut frame = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                let count = match stdout.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                for byte in &chunk[..count] {
                    if *byte == b'\n' {
                        if reader.accept_response(&frame).is_err() {
                            reader.disconnect(EngineError::new("INVALID_FRAME"));
                            return;
                        }
                        frame.clear();
                    } else {
                        if frame.len() >= MAX_FRAME {
                            reader.disconnect(EngineError::new("FRAME_TOO_LARGE"));
                            return;
                        }
                        frame.push(*byte);
                    }
                }
            }
            reader.disconnect(EngineError::new("DISCONNECTED"));
        });
        let ready = engine
            .request(
                "engine.initialize",
                json!({
                    "protocolVersion": 1, "profileRoot": profile_root, "resourceRoot": resource_root
                }),
            )
            .await;
        if let Err(error) = ready {
            engine.shutdown().await;
            return Err(error);
        }
        Ok(engine)
    }

    fn disconnect(&self, error: EngineError) {
        self.0.closed.store(true, Ordering::SeqCst);
        let pending = std::mem::take(&mut *self.0.pending.lock().unwrap());
        for (_, entry) in pending {
            let _ = entry.sender.send(Err(error.clone()));
        }
        let _ = self.0.stop.send(true);
    }

    fn accept_response(&self, bytes: &[u8]) -> Result<(), ()> {
        let frame: Value = serde_json::from_slice(bytes).map_err(|_| ())?;
        let object = frame.as_object().ok_or(())?;
        if object.len() != 5
            || frame["protocolVersion"] != 1
            || frame["kind"] != "response"
            || frame.get("result").is_some() == frame.get("error").is_some()
        {
            return Err(());
        }
        let id = frame["requestId"].as_str().ok_or(())?;
        if !valid_id(id) {
            return Err(());
        }
        let epoch = frame["engineEpoch"]
            .as_str()
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= 128
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            })
            .ok_or(())?;
        // Validate response structure even when its request has already timed out.
        let result = if let Some(error) = frame.get("error") {
            Err(validate_error(error)?)
        } else {
            Ok(frame["result"].clone())
        };
        let mut current = self.0.epoch.lock().unwrap();
        let mut pending = self.0.pending.lock().unwrap();
        let Some(entry) = pending.get(id) else {
            return Ok(());
        };
        if !entry.bootstrap && current.as_str() != epoch {
            return Ok(());
        }
        if let Ok(value) = &result {
            if !valid_result(&entry.operation, value, epoch) {
                return Err(());
            }
            if entry.bootstrap {
                *current = epoch.to_string();
            }
        }
        let entry = pending.remove(id).ok_or(())?;
        let _ = entry.sender.send(result);
        Ok(())
    }

    pub async fn request(&self, operation: &str, payload: Value) -> Result<Value, EngineError> {
        timeout(DEADLINE, self.request_inner(operation, payload))
            .await
            .unwrap_or_else(|_| Err(EngineError::new("TIMEOUT")))
    }

    async fn request_inner(&self, operation: &str, payload: Value) -> Result<Value, EngineError> {
        if self.0.closed.load(Ordering::SeqCst) {
            return Err(EngineError::new("DISCONNECTED"));
        }
        let _slot = self
            .0
            .request_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| EngineError::new("BACKPRESSURE"))?;
        // Reserve queue bytes before waiting for the writer. The 32-digit placeholder
        // is an upper bound, so the actual envelope cannot exceed the reservation.
        let epoch = self.0.epoch.lock().unwrap().clone();
        let estimate = serde_json::to_vec(&json!({"protocolVersion": 1, "engineEpoch": epoch,
            "kind": "request", "requestId": "host:99999999999999999999999999999999",
            "operation": operation, "payload": payload
        }))
        .map_err(|_| EngineError::new("INVALID_ARGUMENTS"))?
        .len()
            + 1;
        if estimate - 1 > MAX_FRAME {
            return Err(EngineError::new("FRAME_TOO_LARGE"));
        }
        let queued = self
            .0
            .queue_bytes
            .clone()
            .try_acquire_many_owned(estimate as u32)
            .map_err(|_| EngineError::new("BACKPRESSURE"))?;
        let mut stdin = self.0.stdin.lock().await;
        if self.0.closed.load(Ordering::SeqCst) {
            return Err(EngineError::new("DISCONNECTED"));
        }
        // Allocation and the complete write share one lock: concurrent runtimes
        // cannot send host:2 before host:1.
        let id = format!("host:{}", self.0.next_id.fetch_add(1, Ordering::SeqCst));
        let epoch = self.0.epoch.lock().unwrap().clone();
        let mut bytes = serde_json::to_vec(&json!({"protocolVersion": 1, "engineEpoch": epoch,
            "kind": "request", "requestId": id, "operation": operation, "payload": payload
        }))
        .map_err(|_| EngineError::new("INVALID_ARGUMENTS"))?;
        bytes.push(b'\n');
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.0.pending.lock().unwrap();
            if self.0.closed.load(Ordering::SeqCst) {
                return Err(EngineError::new("DISCONNECTED"));
            }
            pending.insert(
                id.clone(),
                Pending {
                    bootstrap: epoch.is_empty(),
                    operation: operation.to_string(),
                    sender,
                },
            );
        }
        let mut guard = PendingGuard {
            engine: self.clone(),
            id,
            write_started: false,
            written: false,
            completed: false,
        };
        guard.write_started = true;
        if stdin.write_all(&bytes).await.is_err() || stdin.flush().await.is_err() {
            self.disconnect(EngineError::new("DISCONNECTED"));
            return Err(EngineError::new("DISCONNECTED"));
        }
        guard.written = true;
        drop(bytes);
        drop(stdin);
        drop(queued);
        let answer = receiver
            .await
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        guard.completed = true;
        answer
    }

    async fn cancel(&self, id: &str) {
        let epoch = self.0.epoch.lock().unwrap().clone();
        let bytes = format!(
            "{}\n",
            json!({"protocolVersion": 1, "engineEpoch": epoch,
            "kind": "event", "operation": "engine.cancel", "payload": {"requestId": id}})
        );
        let sent = timeout(Duration::from_secs(1), async {
            self.0.stdin.lock().await.write_all(bytes.as_bytes()).await
        })
        .await;
        if !matches!(sent, Ok(Ok(()))) {
            self.disconnect(EngineError::new("DISCONNECTED"));
        }
    }

    pub fn status(&self) -> Value {
        json!({"available": !self.0.closed.load(Ordering::SeqCst), "protocolVersion": 1,
            "engineEpoch": self.0.epoch.lock().unwrap().clone(), "experimental": true})
    }

    pub async fn shutdown(&self) {
        let mut exited = self.0.exited.clone();
        if !self.0.closed.load(Ordering::SeqCst) {
            let _ = timeout(Duration::from_secs(3), async {
                let _ = self.request("engine.shutdown", json!({})).await;
                let already_exited = *exited.borrow();
                if !already_exited {
                    let _ = exited.changed().await;
                }
            })
            .await;
        }
        self.disconnect(EngineError::new("DISCONNECTED"));
        let already_exited = *exited.borrow();
        if !already_exited {
            let _ = timeout(Duration::from_secs(5), exited.changed()).await;
        }
    }
}

fn validate_error(error: &Value) -> Result<EngineError, ()> {
    if error.as_object().map(|o| o.len()) != Some(2)
        || error["message"].as_str().map(|s| s.len()).unwrap_or(257) > 256
    {
        return Err(());
    }
    let code = match error["code"].as_str() {
        Some("INVALID_ARGUMENTS") => "INVALID_ARGUMENTS",
        Some("UNKNOWN_OPERATION") => "UNKNOWN_OPERATION",
        Some("BACKPRESSURE") => "BACKPRESSURE",
        Some("TIMEOUT") => "TIMEOUT",
        Some("CANCELLED") => "CANCELLED",
        Some("INTERNAL_ERROR") => "INTERNAL_ERROR",
        Some("INVALID_FRAME") => "INVALID_FRAME",
        Some("FRAME_TOO_LARGE") => "FRAME_TOO_LARGE",
        Some("UNSUPPORTED_VERSION") => "UNSUPPORTED_VERSION",
        Some("STALE_EPOCH") => "STALE_EPOCH",
        Some("INVALID_REQUEST") => "INVALID_REQUEST",
        Some("INVALID_RESULT") => "INVALID_RESULT",
        Some("DISCONNECTED") => "DISCONNECTED",
        _ => return Err(()),
    };
    Ok(EngineError::new(code))
}

fn valid_result(operation: &str, result: &Value, epoch: &str) -> bool {
    match operation {
        "engine.initialize" | "engine.ping" => {
            result.as_object().map(|o| o.len()) == Some(3)
                && result["protocolVersion"] == 1
                && result["engineEpoch"] == epoch
                && result["nodeVersion"] == NODE_VERSION
        }
        "engine.shutdown" => result == &json!({"stopped": true}),
        "engine.probe" => {
            let Some(checks) = result["checks"].as_object() else {
                return false;
            };
            let names = [
                "sqlite",
                "pty",
                "worker",
                "@anthropic-ai/claude-agent-sdk",
                "@opencode-ai/sdk",
            ];
            result.as_object().map(|o| o.len()) == Some(6)
                && checks.len() == names.len()
                && names.iter().all(|name| {
                    checks
                        .get(*name)
                        .and_then(|check| check["ok"].as_bool())
                        .is_some()
                })
                && result["ok"].as_bool() == Some(checks.values().all(|check| check["ok"] == true))
                && result["nodeVersion"] == NODE_VERSION
                && result["nodeAbi"] == "127"
                && matches!(
                    result["platform"].as_str(),
                    Some("linux" | "darwin" | "win32")
                )
                && matches!(result["arch"].as_str(), Some("x64" | "arm64"))
        }
        _ => false,
    }
}

fn valid_id(id: &str) -> bool {
    id.strip_prefix("host:")
        .map(|digits| {
            !digits.is_empty()
                && digits.len() <= 32
                && !digits.starts_with('0')
                && digits.bytes().all(|byte| byte.is_ascii_digit())
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ids_reject_wrong_direction_and_leading_zero() {
        assert!(valid_id("host:123"));
        for id in ["service:1", "host:0", "host:01", "host:", "host:-1"] {
            assert!(!valid_id(id));
        }
    }

    #[test]
    fn mixed_runtime_bootstrap_is_rejected() {
        let mut fixture =
            json!({"protocolVersion": 1, "engineEpoch": "fixture", "nodeVersion": NODE_VERSION});
        assert!(valid_result("engine.initialize", &fixture, "fixture"));
        fixture["nodeVersion"] = json!("v20.0.0");
        assert!(!valid_result("engine.initialize", &fixture, "fixture"));
    }

    #[test]
    fn error_message_from_child_is_never_forwarded() {
        let error =
            validate_error(&json!({"code": "TIMEOUT", "message": "credential=must-not-appear"}))
                .unwrap();
        assert_eq!(error.message, "Engine operation timed out.");
        assert!(validate_error(&json!({"code": "UNRECOGNIZED", "message": "unsafe"})).is_err());
    }
}
