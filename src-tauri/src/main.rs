#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(feature = "synthetic-agent", not(debug_assertions)))]
compile_error!("synthetic-agent is restricted to debug fixture builds");

use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc, Mutex,
};
use std::{
    io::Write,
    path::PathBuf,
    time::{Duration, Instant},
};
#[cfg(feature = "synthetic-desktop")]
use tauri::{Emitter, EventTarget};
use tauri::{Manager, State, WebviewWindow};
use twentyonex_engine::{Engine, EngineError};

#[cfg(all(feature = "artifact-authorization-proof", debug_assertions))]
mod artifact_proof;

// Developer/CI diagnostics only: release builds never read this opt-in variable.
// No command lets the renderer enable it, choose output paths, or bypass policy.
struct NativeSmoke {
    report: Option<PathBuf>,
    started: AtomicBool,
    #[cfg(feature = "synthetic-desktop")]
    synthetic_loads: AtomicU8,
    receipt: AtomicBool,
    navigation_denied: AtomicBool,
    finished: AtomicBool,
    evidence: Mutex<Value>,
}

impl NativeSmoke {
    fn new() -> Self {
        #[cfg(debug_assertions)]
        let report = std::env::var_os("TWENTYONEX_NATIVE_SMOKE_REPORT").map(PathBuf::from);
        #[cfg(not(debug_assertions))]
        let report: Option<PathBuf> = None;
        if let Some(path) = &report {
            assert!(
                path.is_absolute() && path.extension().is_some_and(|part| part == "json"),
                "native smoke report must be an absolute JSON path"
            );
        }
        Self {
            report,
            started: AtomicBool::new(false),
            #[cfg(feature = "synthetic-desktop")]
            synthetic_loads: AtomicU8::new(0),
            receipt: AtomicBool::new(false),
            navigation_denied: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            evidence: Mutex::new(
                json!({"schemaVersion": 1, "stage": "starting", "gui": {}, "runtime": {}, "shutdown": {}}),
            ),
        }
    }

    fn enabled(&self) -> bool {
        self.report.is_some()
    }

    fn write(&self) -> bool {
        let Some(path) = &self.report else {
            return true;
        };
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temporary = path.with_extension(format!("{}.{}.json.tmp", std::process::id(), stamp));
        let bytes = serde_json::to_vec_pretty(&*self.evidence.lock().unwrap()).unwrap();
        let written = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .and_then(|mut file| file.write_all(&bytes))
            .and_then(|_| std::fs::rename(&temporary, path));
        if written.is_err() {
            let _ = std::fs::remove_file(temporary);
        }
        written.is_ok()
    }

    fn passed(&self) -> bool {
        let evidence = self.evidence.lock().unwrap();
        let gui = &evidence["gui"];
        #[cfg(feature = "synthetic-desktop")]
        if evidence["runtime"]["syntheticDesktop"] == true {
            let accepted = gui["webviewLoadFinished"] == true
                && gui["remoteNavigationDenied"] == true
                && gui["windowCloseRequested"] == true
                && gui["windowCloseObserved"] == true
                && synthetic_receipt_keys(evidence["runtime"]["syntheticAgent"] == true)
                    .iter()
                    .all(|key| evidence["runtime"]["syntheticDesktopProof"][*key] == true)
                && evidence["shutdown"]["engineUnavailable"] == true
                && evidence["shutdown"]["ownedChildExited"] == true;
            #[cfg(all(feature = "artifact-authorization-proof", debug_assertions))]
            let accepted =
                accepted && evidence["runtime"]["artifactAuthorizationProof"]["passed"] == true;
            return accepted;
        }
        gui["webviewLoadFinished"] == true
            && gui["rendererPing"] == true
            && gui["restrictedOperationDenied"] == true
            && gui["remoteNavigationDenied"] == true
            && gui["windowCloseRequested"] == true
            && gui["windowCloseObserved"] == true
            && evidence["runtime"]["nativeProbe"]["ok"] == true
            && evidence["shutdown"]["engineUnavailable"] == true
            && evidence["shutdown"]["ownedChildExited"] == true
    }
}

