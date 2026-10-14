//! Separate opt-in preview. Trusted native setup selects an isolated profile;
//! no renderer command selects paths, credentials, processes or containment.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    },
};
use tauri::{Emitter, EventTarget, Manager, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use twentyonex_engine::{
    production::{
        DelegatedCgroup, HostCapability, OptionalCapability, ProductionCapabilities,
        ProductionDescriptor, ProductionEngine, ProductionNativeHost, ProductionPaths,
        ProfileIntent, TrustedProductionLaunch,
    },
    EngineError,
};
#[path = "native_services.rs"]
pub(crate) mod native_services;
use native_services::NativeWorkOwner;

struct ProductionState {
    engine: Option<ProductionEngine>,
    failure: Option<EngineError>,
    native_work: NativeWorkOwner,
}

fn trusted_origin(url: &tauri::Url) -> bool {
    native_services::trusted_origin(url, tauri::is_dev())
}
fn authorize(window: &WebviewWindow) -> Result<(), EngineError> {
    if !native_services::trusted_main(
        window.label(),
        &window.url().map_err(|_| EngineError::new("UNAUTHORIZED"))?,
        tauri::is_dev(),
    ) {
        return Err(EngineError::new("UNAUTHORIZED"));
    }
    Ok(())
}
fn available_engine(
    app: &tauri::AppHandle,
    epoch: Option<&str>,
) -> Result<ProductionEngine, EngineError> {
    let state = app
        .try_state::<ProductionState>()
        .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
    state.native_work.assert_open()?;
    let engine = state
        .engine
        .as_ref()
        .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
    native_services::lifecycle(
        epoch,
        &engine.epoch(),
        engine.snapshot()["available"] == true,
    )?;
    Ok(engine.clone())
}
async fn open_external(
    app: tauri::AppHandle,
    work: NativeWorkOwner,
    window: WebviewWindow,
    epoch: String,
    url: String,
    callback: bool,
) -> Result<(), EngineError> {
    if !native_services::external_url(&url, callback) {
        return Err(EngineError::new("INVALID_ARGUMENTS"));
    }
    authorize(&window)?;
    available_engine(&app, Some(&epoch))?;
    work.run(move || {
        // Recheck after entering the blocking worker. A queued launch cannot
        // cross shutdown, engine replacement or main-window navigation.
        authorize(&window)?;
        available_engine(&app, Some(&epoch))?;
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|_| EngineError::new("INTERNAL_ERROR"))
    })
    .await
}
#[tauri::command]
fn engine_status(
    window: WebviewWindow,
    state: State<'_, ProductionState>,
) -> Result<Value, EngineError> {
    authorize(&window)?;
    if let Some(engine) = &state.engine {
        let mut snapshot = engine.snapshot();
        snapshot["protocolVersion"] = json!(1);
        snapshot["available"] =
            json!(snapshot["available"] == true && state.native_work.assert_open().is_ok());
        return Ok(snapshot);
    }
    Ok(
        json!({"protocolVersion":1,"production":true,"available":false,
        "startupFailure":{"code":state.failure.as_ref().map(|error|error.code),
            "phase":state.failure.as_ref().and_then(|error|error.startup_phase)}}),
    )
}
#[tauri::command]
async fn desktop_invoke(
    window: WebviewWindow,
    state: State<'_, ProductionState>,
    engine_epoch: String,
    operation: String,
    payload: Value,
) -> Result<Value, EngineError> {
    authorize(&window)?;
    state.native_work.assert_open()?;
    let engine = state
        .engine
        .as_ref()
        .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
    if native_services::OPERATIONS.contains(&operation.as_str()) {
        if !native_services::request(&operation, &payload) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        let app = window.app_handle().clone();
        available_engine(&app, Some(&engine_epoch))?;
        let result = match operation.as_str() {
            "app:getVersion" => {
                let version = app.package_info().version.to_string();
                if !native_services::version(&version) {
                    return Err(EngineError::new("INVALID_RESULT"));
                }
                json!({"defined":true,"value":version})
            }
            "shell:openExternal" => {
                open_external(
                    app,
                    state.native_work.clone(),
                    window,
                    engine_epoch,
                    payload["url"].as_str().unwrap().to_owned(),
                    false,
                )
                .await?;
                json!({"defined":false})
            }
            _ => return Err(EngineError::new("UNKNOWN_OPERATION")),
        };
        return Ok(json!({"engineEpoch":engine.epoch(),"result":result}));
    }
    let result = engine.invoke(&engine_epoch, &operation, payload).await?;
    Ok(json!({"engineEpoch":engine.epoch(),"result":result}))
}

