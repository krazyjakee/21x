#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
use tauri::{Manager, State, WebviewWindow};
use twentyonex_engine::{Engine, EngineError};

// Developer/CI diagnostics only: release builds never read this opt-in variable.
// No command lets the renderer enable it, choose output paths, or bypass policy.
struct NativeSmoke {
    report: Option<PathBuf>,
    started: AtomicBool,
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
        if !smoke.enabled()
            || receipt.as_object().map(|object| object.len()) != Some(2)
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

fn main() {
    let smoke = Arc::new(NativeSmoke::new());
    // Package launchers may need PATH while starting. Once this explicit debug
    // diagnostic is active, remove system executables before any engine spawn.
    if smoke.enabled() {
        std::env::set_var("PATH", "/nonexistent");
    }
    assert!(smoke.write(), "failed to initialize native smoke report");
    let setup_smoke = smoke.clone();
    let app = tauri::Builder::default()
        .manage(smoke.clone())
        .invoke_handler(tauri::generate_handler![engine_invoke, engine_status])
        .setup(move |app| {
            // Different identity/path from Electron: the spike never imports live data or schemes.
            let profile = if setup_smoke.enabled() {
                std::env::var_os("TWENTYONEX_NATIVE_SMOKE_PROFILE").map(PathBuf::from)
                    .unwrap_or(app.path().app_local_data_dir()?.join("feasibility"))
            } else { app.path().app_local_data_dir()?.join("feasibility") };
            assert!(profile.is_absolute(), "feasibility profile must be absolute");
            std::fs::create_dir_all(&profile)?;
            let resources = app.path().resource_dir()?.join("resources");
            let engine = tauri::async_runtime::block_on(Engine::start(resources.clone(), profile.clone()))
                .map_err(|error| {
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
            if setup_smoke.enabled() {
                setup_smoke.evidence.lock().unwrap()["runtime"] = json!({
                    "initialized":true, "resourceRoot":std::fs::canonicalize(&resources)?,
                    "profileRoot":std::fs::canonicalize(&profile)?, "developmentFrontend":tauri::is_dev(),
                    "systemNodeHidden":std::env::var("PATH").as_deref() == Ok("/nonexistent")
                });
                assert!(setup_smoke.write(), "failed to record native resource evidence");
                let watchdog = setup_smoke.clone();
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(45));
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