fn begin_smoke(window: &WebviewWindow, smoke: Arc<NativeSmoke>) {
    #[cfg(feature = "synthetic-desktop")]
    if window.state::<Engine>().status()["syntheticDesktop"] == true {
        begin_synthetic_smoke(window, smoke);
        return;
    }
    if !smoke.enabled() || smoke.started.swap(true, Ordering::SeqCst) {
        return;
    }
    smoke.evidence.lock().unwrap()["gui"]["webviewLoadFinished"] = json!(true);
    let injected = window
        .eval(
            r#"
        (async () => {
            const invoke = window.__TAURI__.core.invoke;
            let bridgePing = false;
            let deniedOperation = false;
            try {
                const result = await invoke('engine_invoke', {operation:'engine.ping',payload:{}});
                bridgePing = result.protocolVersion === 1 && typeof result.engineEpoch === 'string';
            } catch (_) {}
            try {
                await invoke('engine_invoke', {operation:'engine.shutdown',payload:{}});
            } catch (error) { deniedOperation = error && error.code === 'UNKNOWN_OPERATION'; }
            await invoke('engine_status', {smokeReceipt:{bridgePing,deniedOperation}});
            location.href = 'https://tauri-smoke.invalid/blocked';
        })().catch(() => {});
    "#,
        )
        .is_ok();
    let window = window.clone();
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(8);
        while injected
            && Instant::now() < deadline
            && !(smoke.receipt.load(Ordering::SeqCst)
                && smoke.navigation_denied.load(Ordering::SeqCst))
        {
            std::thread::sleep(Duration::from_millis(25));
        }
        let engine = window.state::<Engine>().inner().clone();
        let probe = tauri::async_runtime::block_on(engine.request("engine.probe", json!({})));
        {
            let mut evidence = smoke.evidence.lock().unwrap();
            evidence["runtime"]["nativeProbe"] =
                probe.unwrap_or_else(|error| json!({"ok":false,"error":error}));
            evidence["gui"]["remoteNavigationDenied"] =
                json!(smoke.navigation_denied.load(Ordering::SeqCst));
            evidence["gui"]["windowCloseRequested"] = json!(true);
            evidence["stage"] = json!("closing");
        }
        if !smoke.write() {
            window.app_handle().exit(1);
            return;
        }
        if window.close().is_err() {
            window.app_handle().exit(1);
        }
    });
}

#[cfg(feature = "synthetic-desktop")]
const SYNTHETIC_RECEIPT_KEYS: &[&str] = &[
    "taskCreated",
    "taskEventObserved",
    "taskUpdated",
    "updateEventObserved",
    "projectCreated",
    "missingResultPreserved",
    "settingPersisted",
    "transcriptSnapshotRead",
    "transcriptDeltaRead",
    "rendererReloaded",
    "rehydrated",
    "retiredOperationDenied",
    "staleEpochDenied",
];

#[cfg(feature = "synthetic-desktop")]
fn synthetic_receipt_keys(agent: bool) -> Vec<&'static str> {
    let mut keys = SYNTHETIC_RECEIPT_KEYS.to_vec();
    if agent {
        keys.extend([
            "agentStarted",
            "approvalRequested",
            "staleApprovalDenied",
            "approvalAccepted",
            "agentCompleted",
            "agentStatusEventObserved",
            "agentTranscriptRehydrated",
        ]);
    }
    keys
}

