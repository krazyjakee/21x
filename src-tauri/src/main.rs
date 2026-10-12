#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc,
};
use tauri::{Manager, State, WebviewWindow};
use twentyonex_engine::{Engine, EngineError};

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
fn engine_status(window: WebviewWindow, engine: State<'_, Engine>) -> Result<Value, EngineError> {
    authorize(&window)?;
    Ok(engine.status())
}

fn main() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![engine_invoke, engine_status])
        .setup(|app| {
            // Different identity/path from Electron: the spike never imports live data or schemes.
            let profile = app.path().app_local_data_dir()?.join("feasibility");
            std::fs::create_dir_all(&profile)?;
            let resources = app.path().resource_dir()?.join("resources");
            let engine = tauri::async_runtime::block_on(Engine::start(resources, profile))
                .map_err(|_| {
                    std::io::Error::other(
                        "Bundled feasibility engine failed to initialize; run tauri:prepare.",
                    )
                })?;
            app.manage(engine);
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("21x Tauri Feasibility")
            .inner_size(920.0, 680.0)
            .on_navigation(trusted_origin)
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
                tauri::async_runtime::spawn(async move {
                    engine.shutdown().await;
                    quitting.store(2, Ordering::SeqCst);
                    handle.exit(0);
                });
            }
        }
    });
}
