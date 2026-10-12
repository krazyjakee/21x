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
#[cfg(feature = "synthetic-desktop")]
mod desktop;
mod process_tree;
#[cfg(feature = "synthetic-desktop")]
pub type DesktopEventSink = Arc<dyn Fn(Value) -> Result<(), EngineError> + Send + Sync>;

const MAX_FRAME: usize = 1024 * 1024;
const MAX_PENDING: usize = 128;
const MAX_QUEUED_BYTES: usize = 4 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(30);
const NODE_VERSION: &str = "v22.23.2";

#[derive(Clone, Debug, Serialize)]
pub struct EngineError {
    pub code: &'static str,
    pub message: &'static str,
    #[serde(skip)]
    pub startup_phase: Option<&'static str>,
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
            "STALE_EPOCH" => "Engine epoch does not match.",
            "FRAME_TOO_LARGE" => "Engine protocol frame exceeds the size limit.",
            "CANCELLED" => "Engine operation cancelled.",
            _ => "Engine unavailable.",
        };
        Self {
            code,
            message,
            startup_phase: None,
        }
    }
    fn startup(mut self, phase: &'static str) -> Self {
        self.startup_phase = Some(phase);
        self
    }
}

#[cfg(not(windows))]
fn node_path(path: PathBuf) -> Result<PathBuf, EngineError> {
    Ok(path)
}

