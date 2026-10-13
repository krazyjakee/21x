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
use twentyonex_engine::{
    production::{
        DelegatedCgroup, HostCapability, OptionalCapability, ProductionCapabilities,
        ProductionDescriptor, ProductionEngine, ProductionNativeHost, ProductionPaths,
        ProfileIntent, TrustedProductionLaunch,
    },
    EngineError,
};

struct ProductionState {
    engine: Option<ProductionEngine>,
    failure: Option<EngineError>,
}

fn trusted_origin(url: &tauri::Url) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && (url.port().is_none()
            && (url.scheme() == "tauri" && url.host_str() == Some("localhost")
                || matches!(url.scheme(), "http" | "https")
                    && url.host_str() == Some("tauri.localhost"))
            || tauri::is_dev()
                && url.scheme() == "http"
                && url.host_str() == Some("localhost")
                && url.port() == Some(1421))
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
fn engine_status(
    window: WebviewWindow,
    state: State<'_, ProductionState>,
) -> Result<Value, EngineError> {
    authorize(&window)?;
    if let Some(engine) = &state.engine {
        let mut snapshot = engine.snapshot();
        snapshot["protocolVersion"] = json!(1);
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
    let engine = state
        .engine
        .as_ref()
        .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
    let result = engine.invoke(&engine_epoch, &operation, payload).await?;
    Ok(json!({"engineEpoch":engine.epoch(),"result":result}))
}

fn unavailable(code: &'static str, phase: &'static str) -> EngineError {
    let mut error = EngineError::new(code);
    error.startup_phase = Some(phase);
    error
}
async fn start(app: &tauri::AppHandle) -> Result<ProductionEngine, EngineError> {
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
            external_urls: HostCapability::Unsupported,
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
            open_external: None,
            notification: None,
        },
    )
    .await
}

pub fn run() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![engine_status, desktop_invoke])
        .setup(|app| {
            let started = tauri::async_runtime::block_on(start(app.handle()));
            let state = match started {
                Ok(engine) => ProductionState {
                    engine: Some(engine),
                    failure: None,
                },
                Err(error) => ProductionState {
                    engine: None,
                    failure: Some(error),
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
            let engine = handle.state::<ProductionState>().engine.clone();
            let handle = handle.clone();
            let quitting = quitting.clone();
            tauri::async_runtime::spawn(async move {
                let mut code = 0;
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
