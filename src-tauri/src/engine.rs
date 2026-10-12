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
    sender: oneshot::Sender<Result<Value, EngineError>>,
}

struct Inner {
    stdin: AsyncMutex<ChildStdin>,
    pending: Mutex<HashMap<String, Pending>>,
    epoch: Mutex<String>,
    next_id: AtomicU64,
    closed: AtomicBool,
    queue_bytes: Arc<Semaphore>,
    stop: watch::Sender<bool>,
    exited: watch::Receiver<bool>,
}

#[derive(Clone)]
pub struct Engine(Arc<Inner>);

// A cancelled Rust invoke releases its pending slot as well as a timeout does.
struct PendingGuard {
    engine: Engine,
    id: String,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.engine.0.pending.lock().unwrap().remove(&self.id);
    }
}

impl Engine {
    pub async fn start(resource_root: PathBuf, profile_root: PathBuf) -> Result<Self, EngineError> {
        let executable =
            resource_root
                .join("node")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
        let entry = resource_root.join("service/feasibility.mjs");
        if !executable.is_file() || !entry.is_file() {
            return Err(EngineError::new("DISCONNECTED"));
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
            .filter(|value| !value.is_empty() && value.len() <= 128)
            .ok_or(())?;
        let mut current = self.0.epoch.lock().unwrap();
        let mut pending = self.0.pending.lock().unwrap();
        let Some(entry) = pending.get(id) else {
            return Ok(());
        }; // Timed-out responses are not replayed.
        if entry.bootstrap && frame.get("result").is_some() {
            let result = &frame["result"];
            if result.as_object().map(|o| o.len()) != Some(3)
                || result["protocolVersion"] != 1
                || result["engineEpoch"] != epoch
                || result["nodeVersion"].as_str().is_none()
            {
                return Err(());
            }
            *current = epoch.to_string();
        } else if !entry.bootstrap && current.as_str() != epoch {
            return Err(());
        }
        let entry = pending.remove(id).ok_or(())?;
        let result = if let Some(error) = frame.get("error") {
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
            Err(EngineError::new(code))
        } else {
            Ok(frame["result"].clone())
        };
        let _ = entry.sender.send(result);
        Ok(())
    }

    pub async fn request(&self, operation: &str, payload: Value) -> Result<Value, EngineError> {
        if self.0.closed.load(Ordering::SeqCst) {
            return Err(EngineError::new("DISCONNECTED"));
        }
        let id = format!("host:{}", self.0.next_id.fetch_add(1, Ordering::SeqCst));
        let epoch = self.0.epoch.lock().unwrap().clone();
        let mut bytes = serde_json::to_vec(&json!({"protocolVersion": 1, "engineEpoch": epoch,
            "kind": "request", "requestId": id, "operation": operation, "payload": payload
        }))
        .map_err(|_| EngineError::new("INVALID_ARGUMENTS"))?;
        if bytes.len() > MAX_FRAME {
            return Err(EngineError::new("FRAME_TOO_LARGE"));
        }
        bytes.push(b'\n');
        let queued = self
            .0
            .queue_bytes
            .clone()
            .try_acquire_many_owned(bytes.len() as u32)
            .map_err(|_| EngineError::new("BACKPRESSURE"))?;
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.0.pending.lock().unwrap();
            if pending.len() >= MAX_PENDING {
                return Err(EngineError::new("BACKPRESSURE"));
            }
            pending.insert(
                id.clone(),
                Pending {
                    bootstrap: epoch.is_empty(),
                    sender,
                },
            );
        }
        let _guard = PendingGuard {
            engine: self.clone(),
            id: id.clone(),
        };
        let mut written = false;
        let answer = timeout(DEADLINE, async {
            let mut stdin = self.0.stdin.lock().await;
            stdin
                .write_all(&bytes)
                .await
                .map_err(|_| EngineError::new("DISCONNECTED"))?;
            stdin
                .flush()
                .await
                .map_err(|_| EngineError::new("DISCONNECTED"))?;
            written = true;
            drop(bytes);
            drop(stdin);
            drop(queued);
            receiver
                .await
                .map_err(|_| EngineError::new("DISCONNECTED"))?
        })
        .await;
        match answer {
            Ok(result) => result,
            Err(_) => {
                // A timeout during a partial write invalidates framing; kill rather than reuse it.
                if !written {
                    self.disconnect(EngineError::new("TIMEOUT"));
                } else {
                    self.cancel(&id).await;
                }
                Err(EngineError::new("TIMEOUT"))
            }
        }
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
            let _ = timeout(
                Duration::from_secs(3),
                self.request("engine.shutdown", json!({})),
            )
            .await;
        }
        self.disconnect(EngineError::new("DISCONNECTED"));
        if !*exited.borrow() {
            let _ = timeout(Duration::from_secs(5), exited.changed()).await;
        }
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
}