#[cfg(windows)]
fn node_path(path: PathBuf) -> Result<PathBuf, EngineError> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    let units: Vec<u16> = path.as_os_str().encode_wide().collect();
    let namespace: Vec<u16> = r"\\?\".encode_utf16().collect();
    let unc: Vec<u16> = r"\\?\UNC\".encode_utf16().collect();
    let normalized = if units.starts_with(&unc) {
        [
            vec![b'\\' as u16, b'\\' as u16],
            units[unc.len()..].to_vec(),
        ]
        .concat()
    } else if units.starts_with(&namespace) {
        if units.len() < 7
            || !matches!(units[4], 65..=90 | 97..=122)
            || units[5] != b':' as u16
            || units[6] != b'\\' as u16
        {
            return Err(EngineError::new("DISCONNECTED").startup("node-path-format"));
        }
        units[namespace.len()..].to_vec()
    } else {
        units
    };
    Ok(PathBuf::from(std::ffi::OsString::from_wide(&normalized)))
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
    #[cfg(feature = "native-fixture-tests")]
    process_id: u32,
    closed: AtomicBool,
    synthetic: bool,
    #[cfg(feature = "synthetic-desktop")]
    event_sink: Option<DesktopEventSink>,
    #[cfg(feature = "synthetic-desktop")]
    event_sequence: Mutex<u64>,
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
        Self::start_impl(resource_root, profile_root, false).await
    }

    #[cfg(feature = "synthetic-desktop")]
    pub async fn start_synthetic(
        resource_root: PathBuf,
        profile_root: PathBuf,
        sink: DesktopEventSink,
    ) -> Result<Self, EngineError> {
        let profile = std::fs::canonicalize(&profile_root)
            .map_err(|_| EngineError::new("DISCONNECTED").startup("synthetic-profile"))?;
        let temporary = std::fs::canonicalize(std::env::temp_dir())
            .map_err(|_| EngineError::new("DISCONNECTED").startup("synthetic-profile"))?;
        if !profile.starts_with(temporary)
            || !profile
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("21x-database-service-"))
        {
            return Err(EngineError::new("DISCONNECTED").startup("synthetic-profile"));
        }
        Self::start_selected(resource_root, profile, false, Some(sink)).await
    }

    async fn start_impl(
        resource_root: PathBuf,
        profile_root: PathBuf,
        fixture_mode: bool,
    ) -> Result<Self, EngineError> {
        Self::start_selected(
            resource_root,
            profile_root,
            fixture_mode,
            #[cfg(feature = "synthetic-desktop")]
            None,
        )
        .await
    }

    async fn start_selected(
        resource_root: PathBuf,
        profile_root: PathBuf,
        fixture_mode: bool,
        #[cfg(feature = "synthetic-desktop")] event_sink: Option<DesktopEventSink>,
    ) -> Result<Self, EngineError> {
        #[cfg(feature = "synthetic-desktop")]
        let synthetic = event_sink.is_some();
        #[cfg(not(feature = "synthetic-desktop"))]
        let synthetic = false;
        let resource_root = std::fs::canonicalize(resource_root)
            .map_err(|_| EngineError::new("DISCONNECTED").startup("resource-root"))?;
        let profile_root = std::fs::canonicalize(profile_root)
            .map_err(|_| EngineError::new("DISCONNECTED").startup("profile-root"))?;
        let executable =
            resource_root
                .join("node")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
        let entry = resource_root.join(if synthetic {
            "service/database-stdio.mjs"
        } else {
            "service/feasibility.mjs"
        });
        if !executable.is_file() || !entry.is_file() {
            return Err(EngineError::new("DISCONNECTED").startup("resource-files"));
        }
        let executable = std::fs::canonicalize(executable)
            .map_err(|_| EngineError::new("DISCONNECTED").startup("node-path"))?;
        let entry = std::fs::canonicalize(entry)
            .map_err(|_| EngineError::new("DISCONNECTED").startup("entry-path"))?;
        if !executable.starts_with(&resource_root) || !entry.starts_with(&resource_root) {
            return Err(EngineError::new("DISCONNECTED").startup("resource-containment"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if std::fs::metadata(&executable)
                .map_err(|_| EngineError::new("DISCONNECTED").startup("node-permission"))?
                .permissions()
                .mode()
                & 0o111
                == 0
            {
                return Err(EngineError::new("DISCONNECTED").startup("node-permission"));
            }
        }
        // Canonical containment is checked above. Node 22's script resolver must
        // receive ordinary drive/UNC paths instead of Rust's Win32 namespace.
        let executable = node_path(executable)?;
        let entry = node_path(entry)?;
        let resource_root = node_path(resource_root)?;
        let profile_root = node_path(profile_root)?;
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
        if synthetic {
            command.env("TWENTYONEX_DATABASE_MODE", "synthetic-only");
        }
        if fixture_mode {
            command.env("TWENTYONEX_FEASIBILITY_TEST_MODE", "1");
        }
        process_tree::configure(&mut command)
            .map_err(|_| EngineError::new("DISCONNECTED").startup("process-ownership"))?;
        let mut child = command
            .spawn()
            .map_err(|_| EngineError::new("DISCONNECTED").startup("spawn"))?;
        #[cfg(feature = "native-fixture-tests")]
        let process_id = child
            .id()
            .ok_or_else(|| EngineError::new("DISCONNECTED").startup("spawn"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| EngineError::new("DISCONNECTED").startup("stdio"))?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| EngineError::new("DISCONNECTED").startup("stdio"))?;
        // Assignment is complete before the first initialize request. The child
        // cannot start fixture/native descendants before this private handshake.
        let owned = process_tree::OwnedChild::attach(child)
            .map_err(|_| EngineError::new("DISCONNECTED").startup("process-ownership"))?;
        let (stop, stop_rx) = watch::channel(false);
        let (exited_tx, exited) = watch::channel(false);
        let engine = Self(Arc::new(Inner {
            stdin: AsyncMutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            epoch: Mutex::new(String::new()),
            next_id: AtomicU64::new(1),
            #[cfg(feature = "native-fixture-tests")]
            process_id,
            closed: AtomicBool::new(false),
            synthetic,
            #[cfg(feature = "synthetic-desktop")]
            event_sink,
            #[cfg(feature = "synthetic-desktop")]
            event_sequence: Mutex::new(0),
            queue_bytes: Arc::new(Semaphore::new(MAX_QUEUED_BYTES)),
            request_slots: Arc::new(Semaphore::new(MAX_PENDING)),
            stop,
            exited,
        }));
        let monitor = engine.clone();
        tokio::spawn(async move {
            let reaped = owned.supervise(stop_rx).await;
            monitor.disconnect(EngineError::new("DISCONNECTED"));
            let _ = exited_tx.send(reaped);
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
            return Err(error.startup("initialize"));
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
        #[cfg(feature = "synthetic-desktop")]
        if frame["kind"] == "event" {
            return self.accept_desktop_event(frame);
        }
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
            let valid = valid_result(&entry.operation, value, epoch);
            #[cfg(feature = "synthetic-desktop")]
            let valid = valid
                || (self.0.synthetic
                    && (desktop::valid_result(&entry.operation, value)
                        || desktop::valid_internal_result(&entry.operation, value)));
            if !valid {
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

    #[cfg(feature = "synthetic-desktop")]
    fn accept_desktop_event(&self, frame: Value) -> Result<(), ()> {
        if !self.0.synthetic || !desktop::valid_event_envelope(&frame) {
            return Err(());
        }
        let current = self.0.epoch.lock().unwrap().clone();
        if current.is_empty() {
            return Err(());
        }
        if frame["engineEpoch"] != current {
            return Ok(());
        }
        if !desktop::valid_event(&frame) {
            return Err(());
        }
        let sequence = frame["sequence"].as_u64().ok_or(())?;
        let mut previous = self.0.event_sequence.lock().unwrap();
        if sequence <= *previous {
            return Ok(());
        }
        if sequence != *previous + 1 {
            return Err(());
        }
        let sink = self.0.event_sink.as_ref().ok_or(())?;
        sink(frame).map_err(|_| ())?;
        *previous = sequence;
        Ok(())
    }

    #[cfg(feature = "synthetic-desktop")]
    pub async fn desktop_request(
        &self,
        epoch: &str,
        operation: &str,
        payload: Value,
    ) -> Result<Value, EngineError> {
        if !self.0.synthetic {
            return Err(EngineError::new("UNKNOWN_OPERATION"));
        }
        if !desktop::known_operation(operation) {
            return Err(EngineError::new("UNKNOWN_OPERATION"));
        }
        if !desktop::valid_request(operation, &payload) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        let current = self.0.epoch.lock().unwrap().clone();
        if current.is_empty() || epoch != current {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        let result = self.request(operation, payload).await?;
        Ok(json!({"engineEpoch": current, "result": result}))
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
            "engineEpoch": self.0.epoch.lock().unwrap().clone(), "experimental": true,
            "syntheticDesktop":self.0.synthetic,
            "ownedChildExited": *self.0.exited.borrow(), "ownershipMode": process_tree::ownership_mode()})
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
        #[cfg(feature = "native-fixture-tests")]
        "engine.fixture.start" | "engine.fixture.cooperative" => {
            result.as_object().map(|o| o.len()) == Some(2)
                && ["workerPid", "descendantPid"].iter().all(|key| {
                    result[*key]
                        .as_u64()
                        .is_some_and(|pid| pid > 0 && pid <= u32::MAX as u64)
                })
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

    struct IsolatedProfile(PathBuf);

    impl IsolatedProfile {
        fn new() -> Self {
            Self::with_prefix("21x-engine-test")
        }
        fn with_prefix(prefix: &str) -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path =
                std::env::temp_dir().join(format!("{prefix}-{}-{stamp}", std::process::id()));
            std::fs::create_dir(&path).expect("create isolated test profile");
            Self(path)
        }
    }

    impl Drop for IsolatedProfile {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn staged_engine() -> (Engine, IsolatedProfile) {
        let resources = std::env::var_os("TWENTYONEX_TEST_RESOURCES")
            .expect("ignored supervisor tests require TWENTYONEX_TEST_RESOURCES pointing at staged resources");
        let profile = IsolatedProfile::new();
        let engine = Engine::start(PathBuf::from(resources), profile.0.clone())
            .await
            .expect("start staged standalone Node 22.23.2 without native dependency probes");
        (engine, profile)
    }
    #[cfg(feature = "synthetic-desktop")]
    #[tokio::test]
    #[ignore = "requires explicitly staged database-stdio.mjs and standalone native SQLite"]
    async fn staged_synthetic_database_roundtrip_emits_real_target_events() {
        let resources = std::env::var_os("TWENTYONEX_TEST_RESOURCES")
            .expect("explicit synthetic staged resources");
        let profile = IsolatedProfile::with_prefix("21x-database-service");
        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        let received = events.clone();
        let sink: DesktopEventSink = Arc::new(move |frame| {
            received.lock().unwrap().push(frame);
            Ok(())
        });
        let engine = Engine::start_synthetic(PathBuf::from(resources), profile.0.clone(), sink)
            .await
            .unwrap();
        let epoch = engine.status()["engineEpoch"].as_str().unwrap().to_string();
        assert_eq!(engine.status()["syntheticDesktop"], true);
        assert_eq!(
            engine
                .desktop_request("stale", "db:getTasks", json!({}))
                .await
                .unwrap_err()
                .code,
            "STALE_EPOCH"
        );
        assert_eq!(
            engine
                .desktop_request(&epoch, "agentSession:approve", json!({}))
                .await
                .unwrap_err()
                .code,
            "UNKNOWN_OPERATION"
        );
        let created = engine
            .desktop_request(
                &epoch,
                "db:createTask",
                json!({"data":{"title":"native synthetic fixture"}}),
            )
            .await
            .unwrap();
        let id = created["result"]["value"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        engine
            .desktop_request(
                &epoch,
                "db:updateTask",
                json!({"id":id,"data":{"description":"edited"}}),
            )
            .await
            .unwrap();
        let fetched = engine
            .desktop_request(&epoch, "db:getTask", json!({"id":id}))
            .await
            .unwrap();
        assert_eq!(fetched["result"]["value"]["description"], "edited");
        let missing = engine
            .desktop_request(&epoch, "db:getTask", json!({"id":"missing-native-fixture"}))
            .await
            .unwrap();
        assert_eq!(missing["result"], json!({"defined":false}));
        let set = engine
            .desktop_request(
                &epoch,
                "settings:set",
                json!({"key":"synthetic_ui_value","value":"native-fixture"}),
            )
            .await
            .unwrap();
        assert_eq!(set["result"], json!({"defined":false}));
        let setting = engine
            .desktop_request(&epoch, "settings:get", json!({"key":"synthetic_ui_value"}))
            .await
            .unwrap();
        assert_eq!(setting["result"]["value"], "native-fixture");
        engine
            .desktop_request(
                &epoch,
                "project:create",
                json!({"data":{"name":"native fixture project"}}),
            )
            .await
            .unwrap();
        let projection = engine
            .request(
                "fixture.transcriptUpsert",
                json!({"taskId":id,"parts":[{
                    "id":"native-part-1","role":"assistant","content":"fixture projection"
                }]}),
            )
            .await
            .unwrap();
        assert!(projection["maxRev"].as_u64().unwrap() > 0);
        let snapshot = engine
            .desktop_request(
                &epoch,
                "agentSession:getTranscriptSnapshot",
                json!({"taskId":id}),
            )
            .await
            .unwrap();
        assert_eq!(snapshot["result"]["value"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["result"]["value"][0]["partId"], "native-part-1");
        let delta = engine
            .desktop_request(
                &epoch,
                "agentSession:getTranscriptDelta",
                json!({"taskId":id,"sinceRev":0}),
            )
            .await
            .unwrap();
        assert_eq!(
            delta["result"]["value"]["parts"][0]["content"],
            "fixture projection"
        );
        assert_eq!(delta["result"]["value"]["maxRev"], projection["maxRev"]);
        {
            let received = events.lock().unwrap();
            assert_eq!(received.len(), 5);
            for (index, operation) in [
                "task:created",
                "task:updated",
                "project:changed",
                "transcript:changed",
                "task:updated",
            ]
            .iter()
            .enumerate()
            {
                assert_eq!(received[index]["operation"], *operation);
                assert_eq!(received[index]["engineEpoch"], epoch);
                assert_eq!(received[index]["sequence"], (index + 1) as u64);
            }
        }
        engine.shutdown().await;
        assert_eq!(engine.status()["ownedChildExited"], true);
    }

    #[cfg(feature = "native-fixture-tests")]
    async fn ownership_engine() -> (Engine, IsolatedProfile) {
        let resources = std::env::var_os("TWENTYONEX_TEST_RESOURCES")
            .expect("ownership tests require explicitly staged standalone resources");
        let profile = IsolatedProfile::new();
        let engine = Engine::start_impl(PathBuf::from(resources), profile.0.clone(), true)
            .await
            .expect("initialize owned fixture engine");
        (engine, profile)
    }

    #[cfg(feature = "native-fixture-tests")]
    async fn assert_fixture_descendants_stopped(pids: &Value) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let running = ["workerPid", "descendantPid"]
                .iter()
                .any(|key| process_tree::test_process_running(pids[*key].as_u64().unwrap() as u32));
            if !running {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "owned fixture descendant survived"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    #[cfg(feature = "native-fixture-tests")]
    #[tokio::test]
    #[ignore = "requires explicitly staged standalone resources; creates only private fixture descendants"]
    async fn staged_crash_rejects_pending_work_and_terminates_owned_descendants() {
        let (engine, _profile) = ownership_engine().await;
        let pids = engine
            .request("engine.fixture.start", json!({}))
            .await
            .unwrap();
        let pending_engine = engine.clone();
        let pending = tokio::spawn(async move {
            pending_engine
                .request("engine.fixture.hang", json!({}))
                .await
        });
        tokio::time::sleep(Duration::from_millis(25)).await;
        let crash = timeout(
            Duration::from_secs(5),
            engine.request("engine.fixture.crash", json!({})),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(crash.code, "DISCONNECTED");
        assert_eq!(
            timeout(Duration::from_secs(1), pending)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err()
                .code,
            "DISCONNECTED"
        );
        engine.shutdown().await;
        assert_eq!(engine.status()["ownedChildExited"], true);
        assert_fixture_descendants_stopped(&pids).await;
        assert_eq!(
            engine
                .request("engine.ping", json!({}))
                .await
                .unwrap_err()
                .code,
            "DISCONNECTED"
        );
        assert!(engine.0.pending.lock().unwrap().is_empty());
    }

    #[cfg(feature = "native-fixture-tests")]
    #[tokio::test]
    #[ignore = "requires explicitly staged standalone resources; creates only private fixture descendants"]
    async fn staged_forced_disconnect_terminates_owned_descendants_within_bounds() {
        let (engine, _profile) = ownership_engine().await;
        let pids = engine
            .request("engine.fixture.start", json!({}))
            .await
            .unwrap();
        engine.disconnect(EngineError::new("DISCONNECTED"));
        timeout(Duration::from_secs(5), engine.shutdown())
            .await
            .unwrap();
        assert_eq!(engine.status()["ownedChildExited"], true);
        assert_fixture_descendants_stopped(&pids).await;
        assert_eq!(engine.0.request_slots.available_permits(), MAX_PENDING);
    }

    #[cfg(feature = "native-fixture-tests")]
    #[tokio::test]
    #[ignore = "private helper launched only by the abrupt-host-death test"]
    async fn staged_host_fixture_process() {
        let Some(marker) = std::env::var_os("TWENTYONEX_TEST_HOST_MARKER") else {
            return;
        };
        let marker = PathBuf::from(marker);
        let resources = std::env::var_os("TWENTYONEX_TEST_RESOURCES").unwrap();
        let engine = Engine::start_impl(
            PathBuf::from(resources),
            marker.parent().unwrap().to_path_buf(),
            true,
        )
        .await
        .unwrap();
        let operation = if cfg!(windows) {
            "engine.fixture.start"
        } else {
            "engine.fixture.cooperative"
        };
        let mut pids = engine.request(operation, json!({})).await.unwrap();
        pids["servicePid"] = json!(engine.0.process_id);
        let temporary = marker.with_extension("json.tmp");
        std::fs::write(&temporary, serde_json::to_vec(&pids).unwrap()).unwrap();
        std::fs::rename(temporary, marker).unwrap();
        tokio::time::sleep(Duration::from_secs(3600)).await;
        engine.shutdown().await;
    }

    #[cfg(feature = "native-fixture-tests")]
    #[tokio::test]
    #[ignore = "requires staged resources; kills only its private Rust fixture host"]
    async fn staged_abrupt_host_death_cleans_known_children() {
        let profile = IsolatedProfile::new();
        let marker = profile.0.join("host-pids.json");
        let mut host = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::staged_host_fixture_process",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("TWENTYONEX_TEST_HOST_MARKER", &marker)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !marker.is_file() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "private fixture host did not start"
            );
            assert!(
                host.try_wait().unwrap().is_none(),
                "private fixture host exited before marker"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let pids: Value = serde_json::from_slice(&std::fs::read(marker).unwrap()).unwrap();
        host.start_kill().unwrap();
        timeout(Duration::from_secs(3), host.wait())
            .await
            .unwrap()
            .unwrap();
        assert_fixture_descendants_stopped(&pids).await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while process_tree::test_process_running(pids["servicePid"].as_u64().unwrap() as u32) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "private service survived abrupt host death"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    #[cfg(windows)]
    #[test]
    fn canonical_windows_paths_are_converted_only_for_node() {
        assert_eq!(
            node_path(PathBuf::from(r"\\?\C:\安装\service\feasibility.mjs")).unwrap(),
            PathBuf::from(r"C:\安装\service\feasibility.mjs")
        );
        assert_eq!(
            node_path(PathBuf::from(r"\\?\UNC\server\share\service")).unwrap(),
            PathBuf::from(r"\\server\share\service")
        );
        assert_eq!(
            node_path(PathBuf::from(r"C:\ordinary\path")).unwrap(),
            PathBuf::from(r"C:\ordinary\path")
        );
        assert!(node_path(PathBuf::from(r"\\?\Volume{device}\service")).is_err());
    }

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

    #[tokio::test]
    #[ignore = "requires an explicitly staged standalone Node 22.23.2 resource directory"]
    async fn staged_initialize_ping_unknown_operation_and_shutdown() {
        let (engine, _profile) = staged_engine().await;
        let status = engine.status();
        assert_eq!(status["available"], true);
        assert!(status["engineEpoch"].as_str().unwrap().len() > 0);
        let reply = engine.request("engine.ping", json!({})).await.unwrap();
        assert_eq!(reply["engineEpoch"], status["engineEpoch"]);
        assert_eq!(reply["nodeVersion"], NODE_VERSION);
        let error = engine
            .request("engine.unknown", json!({}))
            .await
            .unwrap_err();
        assert_eq!(error.code, "UNKNOWN_OPERATION");
        assert!(engine.request("engine.ping", json!({})).await.is_ok());
        engine.shutdown().await;
        assert_eq!(engine.status()["available"], false);
        assert!(*engine.0.exited.borrow());
        assert_eq!(
            engine
                .request("engine.ping", json!({}))
                .await
                .unwrap_err()
                .code,
            "DISCONNECTED"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires an explicitly staged standalone Node 22.23.2 resource directory"]
    async fn staged_concurrent_requests_preserve_monotonic_wire_order() {
        let (engine, _profile) = staged_engine().await;
        let epoch = engine.status()["engineEpoch"].clone();
        let mut calls = Vec::new();
        for _ in 0..64 {
            let engine = engine.clone();
            calls.push(tokio::spawn(async move {
                engine.request("engine.ping", json!({})).await
            }));
        }
        for call in calls {
            let reply = call.await.unwrap().unwrap();
            assert_eq!(reply["engineEpoch"], epoch);
        }
        assert_eq!(engine.0.request_slots.available_permits(), MAX_PENDING);
        assert!(engine.0.pending.lock().unwrap().is_empty());
        engine.shutdown().await;
        assert!(*engine.0.exited.borrow());
    }

    #[tokio::test]
    #[ignore = "requires an explicitly staged standalone Node 22.23.2 resource directory"]
    async fn staged_cancel_while_waiting_for_writer_releases_capacity() {
        let (engine, _profile) = staged_engine().await;
        let writer = engine.0.stdin.lock().await;
        let queued = engine.clone();
        let call = tokio::spawn(async move { queued.request("engine.ping", json!({})).await });
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(engine.0.request_slots.available_permits(), MAX_PENDING - 1);
        call.abort();
        assert!(call.await.unwrap_err().is_cancelled());
        assert_eq!(engine.0.request_slots.available_permits(), MAX_PENDING);
        assert!(engine.0.pending.lock().unwrap().is_empty());
        drop(writer);
        assert!(engine.request("engine.ping", json!({})).await.is_ok());
        engine.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires an explicitly staged standalone Node 22.23.2 resource directory"]
    async fn staged_shutdown_settles_concurrent_calls_and_reaps_child() {
        let (engine, _profile) = staged_engine().await;
        let mut calls = Vec::new();
        for _ in 0..32 {
            let engine = engine.clone();
            calls.push(tokio::spawn(async move {
                engine.request("engine.ping", json!({})).await
            }));
        }
        timeout(Duration::from_secs(10), engine.shutdown())
            .await
            .unwrap();
        for call in calls {
            match timeout(Duration::from_secs(1), call)
                .await
                .unwrap()
                .unwrap()
            {
                Ok(reply) => assert_eq!(reply["nodeVersion"], NODE_VERSION),
                Err(error) => assert!(matches!(error.code, "DISCONNECTED" | "CANCELLED")),
            }
        }
        assert!(*engine.0.exited.borrow());
        assert!(engine.0.pending.lock().unwrap().is_empty());
        assert_eq!(engine.0.request_slots.available_permits(), MAX_PENDING);
    }
}