fn unavailable(code: &'static str, phase: &'static str) -> EngineError {
    let mut error = EngineError::new(code);
    error.startup_phase = Some(phase);
    error
}
async fn start(
    app: &tauri::AppHandle,
    native_work: NativeWorkOwner,
) -> Result<ProductionEngine, EngineError> {
    // Developer/native provisioning only. Never accept a scope path via IPC;
    // absence of a real delegated scope prevents Node/key/profile startup.
    let delegation = std::env::var_os("TWENTYONEX_PRODUCTION_CGROUP_ROOT")
        .map(PathBuf::from)
        .ok_or_else(|| {
            unavailable(
                "PRODUCTION_CONTAINMENT_UNAVAILABLE",
                "production-delegation-missing",
            )
        })?;
    let containment = DelegatedCgroup::open(&delegation)?;
    let resources = app
        .path()
        .resource_dir()
        .map_err(|_| unavailable("DISCONNECTED", "production-resources"))?
        .join("resources");
    let resources = std::fs::canonicalize(resources)
        .map_err(|_| unavailable("DISCONNECTED", "production-resources"))?;
    let manifest = resources.join("service/PRODUCTION_RESOURCE_MANIFEST.json");
    let metadata = std::fs::symlink_metadata(&manifest)
        .map_err(|_| unavailable("DISCONNECTED", "production-manifest"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 32 * 1024 * 1024
    {
        return Err(unavailable("INVALID_ARGUMENTS", "production-manifest"));
    }
    let bytes =
        std::fs::read(manifest).map_err(|_| unavailable("DISCONNECTED", "production-manifest"))?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if digest != env!("TWENTYONEX_PRODUCTION_MANIFEST_SHA256") {
        return Err(unavailable(
            "INVALID_ARGUMENTS",
            "production-manifest-build-digest",
        ));
    }
    let manifest: Value = serde_json::from_slice(&bytes)
        .map_err(|_| unavailable("INVALID_ARGUMENTS", "production-manifest"))?;
    let build_identity = manifest["buildIdentity"]
        .as_str()
        .ok_or_else(|| unavailable("INVALID_ARGUMENTS", "production-manifest"))?
        .to_owned();
    if build_identity != env!("TWENTYONEX_PRODUCTION_BUILD_ID") {
        return Err(unavailable(
            "INVALID_ARGUMENTS",
            "production-manifest-build-identity",
        ));
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| unavailable("DISCONNECTED", "production-clock"))?
        .as_nanos();
    let launch_id = format!("production_{}_{stamp}", std::process::id());
    let profile_id = format!("preview_{}_{stamp}", std::process::id());
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|_| unavailable("DISCONNECTED", "production-profile"))?
        .join("isolated-previews");
    std::fs::create_dir_all(&base)
        .map_err(|_| unavailable("DISCONNECTED", "production-profile"))?;
    let base = std::fs::canonicalize(base)
        .map_err(|_| unavailable("DISCONNECTED", "production-profile"))?;
    let profile_root = base.join(&profile_id);
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(&profile_root)
        .map_err(|_| unavailable("DISCONNECTED", "production-profile"))?;
    let descriptor = ProductionDescriptor {
        version: 1,
        kind: "production-private-launch".into(),
        launch_id,
        profile_id,
        profile_intent: ProfileIntent::CreateNew,
        build_identity,
        resource_manifest_sha256: digest,
        paths: ProductionPaths {
            workspace_root: profile_root.join("workspaces"),
            attachment_root: profile_root.join("attachments"),
            repos_root: profile_root.join("repos"),
            temp_root: profile_root.join("temp"),
            profile_root,
            resource_root: resources,
        },
        capabilities: ProductionCapabilities {
            external_urls: HostCapability::Host,
            notifications: HostCapability::Unsupported,
            energy: HostCapability::Unsupported,
            ui: HostCapability::Unsupported,
            voice: HostCapability::Unsupported,
            configured_mcp: OptionalCapability::Disabled,
            connectors: OptionalCapability::Disabled,
            managed_task_mcp: OptionalCapability::Enabled,
        },
    };
    let handle = app.clone();
    let external_app = app.clone();
    ProductionEngine::start(
        TrustedProductionLaunch {
            descriptor,
            containment,
        },
        ProductionNativeHost {
            event_sink: Arc::new(move |frame| {
                handle
                    .emit_to(
                        EventTarget::WebviewWindow {
                            label: "main".into(),
                        },
                        "desktop:event",
                        frame,
                    )
                    .map_err(|_| EngineError::new("DISCONNECTED"))
            }),
            open_external: Some(Arc::new(move |url| {
                let app = external_app.clone();
                let work = native_work.clone();
                Box::pin(async move {
                    let engine = available_engine(&app, None)?;
                    let window = app
                        .get_webview_window("main")
                        .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
                    open_external(app, work, window, engine.epoch().to_owned(), url, true).await
                })
            })),
            notification: None,
        },
    )
    .await
}

pub fn run() {
    let app = tauri::Builder::default()
        // Native Rust uses this plugin; WebViews receive no direct plugin
        // permission and no injected link interception script.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![engine_status, desktop_invoke])
        .setup(|app| {
            let native_work = NativeWorkOwner::default();
            let started = tauri::async_runtime::block_on(start(app.handle(), native_work.clone()));
            let state = match started {
                Ok(engine) => ProductionState {
                    engine: Some(engine),
                    failure: None,
                    native_work: native_work.clone(),
                },
                Err(error) => ProductionState {
                    engine: None,
                    failure: Some(error),
                    native_work,
                },
            };
            app.manage(state);
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("21x Production Preview")
            .inner_size(1280.0, 850.0)
            .on_navigation(trusted_origin)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
            .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to initialize isolated production preview host");
    let quitting = Arc::new(AtomicU8::new(0));
    app.run(move |handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if quitting.load(Ordering::SeqCst) != 2 {
                api.prevent_exit();
            }
            if quitting
                .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                return;
            }
            let state = handle.state::<ProductionState>();
            // Fence synchronously before another native command/callback can
            // reserve work; failed drains never allow application exit.
            if state.native_work.close().is_err() {
                eprintln!("PRODUCTION_NATIVE_WORK_DRAIN_BLOCKED");
                quitting.store(0, Ordering::SeqCst);
                return;
            }
            let engine = state.engine.clone();
            let native_work = state.native_work.clone();
            let handle = handle.clone();
            let quitting = quitting.clone();
            tauri::async_runtime::spawn(async move {
                let mut code = 0;
                // Join native invocations before Node may release its profile
                // and stores, as well as before the application exits.
                if native_work.drain().await.is_err() {
                    eprintln!("PRODUCTION_NATIVE_WORK_DRAIN_BLOCKED");
                    quitting.store(0, Ordering::SeqCst);
                    return;
                }
                if let Some(engine) = engine {
                    if engine.shutdown().await.is_err() {
                        code = 1;
                        // Forced exit is an owned-scope kill/reap, never a
                        // manufactured graceful service drain acknowledgement.
                        if engine.terminate_owned().await.is_err() {
                            eprintln!("PRODUCTION_OWNED_TREE_DRAIN_BLOCKED");
                            quitting.store(0, Ordering::SeqCst);
                            return;
                        }
                    }
                }
                quitting.store(2, Ordering::SeqCst);
                handle.exit(code);
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn production_origins_are_exact_and_remote_windows_gain_no_authority() {
        assert!(trusted_origin(
            &tauri::Url::parse("tauri://localhost/index.html").unwrap()
        ));
        assert!(trusted_origin(
            &tauri::Url::parse("http://tauri.localhost/index.html").unwrap()
        ));
        for value in [
            "https://example.com",
            "tauri://localhost:1421",
            "http://localhost:1420",
            "tauri://user@localhost",
            "http://127.0.0.1:1421",
        ] {
            assert!(!trusted_origin(&tauri::Url::parse(value).unwrap()));
        }
    }
}
