//! Opt-in native production launcher. No renderer-supplied bootstrap or PID authority.
#[path = "production_cleanup_observation.rs"]
pub mod cleanup_observation;
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
    sync::{oneshot, watch, Mutex as AsyncMutex, Semaphore},
    time::{timeout, timeout_at, Instant},
};

#[cfg(windows)]
#[path = "production_windows.rs"]
mod windows;

const MAX_FRAME: usize = 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(30);

const OWNER_PHASES: &[&str] = &[
    "new", "starting", "ready", "stopping", "blocked", "stopped", "failed",
];
const OWNER_STAGES: &[&str] = &[
    "new",
    "profile-lock",
    "resources",
    "native-readiness",
    "credentials",
    "database-preflight",
    "database",
    "secret-broker",
    "task-api",
    "services",
    "recovery",
    "background",
    "ready",
    "released",
];
const OWNER_RECOVERY_CODES: &[&str] = &[
    "PROFILE_IN_USE",
    "PROFILE_DUPLICATE_OWNER",
    "PROFILE_LOCK_INVALID",
    "PROFILE_LOCK_LOST",
    "PROFILE_NOT_EMPTY",
    "PROFILE_LOW_DISK",
    "PROFILE_DATABASE_LOCKED",
    "PROFILE_DATABASE_CORRUPT",
    "PROFILE_DATABASE_PATH_INVALID",
    "PROFILE_CREDENTIAL_FORMAT_INCOMPATIBLE",
    "PROFILE_CREDENTIAL_OR_DATABASE_INVALID",
    "DATABASE_UNAVAILABLE",
    "RESOURCE_UNAVAILABLE",
    "MANAGED_MCP_RESOURCE_UNAVAILABLE",
    "CONNECTOR_RESOURCES_REQUIRED",
    "AGENT_CLI_UNAVAILABLE",
    "NATIVE_RUNTIME_UNAVAILABLE",
    "SECRET_STORE_UNAVAILABLE",
    "OWNER_CLOSING",
    "OWNER_DRAIN_BLOCKED",
    "OWNER_FENCE_FAILED",
    "BOOTSTRAP_FAILED",
];
fn valid_owner_state(value: &Value) -> bool {
    contracts::object(value, &["phase", "stage", "code", "owned"], &[])
        && value["phase"]
            .as_str()
            .is_some_and(|v| OWNER_PHASES.contains(&v))
        && value["stage"]
            .as_str()
            .is_some_and(|v| OWNER_STAGES.contains(&v))
        && (value["code"].is_null()
            || value["code"]
                .as_str()
                .is_some_and(|v| OWNER_RECOVERY_CODES.contains(&v)))
        && value["owned"].is_boolean()
}
fn owner_recovery_error(value: &Value) -> Option<EngineError> {
    if !valid_owner_state(value) || !matches!(value["phase"].as_str(), Some("failed" | "blocked")) {
        return None;
    }
    let code = OWNER_RECOVERY_CODES
        .iter()
        .copied()
        .find(|code| value["code"] == *code)?;
    let stage = OWNER_STAGES
        .iter()
        .copied()
        .find(|stage| value["stage"] == *stage)?;
    Some(EngineError::new(code).startup(stage))
}

