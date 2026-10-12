#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
use engine::{Engine, EngineError};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, State, WebviewWindow};

fn trusted_origin(url: &tauri::Url) -> bool {
    let packaged = url.host_str() == Some("localhost") && url.scheme() == "tauri"
        || url.host_str() == Some("tauri.localhost") && matches!(url.scheme(), "http" | "https");
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
            .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to initialize isolated Tauri feasibility host");
    let quitting = AtomicBool::new(false);
    app.run(move |handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !quitting.swap(true, Ordering::SeqCst) {
                api.prevent_exit();
                let engine = handle.state::<Engine>().inner().clone();
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    engine.shutdown().await;
                    handle.exit(0);
                });
            }
        }
    });
}