#[cfg(feature = "synthetic-desktop")]
fn begin_synthetic_smoke(window: &WebviewWindow, smoke: Arc<NativeSmoke>) {
    if !smoke.enabled() {
        return;
    }
    smoke.evidence.lock().unwrap()["gui"]["webviewLoadFinished"] = json!(true);
    // The trusted bundled proof performs one real renderer reload. A third
    // finished load cannot start another mutation cycle.
    if smoke.synthetic_loads.fetch_add(1, Ordering::SeqCst) >= 2 {
        return;
    }
    let injected = window
        .eval(
            r#"
        (async () => {
            const deadline = Date.now() + 5000;
            while (typeof window.__TWENTYONEX_DATABASE_SMOKE__ !== 'function') {
                if (Date.now() >= deadline) throw new Error('unavailable');
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            const receipt = await window.__TWENTYONEX_DATABASE_SMOKE__();
            if (receipt && receipt.reloadRequired === true && Object.keys(receipt).length === 1) {
                location.reload();
                return;
            }
            await window.__TAURI__.core.invoke('engine_status', {smokeReceipt: receipt});
            location.href = 'https://tauri-smoke.invalid/blocked';
        })().catch(() => {});
    "#,
        )
        .is_ok();
    if smoke.started.swap(true, Ordering::SeqCst) {
        return;
    }
    let window = window.clone();
    std::thread::spawn(move || {
        let deadline = Instant::now()
            + Duration::from_secs(if cfg!(feature = "synthetic-agent") {
                45
            } else {
                20
            });
        while injected
            && Instant::now() < deadline
            && !(smoke.receipt.load(Ordering::SeqCst)
                && smoke.navigation_denied.load(Ordering::SeqCst))
        {
            std::thread::sleep(Duration::from_millis(25));
        }
        #[cfg(all(feature = "artifact-authorization-proof", debug_assertions))]
        {
            let proof = if smoke.receipt.load(Ordering::SeqCst)
                && smoke.navigation_denied.load(Ordering::SeqCst)
            {
                artifact_proof::run(&window)
            } else {
                json!({"passed":false,"prerequisiteSyntheticSmoke":false})
            };
            smoke.evidence.lock().unwrap()["runtime"]["artifactAuthorizationProof"] = proof;
        }
        {
            let mut evidence = smoke.evidence.lock().unwrap();
            evidence["gui"]["remoteNavigationDenied"] =
                json!(smoke.navigation_denied.load(Ordering::SeqCst));
            evidence["gui"]["windowCloseRequested"] = json!(true);
            evidence["stage"] = json!("closing");
        }
        if !smoke.write() || window.close().is_err() {
            window.app_handle().exit(1);
        }
    });
}

fn trusted_origin(url: &tauri::Url) -> bool {
    let packaged = url.port().is_none()
        && (url.host_str() == Some("localhost") && url.scheme() == "tauri"
            || url.host_str() == Some("tauri.localhost")
                && matches!(url.scheme(), "http" | "https"));
    let development = tauri::is_dev()
        && url.scheme() == "http"
        && url.host_str() == Some("localhost")
        && url.port() == Some(1420);
    (packaged || development) && url.username().is_empty() && url.password().is_none()
}

fn authorize(window: &WebviewWindow) -> Result<(), EngineError> {
    if window.label() != "main"
        || !trusted_origin(&window.url().map_err(|_| EngineError::new("UNAUTHORIZED"))?)
    {
        return Err(EngineError::new("UNAUTHORIZED"));
    }
    Ok(())
}

#[tauri::command]
async fn engine_invoke(
    window: WebviewWindow,
    engine: State<'_, Engine>,
    operation: String,
    payload: Value,
) -> Result<Value, EngineError> {
    authorize(&window)?;
    if !matches!(operation.as_str(), "engine.ping" | "engine.probe") {
        return Err(EngineError::new("UNKNOWN_OPERATION"));
    }
    if payload != json!({}) {
        return Err(EngineError::new("INVALID_ARGUMENTS"));
    }
    engine.request(&operation, payload).await
}

#[tauri::command]
fn engine_status(
    window: WebviewWindow,
    engine: State<'_, Engine>,
    smoke: State<'_, Arc<NativeSmoke>>,
    smoke_receipt: Option<Value>,
) -> Result<Value, EngineError> {
    authorize(&window)?;
    if let Some(receipt) = smoke_receipt {
        if !smoke.enabled() {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        #[cfg(feature = "synthetic-desktop")]
        if engine.status()["syntheticDesktop"] == true {
            let keys = synthetic_receipt_keys(engine.status()["syntheticAgent"] == true);
            if !receipt.as_object().is_some_and(|object| {
                object.len() == keys.len() && keys.iter().all(|key| receipt[*key].is_boolean())
            }) {
                return Err(EngineError::new("INVALID_ARGUMENTS"));
            }
            smoke.evidence.lock().unwrap()["runtime"]["syntheticDesktopProof"] = receipt;
            smoke.receipt.store(true, Ordering::SeqCst);
            return Ok(engine.status());
        }
        if receipt.as_object().map(|object| object.len()) != Some(2)
            || receipt["bridgePing"].as_bool().is_none()
            || receipt["deniedOperation"].as_bool().is_none()
        {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        let mut evidence = smoke.evidence.lock().unwrap();
        evidence["gui"]["rendererPing"] = receipt["bridgePing"].clone();
        evidence["gui"]["restrictedOperationDenied"] = receipt["deniedOperation"].clone();
        smoke.receipt.store(true, Ordering::SeqCst);
    }
    Ok(engine.status())
}

#[tauri::command]
async fn desktop_invoke(
    window: WebviewWindow,
    engine: State<'_, Engine>,
    engine_epoch: String,
    operation: String,
    payload: Value,
) -> Result<Value, EngineError> {
    authorize(&window)?;
    #[cfg(feature = "synthetic-desktop")]
    {
        engine
            .desktop_request(&engine_epoch, &operation, payload)
            .await
    }
    #[cfg(not(feature = "synthetic-desktop"))]
    {
        let _ = (engine, engine_epoch, operation, payload);
        Err(EngineError::new("UNKNOWN_OPERATION"))
    }
}

#[cfg(feature = "synthetic-desktop")]
struct SyntheticProfile(PathBuf);

#[cfg(feature = "synthetic-desktop")]
impl SyntheticProfile {
    fn create() -> std::io::Result<Self> {
        let temporary = std::fs::canonicalize(std::env::temp_dir())?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| std::io::Error::other("synthetic profile clock unavailable"))?
            .as_nanos();
        for attempt in 0..16 {
            let path = temporary.join(format!(
                "21x-database-service-{}-{stamp}-{attempt}",
                std::process::id()
            ));
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(std::io::Error::other(
            "synthetic profile allocation exhausted",
        ))
    }
}

#[cfg(feature = "synthetic-desktop")]
impl Drop for SyntheticProfile {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn main() {
    let smoke = Arc::new(NativeSmoke::new());
    // Package launchers may need PATH while starting. Once this explicit debug
    // diagnostic is active, remove system executables before any engine spawn.
    if smoke.enabled() {
        std::env::set_var("PATH", "/nonexistent");
    }
    assert!(smoke.write(), "failed to initialize native smoke report");
    let setup_smoke = smoke.clone();
    let builder = tauri::Builder::default()
        .manage(smoke.clone())
        .invoke_handler(tauri::generate_handler![
            engine_invoke,
            engine_status,
            desktop_invoke
        ]);
    #[cfg(all(feature = "artifact-authorization-proof", debug_assertions))]
    let builder = artifact_proof::register(builder);
    let app = builder
        .setup(move |app| {
            // Different identity/path from Electron: the spike never imports live data or schemes.
            #[cfg(feature = "synthetic-desktop")]
            let owned_profile = SyntheticProfile::create()?;
            #[cfg(feature = "synthetic-desktop")]
            let profile = owned_profile.0.clone();
            #[cfg(not(feature = "synthetic-desktop"))]
            let profile = if setup_smoke.enabled() {
                std::env::var_os("TWENTYONEX_NATIVE_SMOKE_PROFILE").map(PathBuf::from)
                    .unwrap_or(app.path().app_local_data_dir()?.join("feasibility"))
            } else { app.path().app_local_data_dir()?.join("feasibility") };
            assert!(profile.is_absolute(), "feasibility profile must be absolute");
            std::fs::create_dir_all(&profile)?;
            let resources = app.path().resource_dir()?.join("resources");
            #[cfg(feature = "synthetic-desktop")]
            let started = {
                let handle = app.handle().clone();
                let sink = Arc::new(move |frame: Value| {
                    handle.emit_to(EventTarget::WebviewWindow { label: "main".into() }, "desktop:event", frame)
                        .map_err(|_| EngineError::new("DISCONNECTED"))
                });
                tauri::async_runtime::block_on(Engine::start_synthetic(resources.clone(), profile.clone(), sink))
            };
            #[cfg(not(feature = "synthetic-desktop"))]
            let started = tauri::async_runtime::block_on(Engine::start(resources.clone(), profile.clone()));
            let engine = started.map_err(|error| {
                    if setup_smoke.enabled() {
                        setup_smoke.evidence.lock().unwrap()["runtime"] = json!({
                            "initialized": false, "startupFailure": {
                                "phase": error.startup_phase.unwrap_or("unknown"), "code": error.code
                            }
                        });
                        let _ = setup_smoke.write();
                    }
                    std::io::Error::other(
                        "Bundled feasibility engine failed to initialize; run tauri:prepare.",
                    )
                })?;
            app.manage(engine);
            #[cfg(feature = "synthetic-desktop")]
            app.manage(owned_profile);
            if setup_smoke.enabled() {
                setup_smoke.evidence.lock().unwrap()["runtime"] = json!({
                    "initialized":true, "hostArch":std::env::consts::ARCH,
                    "webviewVersion":tauri::webview_version().ok(),
                    "webviewDefaultRuntime":std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").is_none(),
                    "syntheticDesktop":app.state::<Engine>().status()["syntheticDesktop"],
                    "syntheticAgent":app.state::<Engine>().status()["syntheticAgent"],
                    "resourceRoot":std::fs::canonicalize(&resources)?,
                    "profileRoot":std::fs::canonicalize(&profile)?, "developmentFrontend":tauri::is_dev(),
                    "systemNodeHidden":std::env::var("PATH").as_deref() == Ok("/nonexistent")
                });
                assert!(setup_smoke.write(), "failed to record native resource evidence");
                let watchdog = setup_smoke.clone();
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(if cfg!(feature = "synthetic-agent") { 75 } else { 45 }));
                    if !watchdog.finished.load(Ordering::SeqCst) { handle.exit(1); }
                });
            }
            let navigation_smoke = setup_smoke.clone();
            let load_smoke = setup_smoke.clone();
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("21x Tauri Feasibility")
            .inner_size(920.0, 680.0)
            .on_navigation(move |url| {
                let allowed = trusted_origin(url);
                if !allowed && navigation_smoke.enabled() && url.host_str() == Some("tauri-smoke.invalid") {
                    navigation_smoke.navigation_denied.store(true, Ordering::SeqCst);
                }
                allowed
            })
            .on_page_load(move |window, payload| {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) && trusted_origin(payload.url()) {
                    begin_smoke(&window, load_smoke.clone());
                }
            })
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
            .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to initialize isolated Tauri feasibility host");
    let quitting = Arc::new(AtomicU8::new(0));
    app.run(move |handle, event| {
        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { .. },
            ..
        } = &event
        {
            if smoke.enabled() && label == "main" {
                smoke.evidence.lock().unwrap()["gui"]["windowCloseObserved"] = json!(true);
                // macOS can keep the app alive after its last window closes.
                // The diagnostic still exercises native close, then explicit quit.
                handle.exit(0);
            }
        }
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if quitting.load(Ordering::SeqCst) != 2 {
                api.prevent_exit();
            }
            if quitting
                .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                let engine = handle.state::<Engine>().inner().clone();
                let handle = handle.clone();
                let quitting = quitting.clone();
                let smoke = smoke.clone();
                tauri::async_runtime::spawn(async move {
                    engine.shutdown().await;
                    let mut code = 0;
                    if smoke.enabled() {
                        smoke.evidence.lock().unwrap()["shutdown"] =
                            json!({"engineUnavailable":engine.status()["available"] == false,
                                "ownedChildExited":engine.status()["ownedChildExited"],
                                "ownershipMode":engine.status()["ownershipMode"]});
                        smoke.evidence.lock().unwrap()["stage"] = json!("complete");
                        let passed = smoke.passed();
                        smoke.evidence.lock().unwrap()["passed"] = json!(passed);
                        if !smoke.write() || !passed {
                            code = 1;
                        }
                        smoke.finished.store(true, Ordering::SeqCst);
                    }
                    quitting.store(2, Ordering::SeqCst);
                    handle.exit(code);
                });
            }
        }
    });
}