// A complete frame has a bounded lifetime even when the peer trickles bytes.
// An idle pipe is allowed: only an unfinished frame starts this deadline.
#[derive(Default)]
struct ProductionFrameDecoder {
    bytes: Vec<u8>,
    started: Option<Instant>,
}
impl ProductionFrameDecoder {
    fn push(&mut self, byte: u8, now: Instant) -> Result<Option<Value>, EngineError> {
        if self.started.is_some_and(|start| now >= start + DEADLINE) {
            return Err(EngineError::new("TIMEOUT"));
        }
        if byte == b'\n' {
            let frame = serde_json::from_slice(&self.bytes)
                .map_err(|_| EngineError::new("INVALID_FRAME"))?;
            self.bytes.clear();
            self.started = None;
            return Ok(Some(frame));
        }
        if self.bytes.len() == MAX_FRAME {
            return Err(EngineError::new("FRAME_TOO_LARGE"));
        }
        self.started.get_or_insert(now);
        self.bytes.push(byte);
        Ok(None)
    }
    fn deadline(&self) -> Option<Instant> {
        self.started.map(|start| start + DEADLINE)
    }
}
fn request_deadline_at(operation: &str, started: Instant) -> Instant {
    // Private installation/download operations have bounded owned plans.
    // No caller-provided duration or namespace changes other request budgets.
    started
        + if matches!(
            operation,
            "engine.agent.install" | "engine.attachment.download"
        ) {
            Duration::from_secs(180)
        } else {
            DEADLINE
        }
}
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
    #[serde(default = "unsupported_host_capability")]
    pub workspace_cleanup: HostCapability,
    #[serde(default = "unsupported_host_capability")]
    pub attachment_files: HostCapability,
    #[serde(default = "unsupported_host_capability")]
    pub attachment_downloads: HostCapability,
    #[serde(default = "unsupported_host_capability")]
    pub artifact_clipboard: HostCapability,
    #[serde(default = "unsupported_host_capability")]
    pub tray: HostCapability,
    #[serde(default = "unsupported_host_capability")]
    pub oauth_flows: HostCapability,
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
pub type ProductionEnergyScope = Arc<dyn Fn() -> Result<(), EngineError> + Send + Sync>;
pub struct ProductionEnergyHost {
    pub invoke: Arc<dyn Fn(bool, ProductionEnergyScope) -> HostFuture<bool> + Send + Sync>,
    pub close: Arc<dyn Fn() -> HostFuture<()> + Send + Sync>,
}
pub struct ProductionWorkspaceHost {
    pub invoke: Arc<dyn Fn(bool, Value) -> HostFuture<()> + Send + Sync>,
    pub close: Arc<dyn Fn() -> HostFuture<()> + Send + Sync>,
}
pub struct ProductionAttachmentHost {
    pub invoke: Arc<dyn Fn(Value, String, String) -> HostFuture<()> + Send + Sync>,
    pub close: Arc<dyn Fn() -> HostFuture<()> + Send + Sync>,
}
pub struct ProductionAttachmentDownloadHost {
    pub invoke: Arc<dyn Fn(Value, String, String, String) -> HostFuture<()> + Send + Sync>,
    pub close: Arc<dyn Fn() -> HostFuture<()> + Send + Sync>,
}
pub struct ProductionArtifactClipboardHost {
    pub invoke: Arc<dyn Fn(Value, String, String, String) -> HostFuture<Value> + Send + Sync>,
    pub close: Arc<dyn Fn() -> HostFuture<()> + Send + Sync>,
}
pub struct ProductionNotificationHost {
    pub invoke: Arc<dyn Fn(String, String, bool, String) -> HostFuture<bool> + Send + Sync>,
    pub close: Arc<dyn Fn() -> HostFuture<()> + Send + Sync>,
}
pub struct ProductionCleanupHost {
    pub invoke: Arc<dyn Fn(Value, String) -> HostFuture<Value> + Send + Sync>,
    pub close: Arc<dyn Fn() -> HostFuture<()> + Send + Sync>,
}
pub struct ProductionOAuthHost {
    pub invoke: Arc<dyn Fn(String, Value, String) -> HostFuture<Value> + Send + Sync>,
    pub close: Arc<dyn Fn() -> HostFuture<()> + Send + Sync>,
}
pub struct ProductionNativeHost {
    pub oauth: Option<ProductionOAuthHost>,
    pub workspace_cleanup: Option<ProductionCleanupHost>,
    pub workspace_file: Option<ProductionWorkspaceHost>,
    pub attachment_file: Option<ProductionAttachmentHost>,
    pub attachment_download: Option<ProductionAttachmentDownloadHost>,
    pub artifact_clipboard: Option<ProductionArtifactClipboardHost>,
    pub event_sink: Arc<dyn Fn(Value) -> Result<(), EngineError> + Send + Sync>,
    pub open_external: Option<Arc<dyn Fn(String) -> HostFuture<()> + Send + Sync>>,
    pub notification: Option<ProductionNotificationHost>,
    pub energy: Option<ProductionEnergyHost>,
    pub ui_snapshot: Option<Arc<dyn Fn(String) -> HostFuture<Value> + Send + Sync>>,
    pub ui_command: Option<Arc<dyn Fn(Value, String, String) -> HostFuture<Value> + Send + Sync>>,
    pub installer_progress:
        Option<Arc<dyn Fn(Value, String, String) -> HostFuture<Value> + Send + Sync>>,
}
fn energy_host_matches(capability: &HostCapability, host: &ProductionNativeHost) -> bool {
    match capability {
        HostCapability::Host => host.energy.is_some(),
        HostCapability::Unsupported => host.energy.is_none(),
    }
}
async fn energy_callback(
    host: &ProductionNativeHost,
    capability: &HostCapability,
    payload: &Value,
    current: ProductionEnergyScope,
) -> Result<Value, EngineError> {
    if !contracts::object(payload, &["enabled"], &[]) || !payload["enabled"].is_boolean() {
        return Err(EngineError::new("INVALID_ARGUMENTS"));
    }
    if *capability != HostCapability::Host || !energy_host_matches(capability, host) {
        return Err(EngineError::new("UNKNOWN_OPERATION"));
    }
    let enabled = payload["enabled"].as_bool().unwrap();
    if enabled {
        current()?;
    }
    let applied = (host.energy.as_ref().unwrap().invoke)(enabled, current.clone()).await?;
    if enabled {
        current()?;
    }
    Ok(json!({"enabled":applied}))
}
fn notification_text(value: &Value, maximum: usize, multiline: bool, empty: bool) -> bool {
    value.as_str().is_some_and(|text| {
        (empty || !text.is_empty())
            && text.len() <= maximum
            && !text.chars().any(|c| {
                c == '\u{007f}'
                    || c <= '\u{001f}' && !(multiline && matches!(c, '\t' | '\r' | '\n'))
            })
    })
}
async fn notification_callback(
    host: &ProductionNativeHost,
    capability: &HostCapability,
    epoch: String,
    operation: &str,
    payload: &Value,
) -> Result<Value, EngineError> {
    if *capability != HostCapability::Host
        || !matches!(
            operation,
            "host.notification.show" | "host.notification.status"
        )
    {
        return Err(EngineError::new("UNKNOWN_OPERATION"));
    }
    if !contracts::object(payload, &["title", "body"], &[])
        || !notification_text(&payload["title"], 160, false, false)
        || !notification_text(&payload["body"], 2048, true, true)
    {
        return Err(EngineError::new("INVALID_ARGUMENTS"));
    }
    let shown = (host
        .notification
        .as_ref()
        .ok_or_else(|| EngineError::new("UNKNOWN_OPERATION"))?
        .invoke)(
        payload["title"].as_str().unwrap().to_owned(),
        payload["body"].as_str().unwrap().to_owned(),
        operation == "host.notification.status",
        epoch,
    )
    .await?;
    Ok(json!({"shown":shown}))
}
fn ui_host_matches(capability: &HostCapability, host: &ProductionNativeHost) -> bool {
    match capability {
        HostCapability::Host => host.ui_snapshot.is_some() && host.ui_command.is_some(),
        HostCapability::Unsupported => {
            host.ui_snapshot.is_none()
                && host.ui_command.is_none()
                && host.installer_progress.is_none()
        }
    }
}
async fn ui_callback(
    host: &ProductionNativeHost,
    capability: &HostCapability,
    epoch: String,
    operation: &str,
    payload: &Value,
) -> Result<Value, EngineError> {
    use crate::production_ui_contracts as ui;
    // An unsupported descriptor never probes the callbacks.
    if *capability != HostCapability::Host || !ui_host_matches(capability, host) {
        return Err(EngineError::new("UNKNOWN_OPERATION"));
    }
    let result = match operation {
        "host.ui.snapshot" => {
            if !ui::snapshot_request(payload) {
                return Err(EngineError::new("INVALID_ARGUMENTS"));
            }
            let result = host.ui_snapshot.as_ref().unwrap()(epoch).await?;
            if !ui::snapshot_result(&result) {
                return Err(EngineError::new("INVALID_RESULT"));
            }
            result
        }
        "host.ui.command" => {
            if !ui::command_request(payload) {
                return Err(EngineError::new("INVALID_ARGUMENTS"));
            }
            let result = host.ui_command.as_ref().unwrap()(
                payload["command"].clone(),
                payload["leaseId"].as_str().unwrap().to_owned(),
                epoch,
            )
            .await?;
            if !ui::command_result(&result)
                || result["ok"] == true && result["leaseId"] != payload["leaseId"]
            {
                return Err(EngineError::new("INVALID_RESULT"));
            }
            result
        }
        "host.ui.installerProgress" => {
            if !contracts::agent_installer::progress_request(payload) {
                return Err(EngineError::new("INVALID_ARGUMENTS"));
            }
            let callback = host
                .installer_progress
                .as_ref()
                .ok_or_else(|| EngineError::new("UNKNOWN_OPERATION"))?;
            let result = callback(
                payload["progress"].clone(),
                payload["leaseId"].as_str().unwrap().to_owned(),
                epoch,
            )
            .await?;
            if !ui::command_result(&result)
                || result["ok"] == true && result["leaseId"] != payload["leaseId"]
            {
                return Err(EngineError::new("INVALID_RESULT"));
            }
            result
        }
        _ => return Err(EngineError::new("UNKNOWN_OPERATION")),
    };
    Ok(result)
}
fn attachment_host_matches(capability: &HostCapability, host: &ProductionNativeHost) -> bool {
    match capability {
        HostCapability::Host => {
            host.attachment_file.is_some() && ui_host_matches(&HostCapability::Host, host)
        }
        HostCapability::Unsupported => host.attachment_file.is_none(),
    }
}
fn attachment_download_host_matches(
    capability: &HostCapability,
    host: &ProductionNativeHost,
) -> bool {
    match capability {
        HostCapability::Host => {
            host.attachment_download.is_some() && ui_host_matches(&HostCapability::Host, host)
        }
        HostCapability::Unsupported => host.attachment_download.is_none(),
    }
}
fn artifact_clipboard_host_matches(
    capability: &HostCapability,
    host: &ProductionNativeHost,
) -> bool {
    match capability {
        HostCapability::Host => {
            host.artifact_clipboard.is_some() && ui_host_matches(&HostCapability::Host, host)
        }
        HostCapability::Unsupported => host.artifact_clipboard.is_none(),
    }
}
async fn artifact_copy_callback(
    host: &ProductionNativeHost,
    capability: &HostCapability,
    epoch: String,
    payload: &Value,
) -> Result<Value, EngineError> {
    if *capability != HostCapability::Host || !artifact_clipboard_host_matches(capability, host) {
        return Err(EngineError::new("UNKNOWN_OPERATION"));
    }
    if !contracts::artifact_copy_callback(payload) {
        return Err(EngineError::new("INVALID_ARGUMENTS"));
    }
    let result = (host.artifact_clipboard.as_ref().unwrap().invoke)(
        payload["receipt"].clone(),
        payload["leaseId"].as_str().unwrap().to_owned(),
        epoch,
        payload["authorizationId"].as_str().unwrap().to_owned(),
    )
    .await?;
    if !contracts::object(&result, &["mode"], &[])
        || !matches!(result["mode"].as_str(), Some("file" | "unavailable"))
    {
        return Err(EngineError::new("INVALID_RESULT"));
    }
    Ok(result)
}
async fn attachment_download_callback(
    host: &ProductionNativeHost,
    capability: &HostCapability,
    epoch: String,
    payload: &Value,
) -> Result<Value, EngineError> {
    if *capability != HostCapability::Host || !attachment_download_host_matches(capability, host) {
        return Err(EngineError::new("UNKNOWN_OPERATION"));
    }
    if !crate::production_attachment_files::download_callback_request(payload) {
        return Err(EngineError::new("INVALID_ARGUMENTS"));
    }
    (host.attachment_download.as_ref().unwrap().invoke)(
        payload["receipt"].clone(),
        payload["leaseId"].as_str().unwrap().to_owned(),
        epoch,
        payload["authorizationId"].as_str().unwrap().to_owned(),
    )
    .await?;
    Ok(json!({}))
}
async fn attachment_callback(
    host: &ProductionNativeHost,
    capability: &HostCapability,
    epoch: String,
    payload: &Value,
) -> Result<Value, EngineError> {
    if *capability != HostCapability::Host || !attachment_host_matches(capability, host) {
        return Err(EngineError::new("UNKNOWN_OPERATION"));
    }
    if !crate::production_attachment_files::callback_request(payload) {
        return Err(EngineError::new("INVALID_ARGUMENTS"));
    }
    (host.attachment_file.as_ref().unwrap().invoke)(
        payload["receipt"].clone(),
        payload["leaseId"].as_str().unwrap().to_owned(),
        epoch,
    )
    .await?;
    Ok(json!({}))
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
    /// Windows authority is an atomic, app-owned Job, with no caller path.
    #[cfg(windows)]
    pub fn native_job() -> Self {
        Self {}
    }
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
        || capabilities.voice != HostCapability::Unsupported
        || capabilities.oauth_flows == HostCapability::Host
            && capabilities.external_urls != HostCapability::Host
        || capabilities.attachment_files == HostCapability::Host
            && capabilities.ui != HostCapability::Host
        || capabilities.attachment_downloads == HostCapability::Host
            && capabilities.ui != HostCapability::Host
        || capabilities.artifact_clipboard == HostCapability::Host
            && capabilities.ui != HostCapability::Host
        || capabilities.tray == HostCapability::Host && capabilities.ui != HostCapability::Host
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
    stdin: AsyncMutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
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
    #[cfg(test)]
    cancellation_budget: Duration,
    stop: watch::Sender<bool>,
    exited: watch::Receiver<bool>,
    descriptor: ProductionDescriptor,
    host: ProductionNativeHost,
    #[cfg(target_os = "linux")]
    scope: Arc<linux::Scope>,
    #[cfg(windows)]
    scope: Arc<windows::Scope>,
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
                // Cancellation is not a best-effort invalidation. A saturated
                // or blocked writer must retire this epoch, never leave raw
                // peer work running behind a released local request slot.
                let frame = json!({"kind":"event","protocolVersion":1,"engineEpoch":epoch,"operation":"engine.cancel","payload":{"requestId":id}});
                if !matches!(
                    timeout(engine.cancellation_budget(), engine.write(&frame)).await,
                    Ok(Ok(()))
                ) {
                    engine.disconnect();
                }
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
    fn cancellation_budget(&self) -> Duration {
        #[cfg(test)]
        {
            self.0.cancellation_budget
        }
        #[cfg(not(test))]
        {
            DEADLINE
        }
    }

    pub async fn start(
        launch: TrustedProductionLaunch,
        host: ProductionNativeHost,
    ) -> Result<Self, EngineError> {
        descriptor_bytes(&launch.descriptor)?;
        if (launch.descriptor.capabilities.workspace_cleanup == HostCapability::Host)
            != host.workspace_cleanup.is_some()
            || (launch.descriptor.capabilities.oauth_flows == HostCapability::Host)
                != host.oauth.is_some()
            || (launch.descriptor.capabilities.external_urls == HostCapability::Host
                && host.open_external.is_none())
            || (launch.descriptor.capabilities.notifications == HostCapability::Host
                && host.notification.is_none())
            || (launch.descriptor.capabilities.workspace_files == HostCapability::Host
                && host.workspace_file.is_none())
            || (launch.descriptor.capabilities.notifications == HostCapability::Unsupported
                && host.notification.is_some())
            || !energy_host_matches(&launch.descriptor.capabilities.energy, &host)
            || !ui_host_matches(&launch.descriptor.capabilities.ui, &host)
            || !attachment_host_matches(&launch.descriptor.capabilities.attachment_files, &host)
            || !attachment_download_host_matches(
                &launch.descriptor.capabilities.attachment_downloads,
                &host,
            )
            || !artifact_clipboard_host_matches(
                &launch.descriptor.capabilities.artifact_clipboard,
                &host,
            )
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
        #[cfg(windows)]
        {
            Self::launch_windows(launch, host).await
        }
        #[cfg(not(any(target_os = "linux", windows)))]
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

    #[cfg(windows)]
    async fn launch_windows(
        launch: TrustedProductionLaunch,
        host: ProductionNativeHost,
    ) -> Result<Self, EngineError> {
        use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
        use std::sync::Mutex;
        use tokio::{
            io::AsyncWriteExt,
            sync::{watch, Mutex as AsyncMutex, Semaphore},
        };
        let descriptor = launch.descriptor;
        let check = descriptor.clone();
        let resources = tokio::task::spawn_blocking(move || resources(&check))
            .await
            .map_err(|_| problem("DISCONNECTED", "production-resource-verification"))??;
        let windows::Spawned {
            scope,
            stdin,
            stdout,
        } = windows::spawn(
            &resources.node,
            &resources.stdio,
            &resources.root,
            &descriptor.launch_id,
        )
        .await?;
        let (stop, mut stop_rx) = watch::channel(false);
        let (exited_tx, exited) = watch::channel(false);
        let engine = Self(Arc::new(Inner {
            stdin: AsyncMutex::new(Box::new(stdin)),
            pending: Mutex::new(std::collections::HashMap::new()),
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
            #[cfg(test)]
            cancellation_budget: DEADLINE,
            stop,
            exited,
            descriptor: descriptor.clone(),
            host,
            scope: scope.clone(),
        }));
        let supervise = engine.clone();
        tokio::spawn(async move {
            loop {
                if *stop_rx.borrow() || !scope.alive().unwrap_or(false) {
                    break;
                }
                tokio::select! { _=stop_rx.changed()=>break, _=tokio::time::sleep(Duration::from_millis(25))=>{} }
            }
            supervise.0.ready.store(false, Ordering::SeqCst);
            supervise.0.stopping.store(true, Ordering::SeqCst);
            if let Some(cleanup) = &supervise.0.host.workspace_cleanup {
                let _ = (cleanup.close)().await;
            }
            // Keep the exact Job/process handles after failed cleanup. There is
            // no PID lookup, public timeout exit receipt, or abandoned tree.
            loop {
                if scope.finish().await.is_ok() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let _ = exited_tx.send(true);
        });
        let reader = engine.clone();
        tokio::spawn(async move { reader.read_stdout(stdout).await });
        let mut guard = StartupGuard(engine.clone(), false);
        let mut bytes = descriptor_bytes(&descriptor)?;
        bytes.push(b'\n');
        tokio::time::timeout(DEADLINE, async {
            let mut input = engine.0.stdin.lock().await;
            input.write_all(&bytes).await?;
            input.flush().await
        })
        .await
        .map_err(|_| problem("TIMEOUT", "production-private-bootstrap-write"))?
        .map_err(|_| problem("DISCONNECTED", "production-private-bootstrap-write"))?;
        engine.initialize_owner().await?;
        guard.1 = true;
        Ok(engine)
    }

    async fn initialize_owner(&self) -> Result<(), EngineError> {
        let engine = self;
        let descriptor = &self.0.descriptor;
        // Await ping response first: callback frames during initialize must
        // already carry the negotiated exact epoch.
        engine
            .request("engine.ping", json!({}))
            .await
            .map_err(|error| error.startup("production-epoch-ping"))?;
        if let Err(error) = engine
            .request(
                "engine.initialize",
                json!({"protocolVersion":1,"launchId":descriptor.launch_id}),
            )
            .await
        {
            // Observe finite metadata before the startup guard retires this
            // epoch. This never retries initialization or a domain effect.
            if let Ok(state) = engine.request("engine.ownerState", json!({})).await {
                if let Some(recovery) = owner_recovery_error(&state) {
                    return Err(recovery);
                }
            }
            return Err(error.startup("production-owner-initialize"));
        }
        if !engine.0.prepared.load(Ordering::SeqCst) || engine.0.closed.load(Ordering::SeqCst) {
            return Err(problem(
                "PRODUCTION_CONTAINMENT_UNAVAILABLE",
                "production-prepare-not-acknowledged",
            ));
        }
        engine.0.ready.store(true, Ordering::SeqCst);
        Ok(())
    }
    pub fn epoch(&self) -> String {
        self.0.epoch.lock().unwrap().clone()
    }
    /// Native-only ingress; never part of the retained renderer command surface.
    pub async fn deliver_oauth(&self, epoch: &str, payload: Value) -> Result<Value, EngineError> {
        if epoch != self.epoch() {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        if self.0.descriptor.capabilities.oauth_flows != HostCapability::Host {
            return Err(EngineError::new("UNKNOWN_OPERATION"));
        }
        if !crate::production_oauth::callback(&payload) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        if !self.0.ready.load(Ordering::SeqCst)
            || self.0.closed.load(Ordering::SeqCst)
            || self.0.stopping.load(Ordering::SeqCst)
        {
            return Err(EngineError::new("DISCONNECTED"));
        }
        // The response acknowledges only atomic Source claim, never exchange or
        // persistence. Holding a native delivery receipt across exchange would
        // deadlock when Source finally joins native retirement.
        self.request("engine.oauth.callback", payload).await
    }
    pub fn snapshot(&self) -> Value {
        json!({"production":true,"engineEpoch":self.epoch(),"available":self.0.ready.load(Ordering::SeqCst)&&!self.0.closed.load(Ordering::SeqCst)&&!self.0.stopping.load(Ordering::SeqCst),"prepared":self.0.prepared.load(Ordering::SeqCst),"nativeDrainAcknowledged":self.0.drained.load(Ordering::SeqCst),"ownedTreeExited":*self.0.exited.borrow(),"nativeCallbacks":self.0.callback_work.load(Ordering::SeqCst),"containment":if cfg!(windows) { "windows-atomic-job-kill-on-close" } else { "linux-delegated-cgroup-v2-with-private-guardian" }})
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
    /// App-owned close lookup has no renderer-selected action or document claim.
    pub async fn tray_preference(&self, epoch: &str) -> Result<bool, EngineError> {
        self.assert_tray(epoch)?;
        let result = self.request("engine.tray.preference", json!({})).await?;
        self.assert_tray(epoch)?;
        if !crate::production_tray_contracts::preference(&result) {
            return Err(EngineError::new("INVALID_RESULT"));
        }
        Ok(result["enabled"].as_bool().unwrap())
    }
    fn assert_tray(&self, epoch: &str) -> Result<(), EngineError> {
        if epoch != self.epoch() {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        if self.0.descriptor.capabilities.tray != HostCapability::Host
            || self.0.descriptor.capabilities.ui != HostCapability::Host
        {
            return Err(EngineError::new("UNKNOWN_OPERATION"));
        }
        if !self.0.ready.load(Ordering::SeqCst)
            || self.0.closed.load(Ordering::SeqCst)
            || self.0.stopping.load(Ordering::SeqCst)
        {
            return Err(EngineError::new("DISCONNECTED"));
        }
        Ok(())
    }
    pub async fn invoke_tray_preference(
        &self,
        epoch: &str,
        operation: &str,
        payload: Value,
        lease_id: &str,
    ) -> Result<Value, EngineError> {
        let payload = json!({"operation":operation,"payload":payload,"leaseId":lease_id});
        if !crate::production_tray_contracts::private_command(&payload) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        self.assert_tray(epoch)?;
        let result = self
            .request("engine.tray.preferenceCommand", payload)
            .await?;
        self.assert_tray(epoch)?;
        Ok(result)
    }
    /// Trusted native publication carries the window owner's lease. This is
    /// private engine traffic, never a new public operation or payload grant.
    pub async fn publish_ui(
        &self,
        epoch: &str,
        state: Value,
        lease_id: &str,
    ) -> Result<Value, EngineError> {
        let payload = json!({"state":state,"leaseId":lease_id});
        if !crate::production_ui_contracts::private_publish_request(&payload) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        if epoch != self.epoch() {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        if self.0.descriptor.capabilities.ui != HostCapability::Host {
            return Err(EngineError::new("UNKNOWN_OPERATION"));
        }
        if !self.0.ready.load(Ordering::SeqCst)
            || self.0.closed.load(Ordering::SeqCst)
            || self.0.stopping.load(Ordering::SeqCst)
        {
            return Err(EngineError::new("DISCONNECTED"));
        }
        self.request("engine.ui.publish", payload).await
    }
    /// Only the trusted native ingress attaches the captured current document
    /// receipt. The renderer cannot supply private pipe operations or grants.
    pub async fn install_agent(
        &self,
        epoch: &str,
        payload: Value,
        lease_id: &str,
    ) -> Result<Value, EngineError> {
        if !contracts::agent_installer::request(&payload) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        let payload = json!({"agentName":payload["agentName"],"leaseId":lease_id});
        if !contracts::agent_installer::private_request(&payload) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        if epoch != self.epoch() {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        if self.0.descriptor.capabilities.ui != HostCapability::Host
            || self.0.host.installer_progress.is_none()
        {
            return Err(EngineError::new("UNKNOWN_OPERATION"));
        }
        if !self.0.ready.load(Ordering::SeqCst)
            || self.0.closed.load(Ordering::SeqCst)
            || self.0.stopping.load(Ordering::SeqCst)
        {
            return Err(EngineError::new("DISCONNECTED"));
        }
        let result = self.request("engine.agent.install", payload).await?;
        if epoch != self.epoch() {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        if !self.0.ready.load(Ordering::SeqCst)
            || self.0.closed.load(Ordering::SeqCst)
            || self.0.stopping.load(Ordering::SeqCst)
        {
            return Err(EngineError::new("DISCONNECTED"));
        }
        Ok(result)
    }
    /// Current-document ingress stamps this private operation; public callers
    /// may select saved IDs only, never an arbitrary path or callback receipt.
    pub async fn open_attachment(
        &self,
        epoch: &str,
        payload: Value,
        lease_id: &str,
    ) -> Result<Value, EngineError> {
        self.attachment_request(epoch, payload, lease_id, false)
            .await
    }
    pub async fn download_attachment(
        &self,
        epoch: &str,
        payload: Value,
        lease_id: &str,
    ) -> Result<Value, EngineError> {
        self.attachment_request(epoch, payload, lease_id, true)
            .await
    }
    pub async fn check_attachment_download(
        &self,
        epoch: &str,
        authorization_id: &str,
    ) -> Result<(), EngineError> {
        if !contracts::attachment_uuid(&json!(authorization_id)) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        if epoch != self.epoch() {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        if self.0.descriptor.capabilities.attachment_downloads != HostCapability::Host
            || !attachment_download_host_matches(&HostCapability::Host, &self.0.host)
        {
            return Err(EngineError::new("UNKNOWN_OPERATION"));
        }
        if !self.0.ready.load(Ordering::SeqCst)
            || self.0.closed.load(Ordering::SeqCst)
            || self.0.stopping.load(Ordering::SeqCst)
        {
            return Err(EngineError::new("DISCONNECTED"));
        }
        let result = self
            .request(
                "engine.attachment.download.check",
                json!({"authorizationId":authorization_id}),
            )
            .await?;
        if result != json!({"authorized":true}) {
            return Err(EngineError::new("INVALID_RESULT"));
        }
        if epoch != self.epoch() {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        if !self.0.ready.load(Ordering::SeqCst)
            || self.0.closed.load(Ordering::SeqCst)
            || self.0.stopping.load(Ordering::SeqCst)
        {
            return Err(EngineError::new("DISCONNECTED"));
        }
        Ok(())
    }
    pub async fn copy_artifact_file(
        &self,
        epoch: &str,
        payload: Value,
        lease_id: &str,
    ) -> Result<Value, EngineError> {
        if !contracts::valid_request("artifacts:copyFile", &payload) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        let payload = json!({"taskId":payload["taskId"],"relativePath":payload["relativePath"],"leaseId":lease_id});
        if !contracts::private_artifact_copy(&payload) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        if epoch != self.epoch() {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        if !self.0.ready.load(Ordering::SeqCst)
            || self.0.closed.load(Ordering::SeqCst)
            || self.0.stopping.load(Ordering::SeqCst)
        {
            return Err(EngineError::new("DISCONNECTED"));
        }
        // Missing optional clipboard authority is handled by Source as unavailable.
        let result = self.request("engine.artifact.copyFile", payload).await?;
        if epoch != self.epoch() {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        if !self.0.ready.load(Ordering::SeqCst)
            || self.0.closed.load(Ordering::SeqCst)
            || self.0.stopping.load(Ordering::SeqCst)
        {
            return Err(EngineError::new("DISCONNECTED"));
        }
        Ok(result)
    }
    pub async fn check_artifact_copy(
        &self,
        epoch: &str,
        authorization_id: &str,
    ) -> Result<(), EngineError> {
        if !contracts::attachment_uuid(&json!(authorization_id)) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        if epoch != self.epoch() {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        if self.0.descriptor.capabilities.artifact_clipboard != HostCapability::Host
            || !artifact_clipboard_host_matches(&HostCapability::Host, &self.0.host)
        {
            return Err(EngineError::new("UNKNOWN_OPERATION"));
        }
        if !self.0.ready.load(Ordering::SeqCst)
            || self.0.closed.load(Ordering::SeqCst)
            || self.0.stopping.load(Ordering::SeqCst)
        {
            return Err(EngineError::new("DISCONNECTED"));
        }
        let result = self
            .request(
                "engine.artifact.copyFile.check",
                json!({"authorizationId":authorization_id}),
            )
            .await?;
        if result != json!({"authorized":true}) {
            return Err(EngineError::new("INVALID_RESULT"));
        }
        if epoch != self.epoch() {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        if !self.0.ready.load(Ordering::SeqCst)
            || self.0.closed.load(Ordering::SeqCst)
            || self.0.stopping.load(Ordering::SeqCst)
        {
            return Err(EngineError::new("DISCONNECTED"));
        }
        Ok(())
    }
    async fn attachment_request(
        &self,
        epoch: &str,
        payload: Value,
        lease_id: &str,
        download: bool,
    ) -> Result<Value, EngineError> {
        if !crate::production_attachment_files::request(&payload) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        let payload = json!({"taskId":payload["taskId"],"attachmentId":payload["attachmentId"],"leaseId":lease_id});
        if !crate::production_attachment_files::private_request(&payload) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        if epoch != self.epoch() {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        let supported = if download {
            self.0.descriptor.capabilities.attachment_downloads == HostCapability::Host
                && attachment_download_host_matches(&HostCapability::Host, &self.0.host)
        } else {
            self.0.descriptor.capabilities.attachment_files == HostCapability::Host
                && attachment_host_matches(&HostCapability::Host, &self.0.host)
        };
        if !supported || self.0.descriptor.capabilities.ui != HostCapability::Host {
            return Err(EngineError::new("UNKNOWN_OPERATION"));
        }
        if !self.0.ready.load(Ordering::SeqCst)
            || self.0.closed.load(Ordering::SeqCst)
            || self.0.stopping.load(Ordering::SeqCst)
        {
            return Err(EngineError::new("DISCONNECTED"));
        }
        let result = self
            .request(
                if download {
                    "engine.attachment.download"
                } else {
                    "engine.attachment.open"
                },
                payload,
            )
            .await?;
        if epoch != self.epoch() {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        if !self.0.ready.load(Ordering::SeqCst)
            || self.0.closed.load(Ordering::SeqCst)
            || self.0.stopping.load(Ordering::SeqCst)
        {
            return Err(EngineError::new("DISCONNECTED"));
        }
        Ok(result)
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
        timeout_at(
            request_deadline_at(operation, Instant::now()),
            self.request_raw(operation, payload),
        )
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
    async fn read_stdout<R: tokio::io::AsyncRead + Unpin>(&self, mut stdout: R) {
        let mut chunk = [0u8; 8192];
        let mut decoder = ProductionFrameDecoder::default();
        let mut stopped = self.0.stop.subscribe();
        loop {
            if *stopped.borrow() {
                break;
            }
            let read = async {
                if let Some(deadline) = decoder.deadline() {
                    timeout_at(deadline, stdout.read(&mut chunk))
                        .await
                        .map_err(|_| ())?
                        .map_err(|_| ())
                } else {
                    stdout.read(&mut chunk).await.map_err(|_| ())
                }
            };
            let count = tokio::select! {
                _ = stopped.changed() => break,
                result = read => match result {
                    Ok(0) | Err(()) => break,
                    Ok(count) => count,
                },
            };
            for byte in &chunk[..count] {
                match decoder.push(*byte, Instant::now()) {
                    Ok(Some(frame)) => {
                        if self.accept(frame).await.is_err() {
                            self.disconnect();
                            return;
                        }
                    }
                    Ok(None) => {}
                    Err(_) => {
                        self.disconnect();
                        return;
                    }
                }
            }
        }
        self.disconnect();
    }

    async fn accept(&self, frame: Value) -> Result<(), EngineError> {
        // A buffered frame cannot revive a retired owner or start a native
        // callback after teardown has already begun.
        if self.0.closed.load(Ordering::SeqCst) {
            return Err(EngineError::new("DISCONNECTED"));
        }
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
                        "engine.ownerState" => valid_owner_state(result),
                        "engine.oauth.callback" => {
                            crate::production_oauth::delivery_receipt(result)
                        }
                        "engine.tray.preference" => {
                            crate::production_tray_contracts::preference(result)
                        }
                        "engine.tray.preferenceCommand" => {
                            crate::production_tray_contracts::result(result)
                        }
                        "engine.ui.publish"
                        | "engine.attachment.open"
                        | "engine.attachment.download" => {
                            crate::production_ui_contracts::void_result(result)
                        }
                        "engine.agent.install" => contracts::agent_installer::result(result),
                        "engine.attachment.download.check" => result == &json!({"authorized":true}),
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
                forward_production_event(
                    &frame,
                    &current,
                    &self.0.last_event,
                    &*self.0.host.event_sink,
                )
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
            "host.oauth.register" | "host.oauth.open" | "host.oauth.retire" => {
                let retire = operation == "host.oauth.retire";
                let valid = if operation == "host.oauth.register" {
                    crate::production_oauth::registration(payload)
                } else {
                    crate::production_oauth::flow_request(payload)
                };
                if !valid {
                    return Err(EngineError::new("INVALID_ARGUMENTS"));
                }
                if self.0.descriptor.capabilities.oauth_flows != HostCapability::Host {
                    return Err(EngineError::new("UNKNOWN_OPERATION"));
                }
                if !self.0.prepared.load(Ordering::SeqCst)
                    || self.0.closed.load(Ordering::SeqCst)
                    || !retire
                        && (!self.0.ready.load(Ordering::SeqCst)
                            || self.0.stopping.load(Ordering::SeqCst))
                {
                    return Err(EngineError::new("DISCONNECTED"));
                }
                let host = self
                    .0
                    .host
                    .oauth
                    .as_ref()
                    .ok_or_else(|| EngineError::new("UNKNOWN_OPERATION"))?;
                let result = (host.invoke)(operation.into(), payload.clone(), self.epoch()).await?;
                let field = match operation {
                    "host.oauth.register" => "registered",
                    "host.oauth.open" => "opened",
                    _ => "retired",
                };
                if !contracts::object(&result, &["flowId", field], &[])
                    || result["flowId"] != payload["flowId"]
                    || result[field] != true
                {
                    return Err(EngineError::new("INVALID_RESULT"));
                }
                Ok(result)
            }
            "host.sleep.set" => {
                if !contracts::object(payload, &["enabled"], &[])
                    || !payload["enabled"].is_boolean()
                {
                    return Err(EngineError::new("INVALID_ARGUMENTS"));
                }
                if self.0.descriptor.capabilities.energy != HostCapability::Host {
                    return Err(EngineError::new("UNKNOWN_OPERATION"));
                }
                let enabled = payload["enabled"].as_bool().unwrap();
                if !self.0.prepared.load(Ordering::SeqCst)
                    || enabled
                        && (self.0.closed.load(Ordering::SeqCst)
                            || self.0.stopping.load(Ordering::SeqCst))
                {
                    return Err(EngineError::new("DISCONNECTED"));
                }
                let weak = Arc::downgrade(&self.0);
                let epoch = self.epoch();
                let current: ProductionEnergyScope = Arc::new(move || {
                    let inner = weak
                        .upgrade()
                        .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
                    if !inner.prepared.load(Ordering::SeqCst)
                        || inner.closed.load(Ordering::SeqCst)
                        || inner.stopping.load(Ordering::SeqCst)
                    {
                        return Err(EngineError::new("DISCONNECTED"));
                    }
                    if *inner
                        .epoch
                        .lock()
                        .map_err(|_| EngineError::new("DISCONNECTED"))?
                        != epoch
                    {
                        return Err(EngineError::new("STALE_EPOCH"));
                    }
                    Ok(())
                });
                energy_callback(
                    &self.0.host,
                    &self.0.descriptor.capabilities.energy,
                    payload,
                    current,
                )
                .await
            }
            "host.ui.snapshot" | "host.ui.command" | "host.ui.installerProgress" => {
                if self.0.closed.load(Ordering::SeqCst)
                    || self.0.stopping.load(Ordering::SeqCst)
                    || !self.0.prepared.load(Ordering::SeqCst)
                    || operation != "host.ui.snapshot" && !self.0.ready.load(Ordering::SeqCst)
                {
                    return Err(EngineError::new("DISCONNECTED"));
                }
                let epoch = self.epoch();
                let result = ui_callback(
                    &self.0.host,
                    &self.0.descriptor.capabilities.ui,
                    epoch.clone(),
                    operation,
                    payload,
                )
                .await?;
                if epoch != self.epoch() {
                    return Err(EngineError::new("STALE_EPOCH"));
                }
                if self.0.closed.load(Ordering::SeqCst) || self.0.stopping.load(Ordering::SeqCst) {
                    return Err(EngineError::new("DISCONNECTED"));
                }
                Ok(result)
            }
            "host.attachment.open" | "host.attachment.download" | "host.artifact.copyFile" => {
                if self.0.closed.load(Ordering::SeqCst)
                    || self.0.stopping.load(Ordering::SeqCst)
                    || !self.0.ready.load(Ordering::SeqCst)
                    || !self.0.prepared.load(Ordering::SeqCst)
                {
                    return Err(EngineError::new("DISCONNECTED"));
                }
                let epoch = self.epoch();
                let result = if operation == "host.artifact.copyFile" {
                    artifact_copy_callback(
                        &self.0.host,
                        &self.0.descriptor.capabilities.artifact_clipboard,
                        epoch.clone(),
                        payload,
                    )
                    .await?
                } else if operation == "host.attachment.download" {
                    attachment_download_callback(
                        &self.0.host,
                        &self.0.descriptor.capabilities.attachment_downloads,
                        epoch.clone(),
                        payload,
                    )
                    .await?
                } else {
                    attachment_callback(
                        &self.0.host,
                        &self.0.descriptor.capabilities.attachment_files,
                        epoch.clone(),
                        payload,
                    )
                    .await?
                };
                if epoch != self.epoch() {
                    return Err(EngineError::new("STALE_EPOCH"));
                }
                if self.0.closed.load(Ordering::SeqCst) || self.0.stopping.load(Ordering::SeqCst) {
                    return Err(EngineError::new("DISCONNECTED"));
                }
                Ok(result)
            }
            "host.workspace.cleanupObservation" => {
                if !cleanup_observation::request(payload) {
                    return Err(EngineError::new("INVALID_ARGUMENTS"));
                }
                if self.0.descriptor.capabilities.workspace_cleanup != HostCapability::Host {
                    return Err(EngineError::new("UNKNOWN_OPERATION"));
                }
                if !self.0.prepared.load(Ordering::SeqCst)
                    || self.0.closed.load(Ordering::SeqCst)
                    || self.0.stopping.load(Ordering::SeqCst) && payload["action"] != "release"
                {
                    return Err(EngineError::new("DISCONNECTED"));
                }
                let host = self
                    .0
                    .host
                    .workspace_cleanup
                    .as_ref()
                    .ok_or_else(|| EngineError::new("UNKNOWN_OPERATION"))?;
                let result = (host.invoke)(payload.clone(), self.epoch()).await?;
                if !cleanup_observation::result(payload["action"].as_str().unwrap(), &result) {
                    return Err(EngineError::new("INVALID_RESULT"));
                }
                Ok(result)
            }
            "host.production.prepare" => {
                if !contracts::object(payload, &["launchId", "resourceManifestSha256"], &[])
                    || payload["launchId"] != self.0.descriptor.launch_id
                    || payload["resourceManifestSha256"]
                        != self.0.descriptor.resource_manifest_sha256
                {
                    return Err(EngineError::new("INVALID_ARGUMENTS"));
                }
                #[cfg(any(target_os = "linux", windows))]
                self.0.scope.prove_ready()?;
                #[cfg(not(any(target_os = "linux", windows)))]
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
                if let Some(cleanup) = &self.0.host.workspace_cleanup {
                    (cleanup.close)().await?;
                }
                if let Some(oauth) = &self.0.host.oauth {
                    (oauth.close)().await?;
                }
                if let Some(files) = &self.0.host.workspace_file {
                    (files.close)().await?;
                }
                if let Some(energy) = &self.0.host.energy {
                    (energy.close)().await?;
                }
                if let Some(files) = &self.0.host.attachment_file {
                    (files.close)().await?;
                }
                if let Some(files) = &self.0.host.attachment_download {
                    (files.close)().await?;
                }
                if let Some(notifications) = &self.0.host.notification {
                    (notifications.close)().await?;
                }
                if let Some(files) = &self.0.host.artifact_clipboard {
                    (files.close)().await?;
                }
                #[cfg(any(target_os = "linux", windows))]
                self.0.scope.await_leader_only().await?;
                #[cfg(not(any(target_os = "linux", windows)))]
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
            "host.notification.show" | "host.notification.status" => {
                if self.0.closed.load(Ordering::SeqCst)
                    || self.0.stopping.load(Ordering::SeqCst)
                    || !self.0.ready.load(Ordering::SeqCst)
                    || !self.0.prepared.load(Ordering::SeqCst)
                {
                    return Err(EngineError::new("DISCONNECTED"));
                }
                let epoch = self.epoch();
                let result = notification_callback(
                    &self.0.host,
                    &self.0.descriptor.capabilities.notifications,
                    epoch.clone(),
                    operation,
                    payload,
                )
                .await?;
                if epoch != self.epoch() {
                    return Err(EngineError::new("STALE_EPOCH"));
                }
                if self.0.closed.load(Ordering::SeqCst) || self.0.stopping.load(Ordering::SeqCst) {
                    return Err(EngineError::new("DISCONNECTED"));
                }
                Ok(result)
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
// Advance only after the host accepts the invalidation. The caller retires the
// epoch on any error; recovery uses owner snapshots, never mutation replay.
fn forward_production_event(
    frame: &Value,
    current: &str,
    last_event: &Mutex<u64>,
    sink: &(dyn Fn(Value) -> Result<(), EngineError> + Send + Sync),
) -> Result<(), EngineError> {
    if !contracts::object(
        frame,
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
        || frame["engineEpoch"] != current
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
    let mut previous = last_event.lock().unwrap();
    if sequence <= *previous || !contracts::valid_event(operation, &frame["payload"]) {
        return Err(EngineError::new("INVALID_RESULT"));
    }
    sink(frame.clone())?;
    *previous = sequence;
    Ok(())
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
        // Transport regressions do not mint cgroup authority or launch a
        // guardian. Ordinary files cannot satisfy prove_ready/await_leader_only.
        #[cfg(test)]
        pub(super) fn transport_fixture(root: &Path) -> Arc<Self> {
            let directory = File::open(root).unwrap();
            Arc::new(Self {
                root: directory.try_clone().unwrap(),
                directory,
                name: CString::new("inert-transport-fixture").unwrap(),
                kill: Mutex::new(File::open("/dev/null").unwrap()),
                guardian_writer: Mutex::new(None),
                guardian: 0,
                leader: AtomicU64::new(0),
                guardian_reaped: AtomicBool::new(true),
                released: AtomicBool::new(true),
            })
        }
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
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| problem("DISCONNECTED", "production-private-stdout"))?;
            let (stop, mut stop_rx) = watch::channel(false);
            let (exited_tx, exited) = watch::channel(false);
            let engine = Self(Arc::new(Inner {
                stdin: AsyncMutex::new(Box::new(stdin)),
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
                #[cfg(test)]
                cancellation_budget: DEADLINE,
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
                // Pipe loss retires tickets too. Accepted raw observation work
                // retains its own owner/FD leases until NativeWorkOwner joins it.
                if let Some(cleanup) = &supervise.0.host.workspace_cleanup {
                    let _ = (cleanup.close)().await;
                }
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
            tokio::spawn(async move { reader.read_stdout(stdout).await });
            let mut guard = StartupGuard(engine.clone(), false);
            let bytes = descriptor_bytes(&descriptor)?;
            tokio::task::spawn_blocking(move || {
                write
                    .write_all(&bytes)
                    .map_err(|_| problem("DISCONNECTED", "production-private-fd3-write"))
            })
            .await
            .map_err(|_| problem("DISCONNECTED", "production-private-fd3-write"))??;
            engine.initialize_owner().await?;
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
    #[test]
    fn owner_failures_accept_only_finite_metadata_and_preserve_recovery_phase() {
        for code in OWNER_RECOVERY_CODES {
            let value =
                json!({"phase":"failed","stage":"database-preflight","code":code,"owned":false});
            assert!(valid_owner_state(&value));
            let error = owner_recovery_error(&value).unwrap();
            assert_eq!(error.code, *code);
            assert_eq!(error.startup_phase, Some("database-preflight"));
        }
        let mut value = json!({"phase":"blocked","stage":"credentials","code":"OWNER_DRAIN_BLOCKED","owned":true});
        assert_eq!(
            owner_recovery_error(&value).unwrap().code,
            "OWNER_DRAIN_BLOCKED"
        );
        value["error"] = json!("private canary");
        assert!(!valid_owner_state(&value));
        assert!(owner_recovery_error(&value).is_none());
        for (key, bad) in [
            ("phase", "unknown"),
            ("stage", "/private/profile"),
            ("code", "PROFILE_PRIVATE_CANARY"),
        ] {
            let mut value = json!({"phase":"failed","stage":"resources","code":"RESOURCE_UNAVAILABLE","owned":false});
            value[key] = json!(bad);
            assert!(!valid_owner_state(&value));
            assert!(owner_recovery_error(&value).is_none());
        }
        let ready = json!({"phase":"ready","stage":"ready","code":null,"owned":true});
        assert!(valid_owner_state(&ready));
        assert!(owner_recovery_error(&ready).is_none());
    }
    static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);
    pub(super) struct Temporary(pub(super) PathBuf);
    impl Temporary {
        pub(super) fn new() -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "21x-production-native-{}-{stamp}-{}",
                std::process::id(),
                TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
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
                workspace_cleanup: HostCapability::Unsupported,
                attachment_files: HostCapability::Unsupported,
                attachment_downloads: HostCapability::Unsupported,
                artifact_clipboard: HostCapability::Unsupported,
                tray: HostCapability::Unsupported,
                oauth_flows: HostCapability::Unsupported,
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
    #[cfg(target_os = "linux")]
    mod transport_integration {
        use super::*;
        use std::process::Stdio;
        use tokio::process::{Child, ChildStdout, Command};

        struct ObservedStdout {
            pipe: ChildStdout,
            entered: Option<oneshot::Sender<()>>,
        }
        impl tokio::io::AsyncRead for ObservedStdout {
            fn poll_read(
                self: Pin<&mut Self>,
                context: &mut std::task::Context<'_>,
                buffer: &mut tokio::io::ReadBuf<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                let this = self.get_mut();
                if let Some(entered) = this.entered.take() {
                    let _ = entered.send(());
                }
                tokio::io::AsyncRead::poll_read(Pin::new(&mut this.pipe), context, buffer)
            }
        }

        struct Fixture {
            engine: ProductionEngine,
            child: Child,
            stdout: Option<ChildStdout>,
            _root: Temporary,
            // Keep receivers alive: stop notification must not depend on the
            // launcher's supervisor, which this transport fixture does not run.
            _stop: watch::Receiver<bool>,
            _exited: watch::Sender<bool>,
        }
        impl Fixture {
            fn new(host: ProductionNativeHost) -> Self {
                let root = Temporary::new();
                // Shell builtins only: this fixture has no descendant process,
                // profile, model backend or production containment authority.
                let mut child = Command::new("/bin/sh")
                    .args(["-c", "IFS= read -r request; printf 'written\n'; while IFS= read -r request; do :; done"])
                    .env_clear()
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .kill_on_drop(true)
                    .spawn().unwrap();
                let stdin = child.stdin.take().unwrap();
                let stdout = child.stdout.take();
                let (stop, stop_rx) = watch::channel(false);
                let (exited_tx, exited) = watch::channel(false);
                let engine = ProductionEngine(Arc::new(Inner {
                    stdin: AsyncMutex::new(Box::new(stdin)),
                    pending: Mutex::new(HashMap::new()),
                    epoch: Mutex::new("transport-fixture".into()),
                    next: AtomicU64::new(1),
                    closed: AtomicBool::new(false),
                    ready: AtomicBool::new(true),
                    stopping: AtomicBool::new(false),
                    prepared: AtomicBool::new(true),
                    drained: AtomicBool::new(false),
                    last_callback: Mutex::new(0),
                    last_event: Mutex::new(0),
                    request_slots: Arc::new(Semaphore::new(128)),
                    queue_bytes: Arc::new(Semaphore::new(4 * 1024 * 1024)),
                    callback_slots: Arc::new(Semaphore::new(128)),
                    callback_work: AtomicU64::new(0),
                    cancellation_budget: Duration::from_millis(20),
                    stop,
                    exited,
                    descriptor: descriptor(&root.0),
                    host,
                    scope: linux::Scope::transport_fixture(&root.0),
                }));
                Self {
                    engine,
                    child,
                    stdout,
                    _root: root,
                    _stop: stop_rx,
                    _exited: exited_tx,
                }
            }
            async fn pending_request(
                &mut self,
            ) -> tokio::task::JoinHandle<Result<Value, EngineError>> {
                self.pending_request_for("engine.ping").await
            }
            async fn pending_request_for(
                &mut self,
                operation: &'static str,
            ) -> tokio::task::JoinHandle<Result<Value, EngineError>> {
                let engine = self.engine.clone();
                let call =
                    tokio::spawn(async move { engine.request_raw(operation, json!({})).await });
                let mut written = [0; 8];
                timeout(
                    Duration::from_secs(2),
                    self.stdout.as_mut().unwrap().read_exact(&mut written),
                )
                .await
                .unwrap()
                .unwrap();
                assert_eq!(&written, b"written\n");
                assert_eq!(self.engine.0.pending.lock().unwrap().len(), 1);
                call
            }
            async fn reap(&mut self) {
                self.engine.disconnect();
                self.child.start_kill().unwrap();
                timeout(Duration::from_secs(2), self.child.wait())
                    .await
                    .unwrap()
                    .unwrap();
            }
        }
        #[tokio::test]
        async fn private_oauth_claim_receipt_uses_the_actual_pending_validator() {
            let mut fixture = Fixture::new(ui_host());
            let request = fixture.pending_request_for("engine.oauth.callback").await;
            fixture.engine.accept(json!({"kind":"response","protocolVersion":1,"engineEpoch":"transport-fixture","requestId":"host:1","result":{"accepted":true}})).await.unwrap();
            assert_eq!(request.await.unwrap().unwrap(), json!({"accepted":true}));
            assert_eq!(
                fixture
                    .engine
                    .invoke("transport-fixture", "engine.oauth.callback", json!({}))
                    .await
                    .unwrap_err()
                    .code,
                "UNKNOWN_OPERATION"
            );
            assert_eq!(
                fixture
                    .engine
                    .deliver_oauth("foreign-epoch", json!({}))
                    .await
                    .unwrap_err()
                    .code,
                "STALE_EPOCH"
            );
            assert_eq!(
                fixture
                    .engine
                    .deliver_oauth("transport-fixture", json!({}))
                    .await
                    .unwrap_err()
                    .code,
                "UNKNOWN_OPERATION"
            );
            fixture.reap().await;
        }
        #[tokio::test]
        async fn private_oauth_claim_receipt_refuses_extra_authority_or_secrets() {
            let mut fixture = Fixture::new(ui_host());
            let request = fixture.pending_request_for("engine.oauth.callback").await;
            assert_eq!(fixture.engine.accept(json!({"kind":"response","protocolVersion":1,"engineEpoch":"transport-fixture","requestId":"host:1","result":{"accepted":true,"sourceId":"foreign"}})).await.unwrap_err().code, "INVALID_RESULT");
            assert_eq!(request.await.unwrap().unwrap_err().code, "INVALID_RESULT");
            fixture.reap().await;
        }
        #[tokio::test]
        async fn owner_recovery_response_uses_the_real_pending_request_validator() {
            let mut fixture = Fixture::new(ui_host());
            let request = fixture.pending_request_for("engine.ownerState").await;
            let result = json!({"phase":"failed","stage":"database-preflight","code":"PROFILE_DATABASE_LOCKED","owned":false});
            fixture.engine.accept(json!({"kind":"response","protocolVersion":1,"engineEpoch":"transport-fixture","requestId":"host:1","result":result})).await.unwrap();
            let state = request.await.unwrap().unwrap();
            let error = owner_recovery_error(&state).unwrap();
            assert_eq!(error.code, "PROFILE_DATABASE_LOCKED");
            assert_eq!(error.startup_phase, Some("database-preflight"));
            assert!(fixture.engine.0.pending.lock().unwrap().is_empty());
            fixture.reap().await;
        }
        async fn retired(engine: &ProductionEngine) {
            timeout(Duration::from_secs(2), async {
                while !engine.0.closed.load(Ordering::SeqCst) {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(!engine.0.ready.load(Ordering::SeqCst));
            assert!(*engine.0.stop.borrow());
            assert!(engine.0.pending.lock().unwrap().is_empty());
            assert_eq!(engine.0.request_slots.available_permits(), 128);
        }
        #[tokio::test]
        async fn actual_cleanup_callback_enforces_action_result_and_retained_epoch_authority() {
            let calls = Arc::new(AtomicU64::new(0));
            let invoked = calls.clone();
            let closed = Arc::new(AtomicBool::new(false));
            let closing = closed.clone();
            let mut host = ui_host();
            host.workspace_cleanup = Some(ProductionCleanupHost {
                invoke: Arc::new(move |request, epoch| {
                    invoked.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async move {
                        assert_eq!(epoch, "transport-fixture");
                        Ok(if request["action"] == "release" {
                            json!({"released":true})
                        } else {
                            json!({"status":"unknown"})
                        })
                    })
                }),
                close: Arc::new(move || {
                    closing.store(true, Ordering::SeqCst);
                    Box::pin(async { Ok(()) })
                }),
            });
            let mut fixture = Fixture::new(host);
            let frame = |payload| json!({"kind":"request","protocolVersion":1,"engineEpoch":"transport-fixture","requestId":"service:1","operation":"host.workspace.cleanupObservation","payload":payload});
            let acquire = frame(json!({"version":1,"action":"acquire","taskId":"task_fixture"}));
            assert_eq!(
                fixture.engine.callback(&acquire).await.unwrap_err().code,
                "UNKNOWN_OPERATION"
            );
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            Arc::get_mut(&mut fixture.engine.0)
                .unwrap()
                .descriptor
                .capabilities
                .workspace_cleanup = HostCapability::Host;
            assert_eq!(
                fixture.engine.callback(&acquire).await.unwrap(),
                json!({"status":"unknown"})
            );
            assert!(fixture.engine.callback(&frame(json!({"version":1,"action":"acquire","taskId":"task_fixture","path":"/foreign"}))).await.is_err());
            fixture.engine.0.stopping.store(true, Ordering::SeqCst);
            assert_eq!(
                fixture.engine.callback(&acquire).await.unwrap_err().code,
                "DISCONNECTED"
            );
            let release = frame(
                json!({"version":1,"action":"release","taskId":"task_fixture","leaseId":"00112233-4455-4677-8899-aabbccddeeff"}),
            );
            assert_eq!(
                fixture.engine.callback(&release).await.unwrap(),
                json!({"released":true})
            );
            assert_eq!(calls.load(Ordering::SeqCst), 2);
            (fixture
                .engine
                .0
                .host
                .workspace_cleanup
                .as_ref()
                .unwrap()
                .close)()
            .await
            .unwrap();
            assert!(closed.load(Ordering::SeqCst));
            fixture.reap().await;
        }

        #[tokio::test]
        async fn actual_request_guard_retires_epoch_when_cancel_pipe_write_fails() {
            let mut fixture = Fixture::new(ui_host());
            let call = fixture.pending_request().await;
            // Reap the only pipe reader before cancellation. The subsequent
            // real ChildStdin write must fail; no synthetic writer is involved.
            fixture.child.start_kill().unwrap();
            timeout(Duration::from_secs(2), fixture.child.wait())
                .await
                .unwrap()
                .unwrap();
            call.abort();
            assert!(call.await.unwrap_err().is_cancelled());
            retired(&fixture.engine).await;
            assert_eq!(
                fixture
                    .engine
                    .request_raw("engine.ping", json!({}))
                    .await
                    .unwrap_err()
                    .code,
                "DISCONNECTED"
            );
            assert_eq!(fixture.engine.0.next.load(Ordering::SeqCst), 2);
        }
        #[tokio::test]
        async fn actual_request_guard_retires_epoch_when_cancel_writer_is_blocked() {
            let (entered_tx, entered_rx) = oneshot::channel();
            let (release_tx, release_rx) = oneshot::channel();
            let entered = Mutex::new(Some(entered_tx));
            let release = Mutex::new(Some(release_rx));
            let mut host = ui_host();
            host.open_external = Some(Arc::new(move |_| {
                let entered = entered.lock().unwrap().take().unwrap();
                let release = release.lock().unwrap().take().unwrap();
                Box::pin(async move {
                    let _ = entered.send(());
                    let _ = release.await;
                    Ok(())
                })
            }));
            let mut fixture = Fixture::new(host);
            Arc::get_mut(&mut fixture.engine.0)
                .unwrap()
                .descriptor
                .capabilities
                .external_urls = HostCapability::Host;
            let call = fixture.pending_request().await;
            let engine = fixture.engine.clone();
            engine.accept(json!({"kind":"request","protocolVersion":1,"engineEpoch":"transport-fixture","requestId":"service:1","operation":"host.shell.openExternal","payload":{"url":"https://example.com/"}})).await.unwrap();
            timeout(Duration::from_secs(2), entered_rx)
                .await
                .unwrap()
                .unwrap();
            let writer = engine.0.stdin.lock().await;
            call.abort();
            assert!(call.await.unwrap_err().is_cancelled());
            retired(&engine).await;
            // The raw pipe and child remain owned even though the cancellation
            // wait expired. Release the lock only after retirement is observed.
            assert!(fixture.child.try_wait().unwrap().is_none());
            assert_eq!(engine.0.callback_work.load(Ordering::SeqCst), 1);
            assert_eq!(engine.0.callback_slots.available_permits(), 127);
            drop(writer);
            release_tx.send(()).unwrap();
            timeout(Duration::from_secs(2), async {
                while engine.0.callback_work.load(Ordering::SeqCst) != 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert_eq!(engine.0.callback_slots.available_permits(), 128);
            assert_eq!(engine.0.next.load(Ordering::SeqCst), 2);
            fixture.reap().await;
        }
        #[tokio::test]
        async fn actual_stdout_reader_stops_without_waiting_for_child_eof() {
            let mut fixture = Fixture::new(ui_host());
            let engine = fixture.engine.clone();
            let (entered_tx, entered_rx) = oneshot::channel();
            let stdout = ObservedStdout {
                pipe: fixture.stdout.take().unwrap(),
                entered: Some(entered_tx),
            };
            let reader = tokio::spawn(async move { engine.read_stdout(stdout).await });
            // Child has not received input and keeps stdout open indefinitely.
            timeout(Duration::from_secs(2), entered_rx)
                .await
                .unwrap()
                .unwrap();
            fixture.engine.disconnect();
            timeout(Duration::from_secs(2), reader)
                .await
                .unwrap()
                .unwrap();
            assert!(fixture.child.try_wait().unwrap().is_none());
            assert_eq!(fixture.engine.0.callback_work.load(Ordering::SeqCst), 0);
            fixture.reap().await;
        }
        #[tokio::test]
        async fn actual_stdout_reader_refuses_callback_buffered_after_retirement() {
            let owner: Arc<Mutex<Option<ProductionEngine>>> = Arc::new(Mutex::new(None));
            let close_owner = owner.clone();
            let invoked = Arc::new(AtomicU64::new(0));
            let callback_invoked = invoked.clone();
            let mut host = ui_host();
            host.event_sink = Arc::new(move |_| {
                close_owner.lock().unwrap().as_ref().unwrap().disconnect();
                Ok(())
            });
            host.open_external = Some(Arc::new(move |_| {
                callback_invoked.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(()) })
            }));
            let mut fixture = Fixture::new(host);
            // This route would be valid if dispatched before retirement.
            Arc::get_mut(&mut fixture.engine.0)
                .unwrap()
                .descriptor
                .capabilities
                .external_urls = HostCapability::Host;
            *owner.lock().unwrap() = Some(fixture.engine.clone());
            let event = json!({"kind":"event","protocolVersion":1,"engineEpoch":"transport-fixture","operation":"terminal:data","payload":{"id":"terminal:fixture","data":"retire"},"sequence":1});
            let callback = json!({"kind":"request","protocolVersion":1,"engineEpoch":"transport-fixture","requestId":"service:1","operation":"host.shell.openExternal","payload":{"url":"https://example.com/"}});
            let mut bytes = serde_json::to_vec(&event).unwrap();
            bytes.push(b'\n');
            bytes.extend(serde_json::to_vec(&callback).unwrap());
            bytes.push(b'\n');
            // Prebuffer both frames in one read. The first sink retires the
            // actual owner; the second must not allocate or launch a callback.
            fixture.engine.read_stdout(bytes.as_slice()).await;
            assert_eq!(
                fixture.engine.accept(callback).await.unwrap_err().code,
                "DISCONNECTED"
            );
            assert_eq!(*fixture.engine.0.last_callback.lock().unwrap(), 0);
            assert_eq!(fixture.engine.0.callback_work.load(Ordering::SeqCst), 0);
            assert_eq!(fixture.engine.0.callback_slots.available_permits(), 128);
            assert_eq!(invoked.load(Ordering::SeqCst), 0);
            owner.lock().unwrap().take();
            fixture.reap().await;
        }
    }

    #[test]
    fn production_frames_preserve_fragmented_utf8_and_coalesced_boundaries() {
        let mut decoder = ProductionFrameDecoder::default();
        let expected = [json!({"text":"\u{001b}[31mλ雪"}), json!({"defined":false})];
        let now = Instant::now();
        let mut received = Vec::new();
        for frame in &expected {
            let mut bytes = serde_json::to_vec(frame).unwrap();
            bytes.push(b'\n');
            for byte in bytes {
                if let Some(value) = decoder.push(byte, now).unwrap() {
                    received.push(value);
                }
            }
            assert!(decoder.deadline().is_none());
            assert!(decoder.bytes.is_empty());
        }
        assert_eq!(received, expected);
    }

    #[test]
    fn production_partial_frame_deadline_is_not_extended_by_trickled_bytes() {
        let mut decoder = ProductionFrameDecoder::default();
        let start = Instant::now();
        assert!(decoder.deadline().is_none());
        decoder.push(b'{', start).unwrap();
        decoder
            .push(b' ', start + DEADLINE - Duration::from_millis(1))
            .unwrap();
        assert_eq!(decoder.deadline(), Some(start + DEADLINE));
        assert_eq!(
            decoder.push(b'}', start + DEADLINE).unwrap_err().code,
            "TIMEOUT"
        );
    }

    #[test]
    fn production_frames_reject_oversize_and_malformed_input_before_dispatch() {
        let now = Instant::now();
        let mut decoder = ProductionFrameDecoder::default();
        // Exactly the frame cap is permitted; the next byte is never retained.
        for _ in 0..MAX_FRAME {
            decoder.push(b' ', now).unwrap();
        }
        assert_eq!(decoder.push(b' ', now).unwrap_err().code, "FRAME_TOO_LARGE");
        assert_eq!(decoder.bytes.len(), MAX_FRAME);
        let mut exact = ProductionFrameDecoder::default();
        exact.push(b'"', now).unwrap();
        for _ in 0..MAX_FRAME - 2 {
            exact.push(b'x', now).unwrap();
        }
        exact.push(b'"', now).unwrap();
        assert_eq!(
            exact
                .push(b'\n', now)
                .unwrap()
                .unwrap()
                .as_str()
                .unwrap()
                .len(),
            MAX_FRAME - 2
        );
        let mut decoder = ProductionFrameDecoder::default();
        assert_eq!(decoder.push(b'\n', now).unwrap_err().code, "INVALID_FRAME");
        decoder.push(0xff, now).unwrap();
        assert_eq!(decoder.push(b'\n', now).unwrap_err().code, "INVALID_FRAME");
    }

    #[test]
    fn production_event_saturation_retains_cursor_and_old_epochs_never_reach_host() {
        let cursor = Mutex::new(0);
        let frame = json!({"kind":"event","protocolVersion":1,"engineEpoch":"epoch-current", "operation":"terminal:data","payload":{"id":"terminal:fixture","data":"output"},"sequence":1});
        let saturated = |_: Value| Err(EngineError::new("BACKPRESSURE"));
        assert_eq!(
            forward_production_event(&frame, "epoch-current", &cursor, &saturated)
                .unwrap_err()
                .code,
            "BACKPRESSURE"
        );
        assert_eq!(*cursor.lock().unwrap(), 0);
        let received = Mutex::new(Vec::new());
        let sink = |value: Value| {
            received.lock().unwrap().push(value);
            Ok(())
        };
        assert!(forward_production_event(&frame, "epoch-replacement", &cursor, &sink).is_err());
        assert!(received.lock().unwrap().is_empty());
        forward_production_event(&frame, "epoch-current", &cursor, &sink).unwrap();
        assert_eq!(*cursor.lock().unwrap(), 1);
        assert!(forward_production_event(&frame, "epoch-current", &cursor, &sink).is_err());
        assert_eq!(received.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn energy_uses_only_a_captured_host_and_releases_after_acquisition_authority_retires() {
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = calls.clone();
        let mut host = ui_host();
        assert!(energy_host_matches(&HostCapability::Unsupported, &host));
        assert!(!energy_host_matches(&HostCapability::Host, &host));
        host.energy = Some(ProductionEnergyHost {
            invoke: Arc::new(move |active, _| {
                recorded.lock().unwrap().push(active);
                Box::pin(async move { Ok(active) })
            }),
            close: Arc::new(|| Box::pin(async { Ok(()) })),
        });
        let valid: ProductionEnergyScope = Arc::new(|| Ok(()));
        assert_eq!(
            energy_callback(
                &host,
                &HostCapability::Host,
                &json!({"enabled":true}),
                valid.clone()
            )
            .await
            .unwrap(),
            json!({"enabled":true})
        );
        let retired: ProductionEnergyScope = Arc::new(|| Err(EngineError::new("STALE_EPOCH")));
        assert_eq!(
            energy_callback(
                &host,
                &HostCapability::Host,
                &json!({"enabled":true}),
                retired.clone()
            )
            .await
            .unwrap_err()
            .code,
            "STALE_EPOCH"
        );
        assert_eq!(
            energy_callback(
                &host,
                &HostCapability::Host,
                &json!({"enabled":false}),
                retired
            )
            .await
            .unwrap(),
            json!({"enabled":false})
        );
        assert!(!energy_host_matches(&HostCapability::Unsupported, &host));
        for payload in [
            json!({"enabled":"true"}),
            json!({"enabled":true,"flags":8}),
            json!({"enabled":true,"request":"/foreign"}),
            json!({"active":true}),
        ] {
            assert_eq!(
                energy_callback(&host, &HostCapability::Host, &payload, valid.clone())
                    .await
                    .unwrap_err()
                    .code,
                "INVALID_ARGUMENTS"
            );
        }
        assert_eq!(
            energy_callback(
                &host,
                &HostCapability::Unsupported,
                &json!({"enabled":true}),
                valid
            )
            .await
            .unwrap_err()
            .code,
            "UNKNOWN_OPERATION"
        );
        assert_eq!(*calls.lock().unwrap(), vec![true, false]);
    }
    #[tokio::test]
    async fn energy_does_not_publish_a_late_activation_after_its_scope_is_revoked() {
        let live = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let revoke = live.clone();
        let mut host = ui_host();
        host.energy = Some(ProductionEnergyHost {
            invoke: Arc::new(move |enabled, _| {
                revoke.store(false, Ordering::SeqCst);
                Box::pin(async move { Ok(enabled) })
            }),
            close: Arc::new(|| Box::pin(async { Ok(()) })),
        });
        let current: ProductionEnergyScope = Arc::new(move || {
            if live.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(EngineError::new("STALE_EPOCH"))
            }
        });
        assert_eq!(
            energy_callback(
                &host,
                &HostCapability::Host,
                &json!({"enabled":true}),
                current
            )
            .await
            .unwrap_err()
            .code,
            "STALE_EPOCH"
        );
    }
    #[tokio::test]
    async fn notification_callbacks_derive_inactive_policy_from_exact_private_operation_only() {
        let flags = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = flags.clone();
        let mut host = ui_host();
        host.notification = Some(ProductionNotificationHost {
            invoke: Arc::new(move |title, body, inactive, epoch| {
                assert_eq!(title, "Review");
                assert_eq!(body, "");
                assert_eq!(epoch, "epoch-fixture");
                captured.lock().unwrap().push(inactive);
                Box::pin(async { Ok(true) })
            }),
            close: Arc::new(|| Box::pin(async { Ok(()) })),
        });
        for operation in ["host.notification.show", "host.notification.status"] {
            assert_eq!(
                notification_callback(
                    &host,
                    &HostCapability::Host,
                    "epoch-fixture".into(),
                    operation,
                    &json!({"title":"Review","body":""})
                )
                .await
                .unwrap(),
                json!({"shown":true})
            );
        }
        assert_eq!(*flags.lock().unwrap(), vec![false, true]);
        for operation in ["notifications:show", "host.notification.fake"] {
            assert_eq!(
                notification_callback(
                    &host,
                    &HostCapability::Host,
                    "epoch-fixture".into(),
                    operation,
                    &json!({"title":"Review","body":""})
                )
                .await
                .unwrap_err()
                .code,
                "UNKNOWN_OPERATION"
            );
        }
        assert_eq!(
            notification_callback(
                &host,
                &HostCapability::Unsupported,
                "epoch-fixture".into(),
                "host.notification.show",
                &json!({"title":"Review","body":""})
            )
            .await
            .unwrap_err()
            .code,
            "UNKNOWN_OPERATION"
        );
        for value in [
            json!({"title":"Review","body":"","inactive":false}),
            json!({"title":"Review","body":"","icon":"/private"}),
            json!({"title":"é".repeat(81),"body":""}),
            json!({"title":"Review","body":"\u{001b}[31m"}),
        ] {
            assert_eq!(
                notification_callback(
                    &host,
                    &HostCapability::Host,
                    "epoch-fixture".into(),
                    "host.notification.status",
                    &value
                )
                .await
                .unwrap_err()
                .code,
                "INVALID_ARGUMENTS"
            );
        }
        assert_eq!(flags.lock().unwrap().len(), 2);
    }
    #[tokio::test]
    async fn artifact_clipboard_requires_its_own_host_ui_and_exact_result() {
        let mut host = ui_host();
        assert!(artifact_clipboard_host_matches(
            &HostCapability::Unsupported,
            &host
        ));
        assert!(!artifact_clipboard_host_matches(
            &HostCapability::Host,
            &host
        ));
        host.artifact_clipboard = Some(ProductionArtifactClipboardHost {
            invoke: Arc::new(|_, _, _, _| Box::pin(async { Ok(json!({"mode":"path"})) })),
            close: Arc::new(|| Box::pin(async { Ok(()) })),
        });
        host.ui_snapshot = Some(Arc::new(|_| {
            Box::pin(async { Ok(json!({"available":false})) })
        }));
        host.ui_command = Some(Arc::new(|_, lease, _| {
            Box::pin(async move { Ok(json!({"ok":true,"leaseId":lease})) })
        }));
        assert!(artifact_clipboard_host_matches(
            &HostCapability::Host,
            &host
        ));
        assert!(!artifact_clipboard_host_matches(
            &HostCapability::Unsupported,
            &host
        ));
        let payload = json!({"receipt":{"version":1,"taskId":"task_fixture","workspaceRoot":"/workspace","path":"/workspace/task_fixture/report.md","root":{"path":"/workspace","kind":"directory","dev":"1","ino":"2","size":"4096","nlink":"2"},"ancestors":[{"path":"/workspace/task_fixture","kind":"directory","dev":"1","ino":"3","size":"4096","nlink":"2"}],"target":{"path":"/workspace/task_fixture/report.md","kind":"file","dev":"1","ino":"4","size":"10","nlink":"1"}},"leaseId":"document_fixture_1","authorizationId":"12345678-1234-4234-9234-123456789abc"});
        assert_eq!(
            artifact_copy_callback(&host, &HostCapability::Host, "epoch".into(), &payload)
                .await
                .unwrap_err()
                .code,
            "INVALID_RESULT"
        );
        host.artifact_clipboard.as_mut().unwrap().invoke =
            Arc::new(|_, _, _, _| Box::pin(async { Ok(json!({"mode":"file"})) }));
        assert_eq!(
            artifact_copy_callback(&host, &HostCapability::Host, "epoch".into(), &payload)
                .await
                .unwrap(),
            json!({"mode":"file"})
        );
        let mut injected = payload.clone();
        injected["path"] = json!("/private");
        assert_eq!(
            artifact_copy_callback(&host, &HostCapability::Host, "epoch".into(), &injected)
                .await
                .unwrap_err()
                .code,
            "INVALID_ARGUMENTS"
        );
        host.ui_command = None;
        assert!(!artifact_clipboard_host_matches(
            &HostCapability::Host,
            &host
        ));
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
        assert!(descriptor_bytes(&bad).is_ok());
        bad = value;
        bad.paths.workspace_root = PathBuf::from("relative");
        assert!(descriptor_bytes(&bad).is_err());
    }
    fn ui_host() -> ProductionNativeHost {
        ProductionNativeHost {
            oauth: None,
            workspace_cleanup: None,
            workspace_file: None,
            attachment_file: None,
            attachment_download: None,
            artifact_clipboard: None,
            event_sink: Arc::new(|_| Ok(())),
            open_external: None,
            notification: None,
            energy: None,
            ui_snapshot: None,
            ui_command: None,
            installer_progress: None,
        }
    }
    #[test]
    fn ui_descriptor_requires_both_owned_callbacks_and_unsupported_has_none() {
        let root = Temporary::new();
        let mut descriptor = descriptor(&root.0);
        descriptor.capabilities.ui = HostCapability::Host;
        assert!(descriptor_bytes(&descriptor).is_ok());
        let mut host = ui_host();
        assert!(!ui_host_matches(&HostCapability::Host, &host));
        assert!(ui_host_matches(&HostCapability::Unsupported, &host));
        host.ui_snapshot = Some(Arc::new(|_| {
            Box::pin(async { Ok(json!({"available":false})) })
        }));
        assert!(!ui_host_matches(&HostCapability::Host, &host));
        assert!(!ui_host_matches(&HostCapability::Unsupported, &host));
        host.ui_command = Some(Arc::new(|_, lease, _| {
            Box::pin(async move { Ok(json!({"ok":true,"leaseId":lease})) })
        }));
        assert!(ui_host_matches(&HostCapability::Host, &host));
    }
    #[tokio::test]
    async fn unsupported_ui_never_probes_native_callbacks_and_exact_results_are_required() {
        let probes = Arc::new(AtomicU64::new(0));
        let count = probes.clone();
        let mut host = ui_host();
        host.ui_snapshot = Some(Arc::new(move |epoch| {
            count.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                assert_eq!(epoch, "epoch-fixture");
                Ok(json!({"available":true,"leaseId":"lease:1"}))
            })
        }));
        host.ui_command = Some(Arc::new(|_, lease, _| {
            Box::pin(async move { Ok(json!({"ok":true,"leaseId":lease})) })
        }));
        assert_eq!(
            ui_callback(
                &host,
                &HostCapability::Unsupported,
                "epoch-fixture".into(),
                "host.ui.snapshot",
                &json!({})
            )
            .await
            .unwrap_err()
            .code,
            "UNKNOWN_OPERATION"
        );
        assert_eq!(probes.load(Ordering::SeqCst), 0);
        assert_eq!(
            ui_callback(
                &host,
                &HostCapability::Host,
                "epoch-fixture".into(),
                "host.ui.snapshot",
                &json!({"caller":"main"})
            )
            .await
            .unwrap_err()
            .code,
            "INVALID_ARGUMENTS"
        );
        assert_eq!(probes.load(Ordering::SeqCst), 0);
        assert_eq!(
            ui_callback(
                &host,
                &HostCapability::Host,
                "epoch-fixture".into(),
                "host.ui.snapshot",
                &json!({})
            )
            .await
            .unwrap()["leaseId"],
            "lease:1"
        );
        host.ui_snapshot = Some(Arc::new(|_| {
            Box::pin(async { Ok(json!({"available":true,"leaseId":"lease:1","window":"foreign"})) })
        }));
        assert_eq!(
            ui_callback(
                &host,
                &HostCapability::Host,
                "epoch-fixture".into(),
                "host.ui.snapshot",
                &json!({})
            )
            .await
            .unwrap_err()
            .code,
            "INVALID_RESULT"
        );
    }
    #[tokio::test]
    async fn ui_commands_keep_exact_epoch_and_lease_and_wait_for_real_callback_completion() {
        let (entered_tx, entered_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel();
        let entered = Arc::new(Mutex::new(Some(entered_tx)));
        let finish = Arc::new(Mutex::new(Some(finish_rx)));
        let calls = Arc::new(AtomicU64::new(0));
        let mut host = ui_host();
        host.ui_snapshot = Some(Arc::new(|_| {
            Box::pin(async { Ok(json!({"available":false})) })
        }));
        let call_count = calls.clone();
        host.ui_command = Some(Arc::new(move |command, lease, epoch| {
            call_count.fetch_add(1, Ordering::SeqCst);
            assert_eq!(command, json!({"kind":"close_task_panel","taskId":"task"}));
            assert_eq!(lease, "lease:1");
            assert_eq!(epoch, "epoch-fixture");
            let entered = entered.lock().unwrap().take().unwrap();
            let finish = finish.lock().unwrap().take().unwrap();
            Box::pin(async move {
                let _ = entered.send(());
                finish.await.unwrap();
                Ok(json!({"ok":true,"leaseId":lease}))
            })
        }));
        let bad = json!({"command":{"kind":"close_task_panel","taskId":"task","window":"main"},"leaseId":"lease:1"});
        assert_eq!(
            ui_callback(
                &host,
                &HostCapability::Host,
                "epoch-fixture".into(),
                "host.ui.command",
                &bad
            )
            .await
            .unwrap_err()
            .code,
            "INVALID_ARGUMENTS"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        // Private ingress owns a spawned raw callback independently of its
        // public request future; dropping its waiter cannot cancel that task.
        let completed = Arc::new(AtomicBool::new(false));
        let finished = completed.clone();
        let work = tokio::spawn(async move {
            let answer = ui_callback(
                &host,
                &HostCapability::Host,
                "epoch-fixture".into(),
                "host.ui.command",
                &json!({"command":{"kind":"close_task_panel","taskId":"task"},"leaseId":"lease:1"}),
            )
            .await;
            assert_eq!(answer.unwrap(), json!({"ok":true,"leaseId":"lease:1"}));
            finished.store(true, Ordering::SeqCst);
        });
        entered_rx.await.unwrap();
        assert!(!completed.load(Ordering::SeqCst));
        drop(work);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        finish_tx.send(()).unwrap();
        timeout(Duration::from_secs(1), async {
            while !completed.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let mut foreign = ui_host();
        foreign.ui_snapshot = Some(Arc::new(|_| {
            Box::pin(async { Ok(json!({"available":false})) })
        }));
        foreign.ui_command = Some(Arc::new(|_, _, _| {
            Box::pin(async { Ok(json!({"ok":true,"leaseId":"foreign"})) })
        }));
        assert_eq!(
            ui_callback(
                &foreign,
                &HostCapability::Host,
                "epoch-fixture".into(),
                "host.ui.command",
                &json!({"command":{"kind":"close_task_panel","taskId":"task"},"leaseId":"lease:1"})
            )
            .await
            .unwrap_err()
            .code,
            "INVALID_RESULT"
        );
    }
    #[tokio::test]
    async fn installer_progress_requires_its_actual_callback_and_exact_document_ack() {
        let mut host = ui_host();
        host.ui_snapshot = Some(Arc::new(|_| {
            Box::pin(async { Ok(json!({"available":false})) })
        }));
        host.ui_command = Some(Arc::new(|_, lease, _| {
            Box::pin(async move { Ok(json!({"ok":true,"leaseId":lease})) })
        }));
        let payload = json!({"progress":{"agentName":"codex","stage":"starting","output":"Preparing CLI installation.","percent":5},"leaseId":"ui:1"});
        assert!(ui_host_matches(&HostCapability::Host, &host));
        assert_eq!(
            ui_callback(
                &host,
                &HostCapability::Host,
                "epoch-fixture".into(),
                "host.ui.installerProgress",
                &payload
            )
            .await
            .unwrap_err()
            .code,
            "UNKNOWN_OPERATION"
        );
        let count = Arc::new(AtomicU64::new(0));
        let calls = count.clone();
        host.installer_progress = Some(Arc::new(move |progress, lease, epoch| {
            calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(progress["agentName"], "codex");
            assert_eq!(lease, "ui:1");
            assert_eq!(epoch, "epoch-fixture");
            Box::pin(async move { Ok(json!({"ok":true,"leaseId":lease})) })
        }));
        assert!(!ui_host_matches(&HostCapability::Unsupported, &host));
        assert_eq!(
            ui_callback(
                &host,
                &HostCapability::Unsupported,
                "epoch-fixture".into(),
                "host.ui.installerProgress",
                &payload
            )
            .await
            .unwrap_err()
            .code,
            "UNKNOWN_OPERATION"
        );
        assert_eq!(count.load(Ordering::SeqCst), 0);
        let mut bad = payload.clone();
        bad["progress"]["output"] = json!("token=private");
        assert_eq!(
            ui_callback(
                &host,
                &HostCapability::Host,
                "epoch-fixture".into(),
                "host.ui.installerProgress",
                &bad
            )
            .await
            .unwrap_err()
            .code,
            "INVALID_ARGUMENTS"
        );
        bad = payload.clone();
        bad["caller"] = json!("main");
        assert_eq!(
            ui_callback(
                &host,
                &HostCapability::Host,
                "epoch-fixture".into(),
                "host.ui.installerProgress",
                &bad
            )
            .await
            .unwrap_err()
            .code,
            "INVALID_ARGUMENTS"
        );
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert_eq!(
            ui_callback(
                &host,
                &HostCapability::Host,
                "epoch-fixture".into(),
                "host.ui.installerProgress",
                &payload
            )
            .await
            .unwrap(),
            json!({"ok":true,"leaseId":"ui:1"})
        );
        host.installer_progress = Some(Arc::new(|_, _, _| {
            Box::pin(async { Ok(json!({"ok":true,"leaseId":"other-document"})) })
        }));
        assert_eq!(
            ui_callback(
                &host,
                &HostCapability::Host,
                "epoch-fixture".into(),
                "host.ui.installerProgress",
                &payload
            )
            .await
            .unwrap_err()
            .code,
            "INVALID_RESULT"
        );
    }
    #[tokio::test]
    async fn installer_progress_raw_callback_remains_owned_after_its_waiter_is_dropped() {
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let entered = Arc::new(Mutex::new(Some(entered_tx)));
        let release = Arc::new(Mutex::new(Some(release_rx)));
        let mut host = ui_host();
        host.ui_snapshot = Some(Arc::new(|_| {
            Box::pin(async { Ok(json!({"available":false})) })
        }));
        host.ui_command = Some(Arc::new(|_, lease, _| {
            Box::pin(async move { Ok(json!({"ok":true,"leaseId":lease})) })
        }));
        host.installer_progress = Some(Arc::new(move |_, lease, _| {
            let entered = entered.lock().unwrap().take().unwrap();
            let release = release.lock().unwrap().take().unwrap();
            Box::pin(async move {
                let _ = entered.send(());
                release.await.unwrap();
                Ok(json!({"ok":true,"leaseId":lease}))
            })
        }));
        let completed = Arc::new(AtomicBool::new(false));
        let finished = completed.clone();
        let raw = tokio::spawn(async move {
            let result=ui_callback(&host,&HostCapability::Host,"epoch-fixture".into(),"host.ui.installerProgress",&json!({"progress":{"agentName":"codex","stage":"verifying","output":"Checking the installed CLI.","percent":90},"leaseId":"ui:1"})).await;
            assert_eq!(result.unwrap(), json!({"ok":true,"leaseId":"ui:1"}));
            finished.store(true, Ordering::SeqCst);
        });
        entered_rx.await.unwrap();
        assert!(!completed.load(Ordering::SeqCst));
        drop(raw);
        assert!(!completed.load(Ordering::SeqCst));
        release_tx.send(()).unwrap();
        timeout(Duration::from_secs(1), async {
            while !completed.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn only_private_installer_and_download_operations_survive_the_normal_request_deadline() {
        // An aged origin exercises the actual Tokio timeout enforcement without
        // sleeping for either production budget or accepting a public duration.
        let aged = Instant::now() - Duration::from_secs(31);
        for operation in [
            "engine.ping",
            "engine.ui.publish",
            "host.ui.installerProgress",
            "agent-installer:install",
            "engine.agent.install.extra",
            "attachments:download",
            "engine.attachment.download.extra",
        ] {
            let result = timeout_at(
                request_deadline_at(operation, aged),
                std::future::pending::<()>(),
            )
            .await;
            assert!(
                result.is_err(),
                "unexpected extended budget for {operation}"
            );
        }
        for operation in ["engine.agent.install", "engine.attachment.download"] {
            let installer = timeout_at(request_deadline_at(operation, aged), async {
                tokio::task::yield_now().await;
                "actual acknowledgement"
            })
            .await;
            assert_eq!(installer.unwrap(), "actual acknowledgement");
            let expired = Instant::now() - Duration::from_secs(181);
            assert!(timeout_at(
                request_deadline_at(operation, expired),
                std::future::pending::<()>()
            )
            .await
            .is_err());
        }
    }
    #[cfg(target_os = "linux")]
    fn attachment_fixture() -> (Temporary, Value) {
        use std::os::unix::fs::MetadataExt;
        let temporary = Temporary::new();
        let root = std::fs::canonicalize(&temporary.0)
            .unwrap()
            .join("attachments");
        let task = root.join("task_1");
        let attachment_id = "61f07006-c85b-438e-83a7-497c77b0dcae";
        std::fs::create_dir_all(&task).unwrap();
        let target = task.join(format!("{attachment_id}-public.txt"));
        std::fs::write(&target, b"public").unwrap();
        let identity = |path: &Path| {
            let metadata = std::fs::symlink_metadata(path).unwrap();
            json!({"path":path.to_str().unwrap(),"dev":metadata.dev().to_string(),"ino":metadata.ino().to_string(),"kind":if metadata.is_dir(){"directory"}else{"file"},"size":metadata.size().to_string(),"nlink":metadata.nlink().to_string()})
        };
        let receipt = json!({"version":1,"taskId":"task_1","attachmentId":attachment_id,"filename":"public.txt","attachmentRoot":root.to_str().unwrap(),"path":target.to_str().unwrap(),"root":identity(&root),"ancestors":[identity(&task)],"target":identity(&target)});
        (temporary, json!({"receipt":receipt,"leaseId":"ui:1"}))
    }
    #[test]
    fn attachment_capability_defaults_unsupported_and_requires_both_actual_host_owners() {
        let temporary = Temporary::new();
        let mut value = descriptor(&temporary.0);
        value.capabilities.attachment_files = HostCapability::Host;
        assert!(descriptor_bytes(&value).is_err());
        value.capabilities.ui = HostCapability::Host;
        assert!(descriptor_bytes(&value).is_ok());
        let mut wire = serde_json::to_value(&value).unwrap();
        wire["capabilities"]
            .as_object_mut()
            .unwrap()
            .remove("attachmentFiles");
        let decoded: ProductionDescriptor = serde_json::from_value(wire).unwrap();
        assert_eq!(
            decoded.capabilities.attachment_files,
            HostCapability::Unsupported
        );
        let mut host = ui_host();
        assert!(attachment_host_matches(&HostCapability::Unsupported, &host));
        host.attachment_file = Some(ProductionAttachmentHost {
            invoke: Arc::new(|_, _, _| Box::pin(async { Ok(()) })),
            close: Arc::new(|| Box::pin(async { Ok(()) })),
        });
        assert!(!attachment_host_matches(&HostCapability::Host, &host));
        assert!(!attachment_host_matches(
            &HostCapability::Unsupported,
            &host
        ));
        host.ui_snapshot = Some(Arc::new(|_| {
            Box::pin(async { Ok(json!({"available":false})) })
        }));
        host.ui_command = Some(Arc::new(|_, lease, _| {
            Box::pin(async move { Ok(json!({"ok":true,"leaseId":lease})) })
        }));
        assert!(attachment_host_matches(&HostCapability::Host, &host));
    }
    #[test]
    fn attachment_download_capability_is_independent_and_requires_current_ui_owners() {
        let temporary = Temporary::new();
        let mut value = descriptor(&temporary.0);
        value.capabilities.attachment_downloads = HostCapability::Host;
        assert!(descriptor_bytes(&value).is_err());
        value.capabilities.ui = HostCapability::Host;
        assert!(descriptor_bytes(&value).is_ok());
        let mut wire = serde_json::to_value(&value).unwrap();
        wire["capabilities"]
            .as_object_mut()
            .unwrap()
            .remove("attachmentDownloads");
        assert_eq!(
            serde_json::from_value::<ProductionDescriptor>(wire)
                .unwrap()
                .capabilities
                .attachment_downloads,
            HostCapability::Unsupported
        );
        let mut host = ui_host();
        assert!(attachment_download_host_matches(
            &HostCapability::Unsupported,
            &host
        ));
        host.attachment_download = Some(ProductionAttachmentDownloadHost {
            invoke: Arc::new(|_, _, _, _| Box::pin(async { Ok(()) })),
            close: Arc::new(|| Box::pin(async { Ok(()) })),
        });
        assert!(!attachment_download_host_matches(
            &HostCapability::Host,
            &host
        ));
        assert!(!attachment_download_host_matches(
            &HostCapability::Unsupported,
            &host
        ));
        host.ui_snapshot = Some(Arc::new(|_| {
            Box::pin(async { Ok(json!({"available":false})) })
        }));
        host.ui_command = Some(Arc::new(|_, lease, _| {
            Box::pin(async move { Ok(json!({"ok":true,"leaseId":lease})) })
        }));
        assert!(attachment_download_host_matches(
            &HostCapability::Host,
            &host
        ));
        assert!(attachment_host_matches(&HostCapability::Unsupported, &host));
        assert!(!attachment_host_matches(&HostCapability::Host, &host));
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn download_callback_refuses_private_destinations_and_joins_actual_host_acknowledgement()
    {
        let (_temporary, mut payload) = attachment_fixture();
        payload["authorizationId"] = json!("00000000-0000-4000-8000-000000000001");
        let mut host = ui_host();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = calls.clone();
        let (entered, started) = tokio::sync::oneshot::channel();
        let entered = Arc::new(Mutex::new(Some(entered)));
        let (release, released) = tokio::sync::oneshot::channel();
        let released = Arc::new(Mutex::new(Some(released)));
        host.attachment_download = Some(ProductionAttachmentDownloadHost {
            invoke: Arc::new(move |receipt, lease, epoch, authorization_id| {
                let (count, entered, released) = (count.clone(), entered.clone(), released.clone());
                Box::pin(async move {
                    assert_eq!(receipt["taskId"], "task_1");
                    assert_eq!(lease, "ui:1");
                    assert_eq!(epoch, "epoch-fixture");
                    assert_eq!(authorization_id, "00000000-0000-4000-8000-000000000001");
                    count.fetch_add(1, Ordering::SeqCst);
                    let response = released.lock().unwrap().take().unwrap();
                    entered.lock().unwrap().take().unwrap().send(()).unwrap();
                    response
                        .await
                        .map_err(|_| EngineError::new("DISCONNECTED"))?;
                    Ok(())
                })
            }),
            close: Arc::new(|| Box::pin(async { Ok(()) })),
        });
        assert!(attachment_download_callback(
            &host,
            &HostCapability::Host,
            "epoch-fixture".into(),
            &payload
        )
        .await
        .is_err());
        host.ui_snapshot = Some(Arc::new(|_| {
            Box::pin(async { Ok(json!({"available":false})) })
        }));
        host.ui_command = Some(Arc::new(|_, lease, _| {
            Box::pin(async move { Ok(json!({"ok":true,"leaseId":lease})) })
        }));
        for key in ["destination", "path", "caller", "program"] {
            let mut invalid = payload.clone();
            invalid[key] = json!("forged");
            assert!(attachment_download_callback(
                &host,
                &HostCapability::Host,
                "epoch-fixture".into(),
                &invalid
            )
            .await
            .is_err());
        }
        assert!(attachment_download_callback(
            &host,
            &HostCapability::Unsupported,
            "epoch-fixture".into(),
            &payload
        )
        .await
        .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let operation = tokio::spawn(async move {
            attachment_download_callback(
                &host,
                &HostCapability::Host,
                "epoch-fixture".into(),
                &payload,
            )
            .await
        });
        started.await.unwrap();
        assert!(!operation.is_finished());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        release.send(()).unwrap();
        assert_eq!(operation.await.unwrap().unwrap(), json!({}));
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn attachment_callbacks_require_exact_receipt_lease_and_actual_host_before_effects() {
        let (_temporary, payload) = attachment_fixture();
        let mut host = ui_host();
        assert_eq!(
            attachment_callback(
                &host,
                &HostCapability::Host,
                "epoch-fixture".into(),
                &payload
            )
            .await
            .unwrap_err()
            .code,
            "UNKNOWN_OPERATION"
        );
        host.ui_snapshot = Some(Arc::new(|_| {
            Box::pin(async { Ok(json!({"available":false})) })
        }));
        host.ui_command = Some(Arc::new(|_, lease, _| {
            Box::pin(async move { Ok(json!({"ok":true,"leaseId":lease})) })
        }));
        let calls = Arc::new(AtomicU64::new(0));
        let count = calls.clone();
        host.attachment_file = Some(ProductionAttachmentHost {
            invoke: Arc::new(move |receipt, lease, epoch| {
                count.fetch_add(1, Ordering::SeqCst);
                assert_eq!(lease, "ui:1");
                assert_eq!(epoch, "epoch-fixture");
                Box::pin(async move {
                    let owner =
                        crate::production_attachment_files::NativeAttachmentFileOwner::open(
                            PathBuf::from(receipt["attachmentRoot"].as_str().unwrap()),
                        )?;
                    let decoded =
                        crate::production_attachment_files::NativeAttachmentReceipt::from_value(
                            &receipt,
                        )?;
                    owner.validate(&decoded)?.recheck()?;
                    Ok(())
                })
            }),
            close: Arc::new(|| Box::pin(async { Ok(()) })),
        });
        assert_eq!(
            attachment_callback(
                &host,
                &HostCapability::Unsupported,
                "epoch-fixture".into(),
                &payload
            )
            .await
            .unwrap_err()
            .code,
            "UNKNOWN_OPERATION"
        );
        let mut bad = payload.clone();
        bad["receipt"]["target"]["nlink"] = json!("2");
        assert_eq!(
            attachment_callback(&host, &HostCapability::Host, "epoch-fixture".into(), &bad)
                .await
                .unwrap_err()
                .code,
            "INVALID_ARGUMENTS"
        );
        bad = payload.clone();
        bad["leaseId"] = json!("../foreign");
        assert_eq!(
            attachment_callback(&host, &HostCapability::Host, "epoch-fixture".into(), &bad)
                .await
                .unwrap_err()
                .code,
            "INVALID_ARGUMENTS"
        );
        bad = payload.clone();
        bad["caller"] = json!("main");
        assert_eq!(
            attachment_callback(&host, &HostCapability::Host, "epoch-fixture".into(), &bad)
                .await
                .unwrap_err()
                .code,
            "INVALID_ARGUMENTS"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            attachment_callback(
                &host,
                &HostCapability::Host,
                "epoch-fixture".into(),
                &payload
            )
            .await
            .unwrap(),
            json!({})
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn attachment_callback_keeps_actual_handles_until_delayed_effect_acknowledgement() {
        let (_temporary, payload) = attachment_fixture();
        let mut host = ui_host();
        host.ui_snapshot = Some(Arc::new(|_| {
            Box::pin(async { Ok(json!({"available":false})) })
        }));
        host.ui_command = Some(Arc::new(|_, lease, _| {
            Box::pin(async move { Ok(json!({"ok":true,"leaseId":lease})) })
        }));
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let entered = Arc::new(Mutex::new(Some(entered_tx)));
        let release = Arc::new(Mutex::new(Some(release_rx)));
        host.attachment_file = Some(ProductionAttachmentHost {
            invoke: Arc::new(move |receipt, _, _| {
                let entered = entered.lock().unwrap().take().unwrap();
                let release = release.lock().unwrap().take().unwrap();
                Box::pin(async move {
                    let owner =
                        crate::production_attachment_files::NativeAttachmentFileOwner::open(
                            PathBuf::from(receipt["attachmentRoot"].as_str().unwrap()),
                        )?;
                    let decoded =
                        crate::production_attachment_files::NativeAttachmentReceipt::from_value(
                            &receipt,
                        )?;
                    let guard = owner.validate(&decoded)?;
                    drop(owner);
                    let _ = entered.send(());
                    release.await.unwrap();
                    guard.recheck()?;
                    Ok(())
                })
            }),
            close: Arc::new(|| Box::pin(async { Ok(()) })),
        });
        let completed = Arc::new(AtomicBool::new(false));
        let finished = completed.clone();
        let raw = tokio::spawn(async move {
            let answer = attachment_callback(
                &host,
                &HostCapability::Host,
                "epoch-fixture".into(),
                &payload,
            )
            .await;
            assert_eq!(answer.unwrap(), json!({}));
            finished.store(true, Ordering::SeqCst);
        });
        entered_rx.await.unwrap();
        assert!(!completed.load(Ordering::SeqCst));
        drop(raw);
        assert!(!completed.load(Ordering::SeqCst));
        release_tx.send(()).unwrap();
        timeout(Duration::from_secs(1), async {
            while !completed.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
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
