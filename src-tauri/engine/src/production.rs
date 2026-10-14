//! Opt-in native production launcher. No renderer-supplied bootstrap or PID authority.
#[path = "production_contracts.rs"]
pub mod contracts;
use crate::EngineError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    future::Future,
    io::Read,
    path::{Component, Path, PathBuf},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::ChildStdin,
    sync::{oneshot, watch, Mutex as AsyncMutex, Semaphore},
    time::timeout,
};

const MAX_FRAME: usize = 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(30);
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionPaths {
    pub profile_root: PathBuf,
    pub workspace_root: PathBuf,
    pub attachment_root: PathBuf,
    pub repos_root: PathBuf,
    pub resource_root: PathBuf,
    pub temp_root: PathBuf,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum ProfileIntent {
    #[serde(rename = "create-new")]
    CreateNew,
    #[serde(rename = "load-authenticated-copy")]
    LoadAuthenticatedCopy,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum HostCapability {
    Host,
    Unsupported,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OptionalCapability {
    Enabled,
    Disabled,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionCapabilities {
    #[serde(default = "unsupported_host_capability")]
    pub workspace_files: HostCapability,
    pub external_urls: HostCapability,
    pub notifications: HostCapability,
    pub energy: HostCapability,
    pub ui: HostCapability,
    pub voice: HostCapability,
    pub configured_mcp: OptionalCapability,
    pub connectors: OptionalCapability,
    pub managed_task_mcp: OptionalCapability,
}
fn unsupported_host_capability() -> HostCapability {
    HostCapability::Unsupported
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionDescriptor {
    pub version: u8,
    pub kind: String,
    pub launch_id: String,
    pub profile_id: String,
    pub profile_intent: ProfileIntent,
    pub build_identity: String,
    pub resource_manifest_sha256: String,
    pub paths: ProductionPaths,
    pub capabilities: ProductionCapabilities,
}
pub type HostFuture<T> = Pin<Box<dyn Future<Output = Result<T, EngineError>> + Send>>;
pub struct ProductionWorkspaceHost {
    pub invoke: Arc<dyn Fn(bool, Value) -> HostFuture<()> + Send + Sync>,
    pub close: Arc<dyn Fn() -> HostFuture<()> + Send + Sync>,
}
pub struct ProductionNativeHost {
    pub workspace_file: Option<ProductionWorkspaceHost>,
    pub event_sink: Arc<dyn Fn(Value) -> Result<(), EngineError> + Send + Sync>,
    pub open_external: Option<Arc<dyn Fn(String) -> HostFuture<()> + Send + Sync>>,
    pub notification: Option<Arc<dyn Fn(String, String) -> HostFuture<bool> + Send + Sync>>,
}
/// Obtained by the trusted host, never deserialize this lease from an RPC.
pub struct TrustedProductionLaunch {
    pub descriptor: ProductionDescriptor,
    pub containment: DelegatedCgroup,
}
pub struct DelegatedCgroup {
    #[cfg(target_os = "linux")]
    root: File,
}
impl DelegatedCgroup {
    pub fn open(path: &Path) -> Result<Self, EngineError> {
        #[cfg(target_os = "linux")]
        {
            return linux::open_delegation(path).map(|root| Self { root });
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = path;
            Err(problem(
                "PRODUCTION_CONTAINMENT_UNAVAILABLE",
                if cfg!(windows) {
                    "production-windows-private-fd3-unavailable"
                } else {
                    "production-detached-descendant-containment-unavailable"
                },
            ))
        }
    }
}
fn problem(code: &'static str, phase: &'static str) -> EngineError {
    EngineError::new(code).startup(phase)
}
fn token(value: &str, min: usize, max: usize, dot: bool) -> bool {
    value.len() >= min
        && value.len() <= max
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-') || dot && c == b'.')
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn descriptor_bytes(value: &ProductionDescriptor) -> Result<Vec<u8>, EngineError> {
    let capabilities = &value.capabilities;
    if value.version != 1
        || value.kind != "production-private-launch"
        || !token(&value.launch_id, 16, 128, false)
        || !token(&value.profile_id, 1, 128, true)
        || !token(&value.build_identity, 1, 128, true)
        || !digest(&value.resource_manifest_sha256)
        || capabilities.energy != HostCapability::Unsupported
        || capabilities.ui != HostCapability::Unsupported
        || capabilities.voice != HostCapability::Unsupported
        || [
            &value.paths.profile_root,
            &value.paths.workspace_root,
            &value.paths.attachment_root,
            &value.paths.repos_root,
            &value.paths.resource_root,
            &value.paths.temp_root,
        ]
        .iter()
        .any(|p| {
            !p.is_absolute()
                || p.to_str().is_none_or(|s| {
                    s.len() > 4096
                        || s.contains('\0')
                        || s.split(['/', '\\']).any(|part| matches!(part, "." | ".."))
                })
        })
    {
        return Err(problem("INVALID_ARGUMENTS", "production-descriptor"));
    }
    let bytes = serde_json::to_vec(value)
        .map_err(|_| problem("INVALID_ARGUMENTS", "production-descriptor"))?;
    if bytes.len() > 32768 {
        return Err(problem("FRAME_TOO_LARGE", "production-descriptor"));
    }
    Ok(bytes)
}
fn physical(root: &Path, name: &str) -> Result<PathBuf, EngineError> {
    let path = Path::new(name);
    if path
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
        || name.contains('\\')
        || name.is_empty()
    {
        return Err(problem(
            "INVALID_ARGUMENTS",
            "production-resource-containment",
        ));
    }
    let mut current = root.to_owned();
    for part in path.components() {
        current.push(part);
        let stat = std::fs::symlink_metadata(&current)
            .map_err(|_| problem("DISCONNECTED", "production-resource-files"))?;
        if stat.file_type().is_symlink() {
            return Err(problem("INVALID_ARGUMENTS", "production-resource-links"));
        }
    }
    if !current.is_file() || !std::fs::canonicalize(&current).is_ok_and(|p| p.starts_with(root)) {
        return Err(problem(
            "INVALID_ARGUMENTS",
            "production-resource-containment",
        ));
    }
    Ok(current)
}
fn future_path(path: &Path) -> Result<PathBuf, EngineError> {
    match std::fs::canonicalize(path) {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .ok_or_else(|| problem("INVALID_ARGUMENTS", "production-write-path"))?;
            Ok(future_path(parent)?.join(
                path.file_name()
                    .ok_or_else(|| problem("INVALID_ARGUMENTS", "production-write-path"))?,
            ))
        }
        Err(_) => Err(problem("INVALID_ARGUMENTS", "production-write-path")),
    }
}
fn file_hash(path: &Path) -> Result<(String, u64), EngineError> {
    let mut file =
        File::open(path).map_err(|_| problem("DISCONNECTED", "production-resource-files"))?;
    let mut hash = Sha256::new();
    let mut bytes = 0;
    let mut chunk = [0u8; 65536];
    loop {
        let count = file
            .read(&mut chunk)
            .map_err(|_| problem("DISCONNECTED", "production-resource-files"))?;
        if count == 0 {
            break;
        }
        hash.update(&chunk[..count]);
        bytes += count as u64;
    }
    Ok((format!("{:x}", hash.finalize()), bytes))
}
struct Resources {
    node: PathBuf,
    stdio: PathBuf,
    root: PathBuf,
}
fn resources(value: &ProductionDescriptor) -> Result<Resources, EngineError> {
    descriptor_bytes(value)?;
    let root = std::fs::canonicalize(&value.paths.resource_root)
        .map_err(|_| problem("DISCONNECTED", "production-resource-root"))?;
    if std::fs::symlink_metadata(&value.paths.resource_root)
        .map_err(|_| problem("DISCONNECTED", "production-resource-root"))?
        .file_type()
        .is_symlink()
    {
        return Err(problem("INVALID_ARGUMENTS", "production-resource-links"));
    }
    for path in [
        &value.paths.profile_root,
        &value.paths.workspace_root,
        &value.paths.attachment_root,
        &value.paths.repos_root,
        &value.paths.temp_root,
    ] {
        let path = future_path(path)?;
        if path.starts_with(&root) || root.starts_with(&path) {
            return Err(problem(
                "INVALID_ARGUMENTS",
                "production-profile-resource-overlap",
            ));
        }
    }
    let manifest = physical(&root, "service/PRODUCTION_RESOURCE_MANIFEST.json")?;
    let (hash, size) = file_hash(&manifest)?;
    if size > 32 * 1024 * 1024 || hash != value.resource_manifest_sha256 {
        return Err(problem("INVALID_RESULT", "production-manifest-digest"));
    }
    let manifest: Value = serde_json::from_reader(
        File::open(manifest).map_err(|_| problem("DISCONNECTED", "production-manifest"))?,
    )
    .map_err(|_| problem("INVALID_RESULT", "production-manifest"))?;
    if !contracts::object(
        &manifest,
        &[
            "version",
            "kind",
            "buildIdentity",
            "nodeVersion",
            "platform",
            "arch",
            "entries",
            "packages",
            "files",
            "redistributionReviewComplete",
        ],
        &[],
    ) || manifest["version"] != 1
        || manifest["kind"] != "production-resource-closure"
        || manifest["buildIdentity"] != value.build_identity
        || manifest["nodeVersion"] != "22.23.2"
        || manifest["redistributionReviewComplete"] != false
    {
        return Err(problem("INVALID_RESULT", "production-manifest"));
    }
    let entries = &manifest["entries"];
    let node = if cfg!(windows) {
        "node/node.exe"
    } else {
        "node/node"
    };
    let helper = if cfg!(windows) {
        "native/twentyonex-credential-key.exe"
    } else {
        "native/twentyonex-credential-key"
    };
    if !contracts::object(
        entries,
        &["node", "stdio", "engine", "credentialHelper", "taskMcp"],
        &["mobile", "voiceWorker", "voiceTtsWorker"],
    ) || entries["node"] != node
        || entries["stdio"] != "service/production-stdio.mjs"
        || entries["engine"] != "service/production-engine.mjs"
        || entries["credentialHelper"] != helper
        || entries["taskMcp"] != "service/production-task-mcp.mjs"
        || entries
            .get("mobile")
            .is_some_and(|value| value != "mobile/index.html")
        || entries.get("voiceWorker").is_some() != entries.get("voiceTtsWorker").is_some()
        || entries
            .get("voiceWorker")
            .is_some_and(|value| value != "service/voice-worker.cjs")
        || entries
            .get("voiceTtsWorker")
            .is_some_and(|value| value != "service/voice-tts-worker.cjs")
    {
        return Err(problem("INVALID_RESULT", "production-resource-entries"));
    }
    let files = manifest["files"]
        .as_object()
        .ok_or_else(|| problem("INVALID_RESULT", "production-resource-closure"))?;
    if files.len() > 100000 {
        return Err(problem("FRAME_TOO_LARGE", "production-resource-closure"));
    }
    for (name, signature) in files {
        if !contracts::object(signature, &["sha256", "bytes"], &[]) {
            return Err(problem("INVALID_RESULT", "production-resource-signature"));
        }
        let (hash, bytes) = file_hash(&physical(&root, name)?)?;
        if signature["sha256"] != hash || signature["bytes"].as_u64() != Some(bytes) {
            return Err(problem("INVALID_RESULT", "production-resource-bytes"));
        }
    }
    for name in [
        node,
        "service/production-stdio.mjs",
        "service/production-engine.mjs",
        helper,
        "service/production-task-mcp.mjs",
        "service/.native-prepared.json",
    ] {
        if !files.contains_key(name) {
            return Err(problem("INVALID_RESULT", "production-resource-closure"));
        }
    }
    if entries.get("mobile").is_some() && !files.contains_key("mobile/index.html") {
        return Err(problem(
            "INVALID_RESULT",
            "production-mobile-resource-closure",
        ));
    }
    if entries.get("voiceWorker").is_some()
        && (!files.contains_key("service/voice-worker.cjs")
            || !files.contains_key("service/voice-tts-worker.cjs"))
    {
        return Err(problem(
            "INVALID_RESULT",
            "production-voice-resource-closure",
        ));
    }
    // The already authenticated thin Node gate additionally verifies actual
    // runtime ABI/platform/pins and the complete unmanifested-package closure.
    Ok(Resources {
        node: physical(&root, node)?,
        stdio: physical(&root, "service/production-stdio.mjs")?,
        root,
    })
}

struct Pending {
    operation: String,
    sender: oneshot::Sender<Result<Value, EngineError>>,
}
struct Inner {
    stdin: AsyncMutex<ChildStdin>,
    pending: Mutex<HashMap<String, Pending>>,
    epoch: Mutex<String>,
    next: AtomicU64,
    closed: AtomicBool,
    ready: AtomicBool,
    stopping: AtomicBool,
    prepared: AtomicBool,
    drained: AtomicBool,
    last_callback: Mutex<u128>,
    last_event: Mutex<u64>,
    request_slots: Arc<Semaphore>,
    queue_bytes: Arc<Semaphore>,
    callback_slots: Arc<Semaphore>,
    callback_work: AtomicU64,
    stop: watch::Sender<bool>,
    exited: watch::Receiver<bool>,
    descriptor: ProductionDescriptor,
    host: ProductionNativeHost,
    #[cfg(target_os = "linux")]
    scope: Arc<linux::Scope>,
}
#[derive(Clone)]
pub struct ProductionEngine(Arc<Inner>);
struct RequestGuard {
    engine: ProductionEngine,
    id: String,
    started: bool,
    written: bool,
    complete: bool,
}
impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.engine.0.pending.lock().unwrap().remove(&self.id);
        if self.complete {
            return;
        }
        if self.started && !self.written {
            self.engine.disconnect();
        } else if self.written && !self.engine.0.closed.load(Ordering::SeqCst) {
            let engine = self.engine.clone();
            let id = self.id.clone();
            tokio::spawn(async move {
                let epoch = engine.epoch();
                let _=engine.write(&json!({"kind":"event","protocolVersion":1,"engineEpoch":epoch,"operation":"engine.cancel","payload":{"requestId":id}})).await;
            });
        }
    }
}
struct StartupGuard(ProductionEngine, bool);
impl Drop for StartupGuard {
    fn drop(&mut self) {
        if !self.1 {
            self.0.disconnect();
        }
    }
}
impl ProductionEngine {
    pub async fn start(
        launch: TrustedProductionLaunch,
        host: ProductionNativeHost,
    ) -> Result<Self, EngineError> {
        descriptor_bytes(&launch.descriptor)?;
        if (launch.descriptor.capabilities.external_urls == HostCapability::Host
            && host.open_external.is_none())
            || (launch.descriptor.capabilities.notifications == HostCapability::Host
                && host.notification.is_none())
            || (launch.descriptor.capabilities.workspace_files == HostCapability::Host
                && host.workspace_file.is_none())
        {
            return Err(problem(
                "INVALID_ARGUMENTS",
                "production-native-capabilities",
            ));
        }
        #[cfg(target_os = "linux")]
        {
            return Self::launch_linux(launch, host).await;
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (launch, host);
            Err(problem(
                "PRODUCTION_CONTAINMENT_UNAVAILABLE",
                if cfg!(windows) {
                    "production-windows-private-fd3-unavailable"
                } else {
                    "production-detached-descendant-containment-unavailable"
                },
            ))
        }
    }
    pub fn epoch(&self) -> String {
        self.0.epoch.lock().unwrap().clone()
    }
    pub fn snapshot(&self) -> Value {
        json!({"production":true,"engineEpoch":self.epoch(),"available":self.0.ready.load(Ordering::SeqCst)&&!self.0.closed.load(Ordering::SeqCst)&&!self.0.stopping.load(Ordering::SeqCst),"prepared":self.0.prepared.load(Ordering::SeqCst),"nativeDrainAcknowledged":self.0.drained.load(Ordering::SeqCst),"ownedTreeExited":*self.0.exited.borrow(),"nativeCallbacks":self.0.callback_work.load(Ordering::SeqCst),"containment":"linux-delegated-cgroup-v2-with-private-guardian"})
    }
    /// Caller identity/frame validation belongs to the trusted native ingress.
    pub async fn invoke(
        &self,
        epoch: &str,
        operation: &str,
        payload: Value,
    ) -> Result<Value, EngineError> {
        if !contracts::COMMANDS.contains(&operation) {
            return Err(EngineError::new("UNKNOWN_OPERATION"));
        }
        if !contracts::valid_request(operation, &payload) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        if epoch != self.epoch() {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        if !self.0.ready.load(Ordering::SeqCst) || self.0.stopping.load(Ordering::SeqCst) {
            return Err(EngineError::new("DISCONNECTED"));
        }
        self.request(operation, payload).await
    }
    async fn write(&self, frame: &Value) -> Result<(), EngineError> {
        let mut bytes =
            serde_json::to_vec(frame).map_err(|_| EngineError::new("INVALID_ARGUMENTS"))?;
        if bytes.len() > MAX_FRAME {
            return Err(EngineError::new("FRAME_TOO_LARGE"));
        }
        bytes.push(b'\n');
        let _permit = self
            .0
            .queue_bytes
            .clone()
            .try_acquire_many_owned(bytes.len() as u32)
            .map_err(|_| EngineError::new("BACKPRESSURE"))?;
        let mut pipe = self.0.stdin.lock().await;
        if self.0.closed.load(Ordering::SeqCst) {
            return Err(EngineError::new("DISCONNECTED"));
        }
        pipe.write_all(&bytes)
            .await
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        pipe.flush()
            .await
            .map_err(|_| EngineError::new("DISCONNECTED"))
    }
    async fn request(&self, operation: &str, payload: Value) -> Result<Value, EngineError> {
        timeout(DEADLINE, self.request_raw(operation, payload))
            .await
            .unwrap_or_else(|_| Err(EngineError::new("TIMEOUT")))
    }
    async fn request_raw(&self, operation: &str, payload: Value) -> Result<Value, EngineError> {
        let _slot = self
            .0
            .request_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| EngineError::new("BACKPRESSURE"))?;
        let estimate=serde_json::to_vec(&json!({"kind":"request","protocolVersion":1,"engineEpoch":self.epoch(),"requestId":"host:99999999999999999999999999999999","operation":operation,"payload":payload})).map_err(|_|EngineError::new("INVALID_ARGUMENTS"))?.len()+1;
        if estimate > MAX_FRAME {
            return Err(EngineError::new("FRAME_TOO_LARGE"));
        }
        let _queued = self
            .0
            .queue_bytes
            .clone()
            .try_acquire_many_owned(estimate as u32)
            .map_err(|_| EngineError::new("BACKPRESSURE"))?;
        let mut pipe = self.0.stdin.lock().await;
        if self.0.closed.load(Ordering::SeqCst) {
            return Err(EngineError::new("DISCONNECTED"));
        }
        // Allocation/order share the writer lock; a later concurrent request
        // cannot precede an earlier ID on the private pipe.
        let id = format!("host:{}", self.0.next.fetch_add(1, Ordering::SeqCst));
        let epoch = self.epoch();
        let mut bytes=serde_json::to_vec(&json!({"kind":"request","protocolVersion":1,"engineEpoch":epoch,"requestId":id,"operation":operation,"payload":payload})).map_err(|_|EngineError::new("INVALID_ARGUMENTS"))?;
        if bytes.len() > MAX_FRAME {
            return Err(EngineError::new("FRAME_TOO_LARGE"));
        }
        bytes.push(b'\n');
        let (sender, receiver) = oneshot::channel();
        self.0.pending.lock().unwrap().insert(
            id.clone(),
            Pending {
                operation: operation.to_owned(),
                sender,
            },
        );
        let mut guard = RequestGuard {
            engine: self.clone(),
            id,
            started: true,
            written: false,
            complete: false,
        };
        if pipe.write_all(&bytes).await.is_err() || pipe.flush().await.is_err() {
            self.disconnect();
            return Err(EngineError::new("DISCONNECTED"));
        }
        guard.written = true;
        drop(pipe);
        drop(_queued);
        let result = receiver
            .await
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        guard.complete = true;
        result
    }
    fn disconnect(&self) {
        if self.0.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.0.ready.store(false, Ordering::SeqCst);
        let _ = self.0.stop.send(true);
        for (_, pending) in self.0.pending.lock().unwrap().drain() {
            let _ = pending.sender.send(Err(EngineError::new("DISCONNECTED")));
        }
    }
    async fn accept(&self, frame: Value) -> Result<(), EngineError> {
        if frame["protocolVersion"] != 1 {
            return Err(EngineError::new("INVALID_FRAME"));
        }
        let epoch = frame["engineEpoch"]
            .as_str()
            .filter(|s| token(s, 1, 128, false))
            .ok_or_else(|| EngineError::new("INVALID_FRAME"))?;
        let current = self.epoch();
        match frame["kind"].as_str() {
            Some("response") => {
                if !contracts::object(
                    &frame,
                    &["kind", "protocolVersion", "engineEpoch", "requestId"],
                    &["result", "error"],
                ) || frame.get("result").is_some() == frame.get("error").is_some()
                {
                    return Err(EngineError::new("INVALID_FRAME"));
                }
                let id = frame["requestId"]
                    .as_str()
                    .ok_or_else(|| EngineError::new("INVALID_FRAME"))?;
                if request_id(id, "host:").is_none() {
                    return Err(EngineError::new("INVALID_FRAME"));
                }
                if !current.is_empty() && current != epoch {
                    return Err(EngineError::new("STALE_EPOCH"));
                }
                let Some(pending) = self.0.pending.lock().unwrap().remove(id) else {
                    return Ok(());
                };
                let result = if let Some(error) = frame.get("error") {
                    crate::validate_error(error)
                        .map(Err)
                        .map_err(|_| EngineError::new("INVALID_FRAME"))?
                } else {
                    let result = &frame["result"];
                    let valid = match pending.operation.as_str() {
                        "engine.ping" | "engine.initialize" => {
                            contracts::object(
                                result,
                                &["protocolVersion", "engineEpoch", "nodeVersion"],
                                &[],
                            ) && result["protocolVersion"] == 1
                                && result["engineEpoch"] == epoch
                                && result["nodeVersion"] == "v22.23.2"
                        }
                        "engine.shutdown" => result == &json!({"stopped":true}),
                        operation => contracts::valid_result(operation, result),
                    };
                    if !valid {
                        let _ = pending.sender.send(Err(EngineError::new("INVALID_RESULT")));
                        return Err(EngineError::new("INVALID_RESULT"));
                    }
                    if current.is_empty() {
                        if pending.operation != "engine.ping" {
                            return Err(EngineError::new("INVALID_FRAME"));
                        }
                        *self.0.epoch.lock().unwrap() = epoch.to_owned();
                    }
                    Ok(result.clone())
                };
                let _ = pending.sender.send(result);
                Ok(())
            }
            Some("event") => {
                if frame["operation"] == "engine.cancel" {
                    if current.is_empty()
                        || current != epoch
                        || !contracts::object(
                            &frame,
                            &[
                                "kind",
                                "protocolVersion",
                                "engineEpoch",
                                "operation",
                                "payload",
                            ],
                            &[],
                        )
                        || !contracts::object(&frame["payload"], &["requestId"], &[])
                        || frame["payload"]["requestId"]
                            .as_str()
                            .and_then(|id| request_id(id, "service:"))
                            .is_none()
                    {
                        return Err(EngineError::new("INVALID_FRAME"));
                    }
                    // Stop no raw native effect on a cancellation receipt. Its
                    // callback work stays retained until the actual future ends.
                    return Ok(());
                }
                if !contracts::object(
                    &frame,
                    &[
                        "kind",
                        "protocolVersion",
                        "engineEpoch",
                        "operation",
                        "payload",
                        "sequence",
                    ],
                    &[],
                ) || current.is_empty()
                    || current != epoch
                {
                    return Err(EngineError::new("INVALID_FRAME"));
                }
                let operation = frame["operation"]
                    .as_str()
                    .ok_or_else(|| EngineError::new("INVALID_FRAME"))?;
                let sequence = frame["sequence"]
                    .as_u64()
                    .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
                    .ok_or_else(|| EngineError::new("INVALID_FRAME"))?;
                let mut previous = self.0.last_event.lock().unwrap();
                if sequence <= *previous || !contracts::valid_event(operation, &frame["payload"]) {
                    return Err(EngineError::new("INVALID_RESULT"));
                }
                (self.0.host.event_sink)(frame.clone())?;
                *previous = sequence;
                Ok(())
            }
            Some("request") => {
                if !contracts::object(
                    &frame,
                    &[
                        "kind",
                        "protocolVersion",
                        "engineEpoch",
                        "requestId",
                        "operation",
                        "payload",
                    ],
                    &[],
                ) || current.is_empty()
                    || current != epoch
                {
                    return Err(EngineError::new("INVALID_FRAME"));
                }
                let id = frame["requestId"]
                    .as_str()
                    .ok_or_else(|| EngineError::new("INVALID_FRAME"))?
                    .to_owned();
                let number =
                    request_id(&id, "service:").ok_or_else(|| EngineError::new("INVALID_FRAME"))?;
                {
                    let mut last = self.0.last_callback.lock().unwrap();
                    if number <= *last {
                        return Err(EngineError::new("INVALID_REQUEST"));
                    }
                    *last = number;
                }
                let slot = self
                    .0
                    .callback_slots
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| EngineError::new("BACKPRESSURE"))?;
                self.0.callback_work.fetch_add(1, Ordering::SeqCst);
                let engine = self.clone();
                tokio::spawn(async move {
                    let answer = engine.callback(&frame).await;
                    let result = match answer {
                        Ok(result) => {
                            json!({"kind":"response","protocolVersion":1,"engineEpoch":engine.epoch(),"requestId":id,"result":result})
                        }
                        Err(error) => {
                            let code = if matches!(
                                error.code,
                                "INVALID_ARGUMENTS"
                                    | "UNKNOWN_OPERATION"
                                    | "CANCELLED"
                                    | "TIMEOUT"
                                    | "DISCONNECTED"
                            ) {
                                error.code
                            } else {
                                "INTERNAL_ERROR"
                            };
                            json!({"kind":"response","protocolVersion":1,"engineEpoch":engine.epoch(),"requestId":id,"error":{"code":code,"message":EngineError::new(code).message}})
                        }
                    };
                    if engine.write(&result).await.is_err() {
                        engine.disconnect();
                    }
                    engine.0.callback_work.fetch_sub(1, Ordering::SeqCst);
                    drop(slot);
                });
                Ok(())
            }
            _ => Err(EngineError::new("INVALID_FRAME")),
        }
    }
    async fn callback(&self, frame: &Value) -> Result<Value, EngineError> {
        let payload = &frame["payload"];
        let operation = frame["operation"].as_str().unwrap_or("");
        match operation {
            "host.production.prepare" => {
                if !contracts::object(payload, &["launchId", "resourceManifestSha256"], &[])
                    || payload["launchId"] != self.0.descriptor.launch_id
                    || payload["resourceManifestSha256"]
                        != self.0.descriptor.resource_manifest_sha256
                {
                    return Err(EngineError::new("INVALID_ARGUMENTS"));
                }
                #[cfg(target_os = "linux")]
                self.0.scope.prove_ready()?;
                #[cfg(not(target_os = "linux"))]
                return Err(EngineError::new("PRODUCTION_CONTAINMENT_UNAVAILABLE"));
                self.0.prepared.store(true, Ordering::SeqCst);
                Ok(
                    json!({"launchId":self.0.descriptor.launch_id,"ready":true,"processTree":"supervised"}),
                )
            }
            "host.production.drain" => {
                if !contracts::object(payload, &["launchId"], &[])
                    || payload["launchId"] != self.0.descriptor.launch_id
                {
                    return Err(EngineError::new("INVALID_ARGUMENTS"));
                }
                self.0.stopping.store(true, Ordering::SeqCst);
                timeout(Duration::from_secs(3), async {
                    while self.0.callback_work.load(Ordering::SeqCst) > 1 {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .map_err(|_| {
                    problem(
                        "PRODUCTION_DRAIN_BLOCKED",
                        "production-native-callback-drain",
                    )
                })?;
                if let Some(files) = &self.0.host.workspace_file {
                    (files.close)().await?;
                }
                #[cfg(target_os = "linux")]
                self.0.scope.await_leader_only().await?;
                #[cfg(not(target_os = "linux"))]
                return Err(EngineError::new("PRODUCTION_CONTAINMENT_UNAVAILABLE"));
                self.0.drained.store(true, Ordering::SeqCst);
                Ok(json!({"launchId":self.0.descriptor.launch_id,"acknowledged":true}))
            }
            "host.workspace.openPath" | "host.workspace.showItemInFolder" => {
                if self.0.descriptor.capabilities.workspace_files != HostCapability::Host {
                    return Err(EngineError::new("UNKNOWN_OPERATION"));
                }
                if !contracts::object(payload, &["receipt"], &[]) {
                    return Err(EngineError::new("INVALID_ARGUMENTS"));
                }
                crate::production_files::NativeWorkspaceReceipt::from_value(&payload["receipt"])
                    .map_err(|_| EngineError::new("INVALID_ARGUMENTS"))?;
                let files = self
                    .0
                    .host
                    .workspace_file
                    .as_ref()
                    .ok_or_else(|| EngineError::new("UNKNOWN_OPERATION"))?;
                (files.invoke)(
                    operation == "host.workspace.showItemInFolder",
                    payload["receipt"].clone(),
                )
                .await?;
                Ok(json!({}))
            }
            "host.shell.openExternal" => {
                if self.0.descriptor.capabilities.external_urls != HostCapability::Host
                    || !contracts::object(payload, &["url"], &[])
                    || !contracts::text(&payload["url"], 8192)
                {
                    return Err(EngineError::new("UNKNOWN_OPERATION"));
                }
                let url = payload["url"].as_str().unwrap();
                if url.bytes().any(|b| b <= 0x20 || b == 0x7f || b == b'\\')
                    || !url::Url::parse(url).is_ok_and(|u| {
                        matches!(u.scheme(), "http" | "https" | "mailto")
                            && (u.host().is_some()
                                || u.scheme() == "mailto" && !u.path().is_empty())
                            && u.username().is_empty()
                            && u.password().is_none()
                    })
                {
                    return Err(EngineError::new("INVALID_ARGUMENTS"));
                }
                self.0
                    .host
                    .open_external
                    .as_ref()
                    .ok_or_else(|| EngineError::new("UNKNOWN_OPERATION"))?(
                    url.to_owned()
                )
                .await?;
                Ok(json!({"opened":true}))
            }
            "host.notification.show" => {
                if self.0.descriptor.capabilities.notifications != HostCapability::Host
                    || !contracts::object(payload, &["title", "body"], &[])
                    || !contracts::text(&payload["title"], 160)
                    || payload["title"] == ""
                    || !contracts::text(&payload["body"], 2048)
                {
                    return Err(EngineError::new("INVALID_ARGUMENTS"));
                }
                let shown = self
                    .0
                    .host
                    .notification
                    .as_ref()
                    .ok_or_else(|| EngineError::new("UNKNOWN_OPERATION"))?(
                    payload["title"].as_str().unwrap().to_owned(),
                    payload["body"].as_str().unwrap().to_owned(),
                )
                .await?;
                Ok(json!({"shown":shown}))
            }
            _ => Err(EngineError::new("UNKNOWN_OPERATION")),
        }
    }
    pub async fn shutdown(&self) -> Result<(), EngineError> {
        self.0.stopping.store(true, Ordering::SeqCst);
        if !self.0.closed.load(Ordering::SeqCst) {
            self.request("engine.shutdown", json!({})).await?;
        }
        if !self.0.drained.load(Ordering::SeqCst) {
            return Err(problem(
                "PRODUCTION_DRAIN_UNACKNOWLEDGED",
                "production-native-drain",
            ));
        }
        self.wait_exited().await
    }
    /// Trusted application-exit escalation only. Kills the bound scope, never
    /// fabricates a service drain ACK or authorizes an arbitrary process.
    pub async fn terminate_owned(&self) -> Result<(), EngineError> {
        self.disconnect();
        self.wait_exited().await
    }
    async fn wait_exited(&self) -> Result<(), EngineError> {
        let mut exited = self.0.exited.clone();
        timeout(Duration::from_secs(5), async {
            while !*exited.borrow() {
                exited
                    .changed()
                    .await
                    .map_err(|_| EngineError::new("DISCONNECTED"))?;
            }
            while self.0.callback_work.load(Ordering::SeqCst) > 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Ok(())
        })
        .await
        .unwrap_or_else(|_| {
            Err(problem(
                "PRODUCTION_DRAIN_BLOCKED",
                "production-owned-tree-reap",
            ))
        })
    }
}
fn request_id(value: &str, prefix: &str) -> Option<u128> {
    let digits = value.strip_prefix(prefix)?;
    if digits.is_empty()
        || digits.len() > 32
        || digits.starts_with('0')
        || !digits.bytes().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    digits.parse().ok()
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::{
        ffi::CString,
        io::Write,
        os::{
            fd::{AsRawFd, FromRawFd, RawFd},
            unix::{fs::OpenOptionsExt, process::CommandExt},
        },
        process::Stdio,
    };
    use tokio::process::Command;

    fn failure() -> EngineError {
        problem(
            "PRODUCTION_CONTAINMENT_UNAVAILABLE",
            "production-delegated-cgroup-v2",
        )
    }
    fn openat(root: RawFd, name: &str, flags: i32) -> Result<File, EngineError> {
        let name = CString::new(name).map_err(|_| failure())?;
        let fd = unsafe {
            libc::openat(
                root,
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(failure());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    pub(super) fn open_delegation(path: &Path) -> Result<File, EngineError> {
        if !path.is_absolute() {
            return Err(failure());
        }
        let root = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| failure())?;
        let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
        if unsafe { libc::fstatfs(root.as_raw_fd(), stat.as_mut_ptr()) } != 0
            || unsafe { stat.assume_init() }.f_type != 0x63677270
        {
            return Err(failure());
        }
        // An actual delegated cgroup-v2 interface is required; ordinary temp
        // directories, process-group handles and supplied process IDs reject.
        openat(root.as_raw_fd(), "cgroup.procs", libc::O_RDONLY)?;
        openat(root.as_raw_fd(), "cgroup.controllers", libc::O_RDONLY)?;
        Ok(root)
    }
    fn pipe() -> Result<(File, File), EngineError> {
        let mut fds = [-1i32; 2];
        if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
            return Err(failure());
        }
        Ok(unsafe { (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) })
    }
    fn duplicate(fd: RawFd) -> Result<File, EngineError> {
        let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) };
        if duplicate < 0 {
            return Err(failure());
        }
        Ok(unsafe { File::from_raw_fd(duplicate) })
    }
    fn alive(pid: u32) -> Result<bool, EngineError> {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        if unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT | libc::WNOHANG,
            )
        } != 0
        {
            return Err(failure());
        }
        Ok(unsafe { info.assume_init() }.si_signo != libc::SIGCHLD)
    }
    fn readat(dir: &File, name: &str) -> Result<String, EngineError> {
        let mut text = String::new();
        openat(dir.as_raw_fd(), name, libc::O_RDONLY)?
            .take(65537)
            .read_to_string(&mut text)
            .map_err(|_| failure())?;
        if text.len() > 65536 {
            return Err(failure());
        }
        Ok(text)
    }
    fn population(dir: &File) -> Result<bool, EngineError> {
        let events = readat(dir, "cgroup.events")?;
        match events
            .lines()
            .find_map(|line| line.strip_prefix("populated "))
        {
            Some("0") => Ok(false),
            Some("1") => Ok(true),
            _ => Err(failure()),
        }
    }
    fn members(dir: &File, depth: usize) -> Result<Vec<u32>, EngineError> {
        if depth > 64 {
            return Err(failure());
        }
        let mut result = readat(dir, "cgroup.procs")?
            .lines()
            .map(|line| line.parse::<u32>().map_err(|_| failure()))
            .collect::<Result<Vec<_>, _>>()?;
        if result.len() > 65536 {
            return Err(failure());
        }
        // /proc/self/fd addresses the already held exact kernel directory.
        // Nested groups are queried through O_NOFOLLOW openat, not name/PID grants.
        for entry in std::fs::read_dir(format!("/proc/self/fd/{}", dir.as_raw_fd()))
            .map_err(|_| failure())?
        {
            let entry = entry.map_err(|_| failure())?;
            let kind = entry.file_type().map_err(|_| failure())?;
            if kind.is_symlink() {
                return Err(failure());
            }
            if kind.is_dir() {
                let name = entry.file_name();
                let name = name.to_str().ok_or_else(failure)?;
                let child = openat(dir.as_raw_fd(), name, libc::O_RDONLY | libc::O_DIRECTORY)?;
                result.extend(members(&child, depth + 1)?);
            }
            if result.len() > 65536 {
                return Err(failure());
            }
        }
        Ok(result)
    }
    pub(super) struct Scope {
        root: File,
        directory: File,
        name: CString,
        kill: Mutex<File>,
        guardian_writer: Mutex<Option<File>>,
        guardian: u32,
        pub(super) leader: AtomicU64,
        guardian_reaped: AtomicBool,
        released: AtomicBool,
    }
    struct CreatedDirectory {
        root: File,
        name: CString,
        transferred: bool,
    }
    impl Drop for CreatedDirectory {
        fn drop(&mut self) {
            if !self.transferred {
                unsafe {
                    libc::unlinkat(
                        self.root.as_raw_fd(),
                        self.name.as_ptr(),
                        libc::AT_REMOVEDIR,
                    );
                }
            }
        }
    }
    struct ScopeStartupGuard(Arc<Scope>, bool);
    impl Drop for ScopeStartupGuard {
        fn drop(&mut self) {
            if !self.1 {
                let scope = self.0.clone();
                tokio::spawn(async move {
                    loop {
                        if scope.finish().await.is_ok() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                });
            }
        }
    }
    impl Scope {
        fn create(root: File, launch: &str) -> Result<Arc<Self>, EngineError> {
            let name = CString::new(format!("21x-{launch}")).map_err(|_| failure())?;
            if unsafe { libc::mkdirat(root.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
                return Err(failure());
            }
            let mut created = CreatedDirectory {
                root: root.try_clone().map_err(|_| failure())?,
                name: name.clone(),
                transferred: false,
            };
            let directory = openat(
                root.as_raw_fd(),
                name.to_str().map_err(|_| failure())?,
                libc::O_DIRECTORY | libc::O_RDONLY,
            )?;
            let mut kill = openat(directory.as_raw_fd(), "cgroup.kill", libc::O_WRONLY)?;
            if population(&directory)? {
                return Err(failure());
            }
            // Prove the actual kill interface works while this new scope is empty.
            kill.write_all(b"1\n").map_err(|_| failure())?;
            let (parent_read, parent_write) = pipe()?;
            let parent_write = duplicate(parent_write.as_raw_fd())?;
            let (mut ready_read, ready_write) = pipe()?;
            // Precompute all descriptors; the fork child uses only syscalls.
            // Sources >=10 cannot be clobbered by dup2's fixed private 3/4/5.
            let parent_read = duplicate(parent_read.as_raw_fd())?;
            let kill_copy = duplicate(kill.as_raw_fd())?;
            let ready_write = duplicate(ready_write.as_raw_fd())?;
            let readfd = parent_read.as_raw_fd();
            let killfd = kill_copy.as_raw_fd();
            let readyfd = ready_write.as_raw_fd();
            let pid = unsafe { libc::fork() };
            if pid < 0 {
                return Err(failure());
            }
            if pid == 0 {
                // No allocation, Rust locks/logging, unwinding or destructors.
                unsafe {
                    if libc::dup2(readfd, 3) < 0
                        || libc::dup2(killfd, 4) < 0
                        || libc::dup2(readyfd, 5) < 0
                    {
                        libc::_exit(1);
                    }
                    libc::close(0);
                    libc::close(1);
                    libc::close(2);
                    if libc::syscall(libc::SYS_close_range, 6u32, u32::MAX, 0u32) != 0 {
                        libc::_exit(1);
                    }
                    if libc::setsid() < 0 {
                        libc::_exit(1);
                    }
                    if libc::write(5, b"R".as_ptr().cast(), 1) != 1 {
                        libc::_exit(1);
                    }
                    libc::close(5);
                    let mut byte = 0u8;
                    loop {
                        let n = libc::read(3, (&mut byte as *mut u8).cast(), 1);
                        if n == 0 {
                            break;
                        }
                        if n < 0 && *libc::__errno_location() != libc::EINTR {
                            break;
                        }
                    }
                    loop {
                        libc::lseek(4, 0, libc::SEEK_SET);
                        if libc::write(4, b"1\n".as_ptr().cast(), 2) == 2 {
                            break;
                        }
                        let error = *libc::__errno_location();
                        if error == libc::ENOENT || error == libc::ENODEV {
                            break;
                        }
                        libc::poll(std::ptr::null_mut(), 0, 10);
                    }
                    libc::close(3);
                    libc::close(4);
                    libc::_exit(0);
                }
            }
            drop(parent_read);
            drop(kill_copy);
            drop(ready_write);
            let mut poll = libc::pollfd {
                fd: ready_read.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let mut ready = [0u8; 1];
            let acknowledged = unsafe { libc::poll(&mut poll, 1, 1000) } > 0
                && ready_read.read_exact(&mut ready).is_ok()
                && ready == [b'R']
                && alive(pid as u32).unwrap_or(false);
            if !acknowledged {
                drop(parent_write);
                // This is our just-forked, unreaped guardian receipt only.
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                    libc::waitpid(pid, std::ptr::null_mut(), 0);
                }
                return Err(problem(
                    "PRODUCTION_GUARDIAN_UNAVAILABLE",
                    "production-private-guardian-receipt",
                ));
            }
            created.transferred = true;
            Ok(Arc::new(Self {
                root,
                directory,
                name,
                kill: Mutex::new(kill),
                guardian_writer: Mutex::new(Some(parent_write)),
                guardian: pid as u32,
                leader: AtomicU64::new(0),
                guardian_reaped: AtomicBool::new(false),
                released: AtomicBool::new(false),
            }))
        }
        fn join_writer(&self) -> Result<File, EngineError> {
            openat(self.directory.as_raw_fd(), "cgroup.procs", libc::O_WRONLY)
        }
        pub(super) fn prove_ready(&self) -> Result<(), EngineError> {
            let leader = self.leader.load(Ordering::SeqCst) as u32;
            let current = members(&self.directory, 0)?;
            if leader == 0
                || !alive(leader)?
                || !alive(self.guardian)?
                || self.guardian_writer.lock().unwrap().is_none()
                || !current.contains(&leader)
                || current.contains(&self.guardian)
            {
                return Err(problem(
                    "PRODUCTION_CONTAINMENT_UNAVAILABLE",
                    "production-owned-receipts",
                ));
            }
            Ok(())
        }
        pub(super) async fn await_leader_only(&self) -> Result<(), EngineError> {
            timeout(Duration::from_secs(3), async {
                loop {
                    self.prove_ready()?;
                    let mut current = members(&self.directory, 0)?;
                    current.sort_unstable();
                    current.dedup();
                    if current == [self.leader.load(Ordering::SeqCst) as u32] {
                        return Ok(());
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap_or_else(|_| {
                Err(problem(
                    "PRODUCTION_DRAIN_BLOCKED",
                    "production-descendants-still-owned",
                ))
            })
        }
        fn force(&self) -> Result<(), EngineError> {
            let kill = self.kill.lock().unwrap();
            unsafe {
                libc::lseek(kill.as_raw_fd(), 0, libc::SEEK_SET);
            }
            let result = unsafe { libc::write(kill.as_raw_fd(), b"1\n".as_ptr().cast(), 2) };
            if result != 2 {
                return Err(problem(
                    "PRODUCTION_DRAIN_BLOCKED",
                    "production-cgroup-kill",
                ));
            }
            Ok(())
        }
        async fn finish(&self) -> Result<(), EngineError> {
            if self.released.load(Ordering::SeqCst) {
                return Ok(());
            }
            self.force()?;
            timeout(Duration::from_secs(3), async {
                while population(&self.directory)? {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Ok::<(), EngineError>(())
            })
            .await
            .map_err(|_| problem("PRODUCTION_DRAIN_BLOCKED", "production-cgroup-populated"))??;
            drop(self.guardian_writer.lock().unwrap().take());
            if !self.guardian_reaped.load(Ordering::SeqCst) {
                timeout(Duration::from_secs(1), async {
                    loop {
                        let n = unsafe {
                            libc::waitpid(
                                self.guardian as libc::pid_t,
                                std::ptr::null_mut(),
                                libc::WNOHANG,
                            )
                        };
                        if n == self.guardian as libc::pid_t {
                            self.guardian_reaped.store(true, Ordering::SeqCst);
                            break;
                        }
                        if n < 0 {
                            return Err(problem(
                                "PRODUCTION_DRAIN_BLOCKED",
                                "production-guardian-reap",
                            ));
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    Ok::<(), EngineError>(())
                })
                .await
                .map_err(|_| problem("PRODUCTION_DRAIN_BLOCKED", "production-guardian-reap"))??;
            }
            // Empty child groups may remain after SDK work. They belong to this
            // exact launch, but cleanup is conservative: failure retains the
            // directory rather than deleting an unverified replacement.
            remove_empty_children(&self.directory, 0)?;
            if unsafe {
                libc::unlinkat(
                    self.root.as_raw_fd(),
                    self.name.as_ptr(),
                    libc::AT_REMOVEDIR,
                )
            } != 0
            {
                return Err(problem(
                    "PRODUCTION_DRAIN_BLOCKED",
                    "production-cgroup-release",
                ));
            }
            self.released.store(true, Ordering::SeqCst);
            Ok(())
        }
    }
    fn remove_empty_children(dir: &File, depth: usize) -> Result<(), EngineError> {
        if depth > 64 || population(dir)? {
            return Err(failure());
        }
        for entry in std::fs::read_dir(format!("/proc/self/fd/{}", dir.as_raw_fd()))
            .map_err(|_| failure())?
        {
            let entry = entry.map_err(|_| failure())?;
            if !entry.file_type().map_err(|_| failure())?.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let name = CString::new(name.to_str().ok_or_else(failure)?).map_err(|_| failure())?;
            let child = openat(
                dir.as_raw_fd(),
                name.to_str().map_err(|_| failure())?,
                libc::O_RDONLY | libc::O_DIRECTORY,
            )?;
            remove_empty_children(&child, depth + 1)?;
            if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
                return Err(failure());
            }
        }
        Ok(())
    }
    impl ProductionEngine {
        pub(super) async fn launch_linux(
            launch: TrustedProductionLaunch,
            host: ProductionNativeHost,
        ) -> Result<Self, EngineError> {
            let descriptor = launch.descriptor;
            let check = descriptor.clone();
            let resources = tokio::task::spawn_blocking(move || resources(&check))
                .await
                .map_err(|_| problem("DISCONNECTED", "production-resource-verification"))??;
            let scope = Scope::create(launch.containment.root, &descriptor.launch_id)?;
            let mut scope_guard = ScopeStartupGuard(scope.clone(), false);
            let (read, mut write) = pipe()?;
            let read = Arc::new(read);
            let procs = Arc::new(scope.join_writer()?);
            let mut command = Command::new(&resources.node);
            command
                .arg(&resources.stdio)
                .current_dir(&resources.root)
                .env_clear()
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            for name in [
                "PATH",
                "HOME",
                "USER",
                "LOGNAME",
                "LANG",
                "DISPLAY",
                "WAYLAND_DISPLAY",
                "XAUTHORITY",
                "DBUS_SESSION_BUS_ADDRESS",
                "XDG_RUNTIME_DIR",
                "XDG_CONFIG_HOME",
                "XDG_DATA_HOME",
                "XDG_CACHE_HOME",
                "TEMP",
                "TMP",
            ] {
                if let Some(value) = std::env::var_os(name) {
                    command.env(name, value);
                }
            }
            let read_child = read.clone();
            let procs_child = procs.clone();
            let guardian_writer = scope
                .guardian_writer
                .lock()
                .unwrap()
                .as_ref()
                .ok_or_else(failure)?
                .as_raw_fd();
            let parent = std::process::id() as libc::pid_t;
            unsafe {
                command.as_std_mut().pre_exec(move || {
                    if libc::prctl(
                        libc::PR_SET_PDEATHSIG,
                        libc::SIGKILL as libc::c_ulong,
                        0 as libc::c_ulong,
                        0 as libc::c_ulong,
                        0 as libc::c_ulong,
                    ) != 0
                        || libc::getppid() != parent
                    {
                        return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
                    }
                    // Join before exec: no SDK/helper can run outside containment.
                    if libc::write(procs_child.as_raw_fd(), b"0\n".as_ptr().cast(), 2) != 2 {
                        return Err(std::io::Error::last_os_error());
                    }
                    // Close explicitly as well as CLOEXEC, including fork/exec races.
                    libc::close(guardian_writer);
                    if libc::dup2(read_child.as_raw_fd(), 3) < 0
                        || libc::fcntl(3, libc::F_SETFD, 0) < 0
                    {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::getppid() != parent {
                        return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
                    }
                    Ok(())
                });
            }
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(_) => {
                    scope.finish().await?;
                    scope_guard.1 = true;
                    return Err(problem("DISCONNECTED", "production-node-spawn"));
                }
            };
            drop(command);
            drop(read);
            drop(procs);
            let leader = child
                .id()
                .ok_or_else(|| problem("DISCONNECTED", "production-node-receipt"))?;
            scope.leader.store(leader as u64, Ordering::SeqCst);
            let stdin = child
                .stdin
                .take()
                .ok_or_else(|| problem("DISCONNECTED", "production-private-stdin"))?;
            let mut stdout = child
                .stdout
                .take()
                .ok_or_else(|| problem("DISCONNECTED", "production-private-stdout"))?;
            let (stop, mut stop_rx) = watch::channel(false);
            let (exited_tx, exited) = watch::channel(false);
            let engine = Self(Arc::new(Inner {
                stdin: AsyncMutex::new(stdin),
                pending: Mutex::new(HashMap::new()),
                epoch: Mutex::new(String::new()),
                next: AtomicU64::new(1),
                closed: AtomicBool::new(false),
                ready: AtomicBool::new(false),
                stopping: AtomicBool::new(false),
                prepared: AtomicBool::new(false),
                drained: AtomicBool::new(false),
                last_callback: Mutex::new(0),
                last_event: Mutex::new(0),
                request_slots: Arc::new(Semaphore::new(128)),
                queue_bytes: Arc::new(Semaphore::new(4 * 1024 * 1024)),
                callback_slots: Arc::new(Semaphore::new(128)),
                callback_work: AtomicU64::new(0),
                stop,
                exited,
                descriptor: descriptor.clone(),
                host,
                scope: scope.clone(),
            }));
            let supervise = engine.clone();
            tokio::spawn(async move {
                loop {
                    if *stop_rx.borrow() || !alive(leader).unwrap_or(false) {
                        break;
                    }
                    tokio::select! {_=stop_rx.changed()=>break,_=tokio::time::sleep(Duration::from_millis(25))=>{}}
                }
                supervise.0.ready.store(false, Ordering::SeqCst);
                supervise.0.stopping.store(true, Ordering::SeqCst);
                // Failed cleanup retains the actual scope/Child/guardian. Never
                // publish an exit receipt or abandon the lease on a deadline.
                loop {
                    if scope.finish().await.is_ok() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                let reaped = child.wait().await.is_ok();
                if reaped {
                    let _ = exited_tx.send(true);
                }
            });
            scope_guard.1 = true;
            let reader = engine.clone();
            tokio::spawn(async move {
                let mut chunk = [0u8; 8192];
                let mut pending = Vec::new();
                loop {
                    let count = match stdout.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(count) => count,
                    };
                    for byte in &chunk[..count] {
                        if *byte == b'\n' {
                            let frame = match serde_json::from_slice(&pending) {
                                Ok(frame) => frame,
                                Err(_) => {
                                    reader.disconnect();
                                    return;
                                }
                            };
                            pending.clear();
                            if reader.accept(frame).await.is_err() {
                                reader.disconnect();
                                return;
                            }
                        } else {
                            pending.push(*byte);
                            if pending.len() > MAX_FRAME {
                                reader.disconnect();
                                return;
                            }
                        }
                    }
                }
                reader.disconnect();
            });
            let mut guard = StartupGuard(engine.clone(), false);
            let bytes = descriptor_bytes(&descriptor)?;
            tokio::task::spawn_blocking(move || {
                write
                    .write_all(&bytes)
                    .map_err(|_| problem("DISCONNECTED", "production-private-fd3-write"))
            })
            .await
            .map_err(|_| problem("DISCONNECTED", "production-private-fd3-write"))??;
            // Await ping response first: callback frames during initialize must
            // already carry the negotiated exact epoch.
            engine
                .request("engine.ping", json!({}))
                .await
                .map_err(|error| error.startup("production-epoch-ping"))?;
            engine
                .request(
                    "engine.initialize",
                    json!({"protocolVersion":1,"launchId":descriptor.launch_id}),
                )
                .await
                .map_err(|error| error.startup("production-owner-initialize"))?;
            if !engine.0.prepared.load(Ordering::SeqCst) || engine.0.closed.load(Ordering::SeqCst) {
                return Err(problem(
                    "PRODUCTION_CONTAINMENT_UNAVAILABLE",
                    "production-prepare-not-acknowledged",
                ));
            }
            engine.0.ready.store(true, Ordering::SeqCst);
            guard.1 = true;
            Ok(engine)
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn descriptor_pipe_is_anonymous_and_parent_loss_writer_is_close_on_exec() {
            let (mut read, mut write) = pipe().unwrap();
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            assert_eq!(
                unsafe { libc::fstat(read.as_raw_fd(), stat.as_mut_ptr()) },
                0
            );
            assert_eq!(
                unsafe { stat.assume_init() }.st_mode & libc::S_IFMT,
                libc::S_IFIFO
            );
            for file in [&read, &write] {
                assert_ne!(
                    unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
                    0
                );
            }
            write.write_all(b"private descriptor").unwrap();
            drop(write);
            let mut bytes = Vec::new();
            read.read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes, b"private descriptor");
        }
        #[test]
        fn filesystem_lookalikes_do_not_prove_cgroup_delegation() {
            let root = super::super::tests::Temporary::new();
            std::fs::write(root.0.join("cgroup.procs"), "").unwrap();
            std::fs::write(root.0.join("cgroup.controllers"), "pids").unwrap();
            let error = DelegatedCgroup::open(&root.0)
                .err()
                .expect("ordinary filesystem must reject");
            assert_eq!(error.code, "PRODUCTION_CONTAINMENT_UNAVAILABLE");
            assert!(!root.0.join("profile").exists());
        }
        #[cfg(feature = "native-fixture-tests")]
        #[tokio::test]
        #[ignore = "requires explicit TWENTYONEX_TEST_DELEGATED_CGROUP and Linux setsid fixture"]
        async fn actual_detached_descendants_block_drain_and_are_killed_by_the_owned_scope() {
            let delegated = std::env::var_os("TWENTYONEX_TEST_DELEGATED_CGROUP")
                .expect("explicit delegated fixture required");
            let root = DelegatedCgroup::open(Path::new(&delegated)).unwrap();
            let name = format!("production_fixture_{}", std::process::id());
            let scope = Scope::create(root.root, &name).unwrap();
            let procs = Arc::new(scope.join_writer().unwrap());
            let child_procs = procs.clone();
            let mut command = Command::new("/bin/sh");
            command
                .args(["-c", "setsid /bin/sh -c 'sleep 60' & wait"])
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            unsafe {
                command.as_std_mut().pre_exec(move || {
                    if libc::write(child_procs.as_raw_fd(), b"0\n".as_ptr().cast(), 2) != 2 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let mut child = command.spawn().unwrap();
            scope
                .leader
                .store(child.id().unwrap() as u64, Ordering::SeqCst);
            drop(command);
            drop(procs);
            let observed = timeout(Duration::from_secs(2), async {
                loop {
                    if members(&scope.directory, 0).unwrap().len() > 1 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await;
            let ready = scope.prove_ready();
            let blocked = scope.await_leader_only().await;
            let guardian_separate = unsafe {
                libc::getpgid(scope.guardian as libc::pid_t) != libc::getpgrp()
                    && libc::getsid(scope.guardian as libc::pid_t) == scope.guardian as libc::pid_t
            };
            let cleanup = scope.finish().await;
            let reaped = child.wait().await;
            assert!(observed.is_ok());
            assert!(ready.is_ok());
            assert!(guardian_separate);
            assert_eq!(blocked.unwrap_err().code, "PRODUCTION_DRAIN_BLOCKED");
            assert!(cleanup.is_ok());
            assert!(reaped.is_ok());
            assert!(scope.guardian_reaped.load(Ordering::SeqCst));
            assert!(scope.released.load(Ordering::SeqCst));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) struct Temporary(pub(super) PathBuf);
    impl Temporary {
        pub(super) fn new() -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "21x-production-native-{}-{stamp}",
                std::process::id()
            ));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Temporary {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn descriptor(root: &Path) -> ProductionDescriptor {
        ProductionDescriptor {
            version: 1,
            kind: "production-private-launch".into(),
            launch_id: "native_launch_fixture_01".into(),
            profile_id: "synthetic-profile".into(),
            profile_intent: ProfileIntent::CreateNew,
            build_identity: "production-fixture".into(),
            resource_manifest_sha256: "a".repeat(64),
            paths: ProductionPaths {
                profile_root: root.join("profile"),
                workspace_root: root.join("workspaces"),
                attachment_root: root.join("attachments"),
                repos_root: root.join("repos"),
                resource_root: root.join("resources"),
                temp_root: root.join("temp"),
            },
            capabilities: ProductionCapabilities {
                workspace_files: HostCapability::Unsupported,
                external_urls: HostCapability::Unsupported,
                notifications: HostCapability::Unsupported,
                energy: HostCapability::Unsupported,
                ui: HostCapability::Unsupported,
                voice: HostCapability::Unsupported,
                configured_mcp: OptionalCapability::Disabled,
                connectors: OptionalCapability::Disabled,
                managed_task_mcp: OptionalCapability::Disabled,
            },
        }
    }
    #[test]
    fn trusted_descriptor_has_exact_path_and_capability_fields_without_credentials() {
        let root = Temporary::new();
        let value = descriptor(&root.0);
        let bytes = descriptor_bytes(&value).unwrap();
        let mut wire: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            wire["paths"]["profileRoot"],
            value.paths.profile_root.to_str().unwrap()
        );
        assert_eq!(wire["profileIntent"], "create-new");
        wire["credentials"] = json!({"key":"not-a-bootstrap-field"});
        assert!(serde_json::from_value::<ProductionDescriptor>(wire).is_err());
        let mut bad = value.clone();
        bad.launch_id = "../foreign".into();
        assert!(descriptor_bytes(&bad).is_err());
        bad = value.clone();
        bad.capabilities.energy = HostCapability::Host;
        assert!(descriptor_bytes(&bad).is_err());
        bad = value;
        bad.paths.workspace_root = PathBuf::from("relative");
        assert!(descriptor_bytes(&bad).is_err());
    }
    #[test]
    fn native_request_identity_is_scoped_and_monotonic_decimal() {
        assert_eq!(request_id("service:42", "service:"), Some(42));
        for bad in [
            "host:42",
            "service:0",
            "service:0042",
            "service:-1",
            "service:1/../../",
        ] {
            assert!(request_id(bad, "service:").is_none());
        }
    }
    #[test]
    fn native_resource_gate_authenticates_executable_and_thin_entry_before_spawn() {
        let root = Temporary::new();
        let mut value = descriptor(&root.0);
        let resources_root = &value.paths.resource_root;
        std::fs::create_dir_all(resources_root.join("service")).unwrap();
        std::fs::create_dir_all(resources_root.join("node")).unwrap();
        std::fs::create_dir_all(resources_root.join("native")).unwrap();
        let node = if cfg!(windows) {
            "node/node.exe"
        } else {
            "node/node"
        };
        let helper = if cfg!(windows) {
            "native/twentyonex-credential-key.exe"
        } else {
            "native/twentyonex-credential-key"
        };
        let mut files = serde_json::Map::new();
        for name in [
            node,
            helper,
            "service/production-stdio.mjs",
            "service/production-engine.mjs",
            "service/production-task-mcp.mjs",
            "service/.native-prepared.json",
        ] {
            let file = resources_root.join(name);
            std::fs::write(&file, b"controlled bytes never executed").unwrap();
            let (hash, bytes) = file_hash(&file).unwrap();
            files.insert(name.into(), json!({"sha256":hash,"bytes":bytes}));
        }
        let manifest = json!({"version":1,"kind":"production-resource-closure","buildIdentity":value.build_identity,"nodeVersion":"22.23.2","platform":"fixture","arch":"fixture","entries":{"node":node,"credentialHelper":helper,"stdio":"service/production-stdio.mjs","engine":"service/production-engine.mjs","taskMcp":"service/production-task-mcp.mjs"},"packages":{},"files":files,"redistributionReviewComplete":false});
        let path = resources_root.join("service/PRODUCTION_RESOURCE_MANIFEST.json");
        std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        value.resource_manifest_sha256 = file_hash(&path).unwrap().0;
        assert!(resources(&value).is_ok());
        std::fs::write(
            resources_root.join("service/production-stdio.mjs"),
            b"changed executable gate",
        )
        .unwrap();
        assert_eq!(
            resources(&value).err().unwrap().startup_phase,
            Some("production-resource-bytes")
        );
        value.paths.profile_root = resources_root.join("profile");
        assert_eq!(
            resources(&value).err().unwrap().startup_phase,
            Some("production-profile-resource-overlap")
        );
    }
}
