//! Separate opt-in preview. Trusted native setup selects an isolated profile;
//! no renderer command selects paths, credentials, processes or containment.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, EventTarget, Manager, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use twentyonex_engine::{
    production::{
        DelegatedCgroup, HostCapability, OptionalCapability, ProductionAttachmentHost,
        ProductionCapabilities, ProductionCleanupHost, ProductionDescriptor, ProductionEnergyHost,
        ProductionEngine, ProductionNativeHost, ProductionNotificationHost, ProductionPaths,
        ProductionWorkspaceHost, ProfileIntent, TrustedProductionLaunch,
    },
    production_attachment_files::{NativeAttachmentFileOwner, NativeAttachmentReceipt},
    production_files::{NativeWorkspaceFileOwner, NativeWorkspaceReceipt},
    EngineError,
};
#[path = "native_oauth.rs"]
mod native_oauth;
#[path = "native_services.rs"]
pub(crate) mod native_services;
use native_services::NativeWorkOwner;
#[path = "native_notifications.rs"]
pub(crate) mod native_notifications;
use native_notifications::{NativeNotificationOwner, Scope as NotificationScope};
#[path = "native_tray.rs"]
pub(crate) mod native_tray;
use native_tray::NativeTrayOwner;
#[path = "native_energy.rs"]
pub(crate) mod native_energy;
use native_energy::NativeEnergyOwner;
#[path = "native_artifact_clipboard.rs"]
pub(crate) mod native_artifact_clipboard;
#[path = "native_attachment_download.rs"]
pub(crate) mod native_attachment_download;
#[path = "native_attachment_selection.rs"]
pub(crate) mod native_attachment_selection;
#[path = "native_clipboard.rs"]
pub(crate) mod native_clipboard;
#[path = "production_ui.rs"]
pub(crate) mod production_ui;
use production_ui::NativeUiOwner;
#[path = "native_media.rs"]
mod native_media;
#[path = "native_window.rs"]
mod native_window;
use native_window::NativeWindowOwner;

struct ProductionState {
    engine: Option<ProductionEngine>,
    failure: Option<EngineError>,
    native_work: NativeWorkOwner,
    oauth: native_oauth::NativeOAuthOwner,
    ui: NativeUiOwner,
    window: NativeWindowOwner,
    notifications: NativeNotificationOwner,
    tray: Option<NativeTrayOwner>,
    energy: Option<NativeEnergyOwner>,
    notice_document: Mutex<Option<(String, String)>>,
}

fn is_document_notice(operation: &str) -> bool {
    matches!(
        operation,
        "agent:incompatible-session" | "task:checkpointAnswered" | "task:source-action-failed"
    )
}
fn document_notice_frame(frame: &Value, epoch: &str, lease: &str) -> Result<Value, EngineError> {
    let keys = [
        "kind",
        "protocolVersion",
        "engineEpoch",
        "operation",
        "payload",
        "sequence",
    ];
    let operation = frame["operation"].as_str().unwrap_or("");
    if !frame.as_object().is_some_and(|value| {
        value.len() == keys.len() && keys.iter().all(|key| value.contains_key(*key))
    }) || frame["kind"] != "event"
        || frame["protocolVersion"] != 1
        || frame["engineEpoch"] != epoch
        || !frame["sequence"]
            .as_u64()
            .is_some_and(|sequence| sequence > 0 && sequence <= 9_007_199_254_740_991)
        || !is_document_notice(operation)
        || !twentyonex_engine::production::contracts::valid_event(operation, &frame["payload"])
        || !twentyonex_engine::production_ui_contracts::lease_id(&json!(lease))
    {
        return Err(EngineError::new("INVALID_RESULT"));
    }
    Ok(json!({"engineEpoch":epoch,"leaseId":lease,"event":frame}))
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

fn workspace_cleanup_host(
    app: &tauri::AppHandle,
    work: NativeWorkOwner,
    descriptor: &ProductionDescriptor,
) -> Result<Option<ProductionCleanupHost>, EngineError> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, work, descriptor);
        Ok(None)
    }
    #[cfg(target_os = "linux")]
    {
        use twentyonex_engine::production::cleanup_observation::Observer;
        let observer = Arc::new(Observer::open(
            &descriptor.paths.profile_root,
            &descriptor.paths.workspace_root,
        )?);
        let closing = observer.clone();
        let app = app.clone();
        Ok(Some(ProductionCleanupHost {
            invoke: Arc::new(move |request, epoch| {
                let (observer, app, work) = (observer.clone(), app.clone(), work.clone());
                Box::pin(async move {
                    // Release is ticket-only and remains available after the
                    // task directory disappears or ordinary native admission
                    // closes. It performs no scan or filesystem mutation.
                    if request["action"] == "release" {
                        return observer.observe(&request, &epoch);
                    }
                    let result = Arc::new(std::sync::Mutex::new(None));
                    let delivered = result.clone();
                    work.run(move || {
                        available_engine(&app, Some(&epoch))?;
                        let value = observer.observe(&request, &epoch)?;
                        // Stale completion cannot authorize a cleanup effect.
                        available_engine(&app, Some(&epoch))?;
                        *delivered
                            .lock()
                            .map_err(|_| EngineError::new("DISCONNECTED"))? = Some(value);
                        Ok(())
                    })
                    .await?;
                    let value = result
                        .lock()
                        .map_err(|_| EngineError::new("DISCONNECTED"))?
                        .take();
                    value.ok_or_else(|| EngineError::new("DISCONNECTED"))
                })
            }),
            close: Arc::new(move || {
                let closing = closing.clone();
                Box::pin(async move { closing.close() })
            }),
        }))
    }
}

fn workspace_file_host(
    app: &tauri::AppHandle,
    work: NativeWorkOwner,
    descriptor: &ProductionDescriptor,
) -> Result<Option<ProductionWorkspaceHost>, EngineError> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, work, descriptor);
        return Ok(None);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::DirBuilderExt;
        // Trusted isolated bootstrap path; there is no public picker/root grant.
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&descriptor.paths.workspace_root)
            .map_err(|_| {
                unavailable(
                    "PRODUCTION_NATIVE_FILE_AUTHORITY_UNAVAILABLE",
                    "production-native-file-root",
                )
            })?;
        let owner = NativeWorkspaceFileOwner::open(descriptor.paths.workspace_root.clone())
            .map_err(|_| {
                unavailable(
                    "PRODUCTION_NATIVE_FILE_AUTHORITY_UNAVAILABLE",
                    "production-native-file-owner",
                )
            })?;
        let slot = Arc::new(std::sync::Mutex::new(Some(Arc::new(owner))));
        let invocation_slot = slot.clone();
        let app = app.clone();
        Ok(Some(ProductionWorkspaceHost {
            invoke: Arc::new(move |reveal, receipt| {
                let app = app.clone();
                let work = work.clone();
                let slot = invocation_slot.clone();
                Box::pin(async move {
                    let engine = available_engine(&app, None)?;
                    let epoch = engine.epoch();
                    let window = app
                        .get_webview_window("main")
                        .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
                    authorize(&window)?;
                    work.run(move || {
                        authorize(&window)?;
                        available_engine(&app, Some(&epoch))?;
                        let owner = slot
                            .lock()
                            .map_err(|_| EngineError::new("DISCONNECTED"))?
                            .as_ref()
                            .cloned()
                            .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
                        let receipt = NativeWorkspaceReceipt::from_value(&receipt)
                            .map_err(|_| EngineError::new("INVALID_ARGUMENTS"))?;
                        let guard = owner
                            .validate(&receipt)
                            .map_err(|_| EngineError::new("INVALID_ARGUMENTS"))?;
                        guard
                            .recheck()
                            .map_err(|_| EngineError::new("INVALID_ARGUMENTS"))?;
                        let result = if reveal {
                            app.opener().reveal_item_in_dir(guard.path())
                        } else {
                            app.opener().open_path(
                                guard.path().to_string_lossy().into_owned(),
                                None::<&str>,
                            )
                        };
                        // Keep every exact metadata descriptor through the actual
                        // native invocation. The external application owns its lifetime.
                        guard
                            .recheck()
                            .map_err(|_| EngineError::new("INVALID_ARGUMENTS"))?;
                        authorize(&window)?;
                        available_engine(&app, Some(&epoch))?;
                        result.map_err(|_| EngineError::new("INTERNAL_ERROR"))
                    })
                    .await
                })
            }),
            close: Arc::new(move || {
                let slot = slot.clone();
                Box::pin(async move {
                    // Engine drain joins every callback before releasing these
                    // captured root/ancestor handles and acknowledging Node.
                    let owned = slot
                        .lock()
                        .map_err(|_| EngineError::new("DISCONNECTED"))?
                        .take();
                    drop(owned);
                    Ok(())
                })
            }),
        }))
    }
}
fn attachment_file_host(
    app: &tauri::AppHandle,
    work: NativeWorkOwner,
    ui: NativeUiOwner,
    descriptor: &ProductionDescriptor,
) -> Result<Option<ProductionAttachmentHost>, EngineError> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, work, ui, descriptor);
        return Ok(None);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&descriptor.paths.attachment_root)
            .map_err(|_| {
                unavailable(
                    "PRODUCTION_NATIVE_FILE_AUTHORITY_UNAVAILABLE",
                    "production-native-attachment-root",
                )
            })?;
        let owner = NativeAttachmentFileOwner::open(descriptor.paths.attachment_root.clone())
            .map_err(|_| {
                unavailable(
                    "PRODUCTION_NATIVE_FILE_AUTHORITY_UNAVAILABLE",
                    "production-native-attachment-owner",
                )
            })?;
        let slot = Arc::new(std::sync::Mutex::new(Some(Arc::new(owner))));
        let invocation_slot = slot.clone();
        let app = app.clone();
        Ok(Some(ProductionAttachmentHost {
            invoke: Arc::new(move |receipt, lease, epoch| {
                let (app, work, ui, slot) = (
                    app.clone(),
                    work.clone(),
                    ui.clone(),
                    invocation_slot.clone(),
                );
                Box::pin(async move {
                    let window = app
                        .get_webview_window("main")
                        .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
                    ui.assert_publish(&window, &epoch, &lease)?;
                    work.run(move || {
                        // Keep the accepted physical document, lease and epoch;
                        // do not resolve a newer window after entering raw work.
                        ui.assert_publish(&window, &epoch, &lease)?;
                        let owner = slot
                            .lock()
                            .map_err(|_| EngineError::new("DISCONNECTED"))?
                            .as_ref()
                            .cloned()
                            .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
                        let receipt = NativeAttachmentReceipt::from_value(&receipt)
                            .map_err(|_| EngineError::new("INVALID_ARGUMENTS"))?;
                        let guard = owner
                            .validate(&receipt)
                            .map_err(|_| EngineError::new("INVALID_ARGUMENTS"))?;
                        guard
                            .recheck()
                            .map_err(|_| EngineError::new("INVALID_ARGUMENTS"))?;
                        let result = app
                            .opener()
                            .open_path(guard.path().to_string_lossy().into_owned(), None::<&str>);
                        // All exact metadata-only handles survive the actual
                        // opener invocation. External applications own later reads.
                        guard
                            .recheck()
                            .map_err(|_| EngineError::new("INVALID_ARGUMENTS"))?;
                        ui.assert_publish(&window, &epoch, &lease)?;
                        result.map_err(|_| EngineError::new("INTERNAL_ERROR"))
                    })
                    .await
                })
            }),
            close: Arc::new(move || {
                let slot = slot.clone();
                Box::pin(async move {
                    // Native callback drain joins accepted raw effects first.
                    let owned = slot
                        .lock()
                        .map_err(|_| EngineError::new("DISCONNECTED"))?
                        .take();
                    drop(owned);
                    Ok(())
                })
            }),
        }))
    }
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
        snapshot["uiSupported"] = json!(true);
        let mut notice = state
            .notice_document
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        *notice = None;
        if snapshot["available"] == true {
            if let Some(lease) = state.ui.activate(&window, &engine.epoch()) {
                snapshot["uiLeaseId"] = json!(lease.clone());
                *notice = Some((engine.epoch(), lease));
            }
        }
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
    ui_lease: Option<String>,
) -> Result<Value, EngineError> {
    authorize(&window)?;
    state.native_work.assert_open()?;
    let engine = state
        .engine
        .as_ref()
        .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
    if twentyonex_engine::production_tray_contracts::COMMANDS.contains(&operation.as_str()) {
        if !twentyonex_engine::production_tray_contracts::request(&operation, &payload) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        let lease = ui_lease.ok_or_else(|| EngineError::new("STALE_EPOCH"))?;
        state.ui.assert_publish(&window, &engine_epoch, &lease)?;
        if !state.tray.as_ref().is_some_and(|tray| tray.is_available()) {
            return Err(EngineError::new("UNKNOWN_OPERATION"));
        }
        let result = engine
            .invoke_tray_preference(&engine_epoch, &operation, payload, &lease)
            .await?;
        authorize(&window)?;
        available_engine(window.app_handle(), Some(&engine_epoch))?;
        state.ui.assert_publish(&window, &engine_epoch, &lease)?;
        return Ok(json!({"engineEpoch":engine.epoch(),"result":result}));
    }
    if operation == "attachments:readImage" {
        if !twentyonex_engine::production_attachment_files::request(&payload) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        let lease = ui_lease.ok_or_else(|| EngineError::new("STALE_EPOCH"))?;
        state.ui.assert_publish(&window, &engine_epoch, &lease)?;
        let result = engine
            .read_attachment_image(&engine_epoch, payload, &lease)
            .await?;
        authorize(&window)?;
        available_engine(window.app_handle(), Some(&engine_epoch))?;
        state.ui.assert_publish(&window, &engine_epoch, &lease)?;
        return Ok(json!({"engineEpoch":engine.epoch(),"result":result}));
    }
    if matches!(operation.as_str(), "attachments:pick" | "attachments:save") {
        let lease = ui_lease.ok_or_else(|| EngineError::new("STALE_EPOCH"))?;
        state.ui.assert_publish(&window, &engine_epoch, &lease)?;
        let result = if operation == "attachments:pick" {
            if payload != json!({}) {
                return Err(EngineError::new("INVALID_ARGUMENTS"));
            }
            engine.pick_attachments(&engine_epoch, &lease).await?
        } else {
            engine
                .save_attachment(&engine_epoch, payload, &lease)
                .await?
        };
        authorize(&window)?;
        available_engine(window.app_handle(), Some(&engine_epoch))?;
        state.ui.assert_publish(&window, &engine_epoch, &lease)?;
        return Ok(json!({"engineEpoch":engine.epoch(),"result":result}));
    }
    if matches!(
        operation.as_str(),
        "ui:publishState"
            | "agent-installer:install"
            | "attachments:open"
            | "attachments:download"
            | "artifacts:copyFile"
    ) {
        if !twentyonex_engine::production::contracts::valid_request(&operation, &payload) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        let lease = ui_lease.ok_or_else(|| EngineError::new("STALE_EPOCH"))?;
        state.ui.assert_publish(&window, &engine_epoch, &lease)?;
        // Capture once at native ingress. Never mint or reacquire a document
        // receipt after an accepted installation or UI publication.
        let result = if operation == "ui:publishState" {
            engine
                .publish_ui(&engine_epoch, payload["state"].clone(), &lease)
                .await?
        } else if operation == "agent-installer:install" {
            engine.install_agent(&engine_epoch, payload, &lease).await?
        } else if operation == "attachments:open" {
            engine
                .open_attachment(&engine_epoch, payload, &lease)
                .await?
        } else if operation == "artifacts:copyFile" {
            engine
                .copy_artifact_file(&engine_epoch, payload, &lease)
                .await?
        } else {
            engine
                .download_attachment(&engine_epoch, payload, &lease)
                .await?
        };
        authorize(&window)?;
        available_engine(window.app_handle(), Some(&engine_epoch))?;
        state.ui.assert_publish(&window, &engine_epoch, &lease)?;
        return Ok(json!({"engineEpoch":engine.epoch(),"result":result}));
    }
    if operation == "app:setTitleBarOverlay" {
        let lease = ui_lease.ok_or_else(|| EngineError::new("STALE_EPOCH"))?;
        state.ui.assert_publish(&window, &engine_epoch, &lease)?;
        let result = native_window::overlay(
            window.clone(),
            state.native_work.clone(),
            state.ui.clone(),
            engine_epoch.clone(),
            lease.clone(),
            payload,
        )
        .await?;
        authorize(&window)?;
        available_engine(window.app_handle(), Some(&engine_epoch))?;
        state.ui.assert_publish(&window, &engine_epoch, &lease)?;
        return Ok(json!({"engineEpoch":engine.epoch(),"result":result}));
    }
    if operation == native_clipboard::OPERATION {
        if !native_clipboard::request(&payload) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        let lease = ui_lease.ok_or_else(|| EngineError::new("STALE_EPOCH"))?;
        state.ui.assert_publish(&window, &engine_epoch, &lease)?;
        let result = native_clipboard::read(
            window.app_handle().clone(),
            state.native_work.clone(),
            state.ui.clone(),
            window.clone(),
            engine_epoch.clone(),
            lease.clone(),
        )
        .await?;
        authorize(&window)?;
        available_engine(window.app_handle(), Some(&engine_epoch))?;
        state.ui.assert_publish(&window, &engine_epoch, &lease)?;
        if !native_clipboard::result(&result) {
            return Err(EngineError::new("INVALID_RESULT"));
        }
        return Ok(json!({"engineEpoch":engine.epoch(),"result":result}));
    }
    if matches!(
        operation.as_str(),
        "notifications:show"
            | "app:getNotificationPermission"
            | "app:requestNotificationPermission"
    ) {
        if !native_services::request(&operation, &payload) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        let lease = ui_lease.ok_or_else(|| EngineError::new("STALE_EPOCH"))?;
        state.ui.assert_publish(&window, &engine_epoch, &lease)?;
        let app = window.app_handle().clone();
        available_engine(&app, Some(&engine_epoch))?;
        let (captured_window, captured_ui, captured_epoch, captured_lease) = (
            window.clone(),
            state.ui.clone(),
            engine_epoch.clone(),
            lease.clone(),
        );
        let current: NotificationScope = Arc::new(move || {
            authorize(&captured_window)?;
            available_engine(captured_window.app_handle(), Some(&captured_epoch))?;
            captured_ui.assert_publish(&captured_window, &captured_epoch, &captured_lease)
        });
        let result = if operation == "notifications:show" {
            state
                .notifications
                .show(
                    payload["title"].as_str().unwrap().to_owned(),
                    payload["body"].as_str().unwrap().to_owned(),
                    false,
                    current,
                )
                .await?;
            json!({"defined":false})
        } else {
            let permission = state.notifications.permission(current).await?;
            if permission != "granted" && permission != "denied" {
                return Err(EngineError::new("INVALID_RESULT"));
            }
            json!({"defined":true,"value":permission})
        };
        authorize(&window)?;
        available_engine(&app, Some(&engine_epoch))?;
        state.ui.assert_publish(&window, &engine_epoch, &lease)?;
        return Ok(json!({"engineEpoch":engine.epoch(),"result":result}));
    }
    if ui_lease.is_some() {
        return Err(EngineError::new("INVALID_ARGUMENTS"));
    }
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
fn attach_tray_close(
    window: &WebviewWindow,
    tray: NativeTrayOwner,
    work: NativeWorkOwner,
    ui: NativeUiOwner,
) {
    let captured = window.clone();
    let pending = Arc::new(AtomicU8::new(0));
    window.on_window_event(move |event| {
        let tauri::WindowEvent::CloseRequested { api, .. } = event else {
            return;
        };
        api.prevent_close();
        if pending
            .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let (window, tray, work, ui, pending) = (
            captured.clone(),
            tray.clone(),
            work.clone(),
            ui.clone(),
            pending.clone(),
        );
        tauri::async_runtime::spawn(async move {
            let app = window.app_handle().clone();
            let outcome = async {
                work.assert_open()?;
                ui.assert_window(&window)?;
                let engine = available_engine(&app, None)?;
                let epoch = engine.epoch();
                let output = Arc::new(std::sync::Mutex::new(None));
                let stored = output.clone();
                work.run(move || {
                    let enabled = tauri::async_runtime::block_on(engine.tray_preference(&epoch))?;
                    *stored
                        .lock()
                        .map_err(|_| EngineError::new("DISCONNECTED"))? = Some(enabled);
                    Ok(())
                })
                .await?;
                let enabled = output
                    .lock()
                    .map_err(|_| EngineError::new("DISCONNECTED"))?
                    .take()
                    .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
                work.assert_open()?;
                ui.assert_window(&window)?;
                if enabled {
                    let (guard_work, guard_ui, guard_window) =
                        (work.clone(), ui.clone(), window.clone());
                    let current: native_tray::Scope = Arc::new(move || {
                        guard_work.assert_open()?;
                        guard_ui.assert_window(&guard_window)
                    });
                    tray.hide_main(&window, current).await?;
                    // A missing tray host keeps the main window visible and
                    // reports locally; it never silently changes this to quit.
                } else {
                    app.exit(0);
                }
                Ok::<(), EngineError>(())
            }
            .await;
            if outcome.is_err() && work.assert_open().is_ok() && ui.assert_window(&window).is_ok() {
                // A failed Source cannot strand an app-owned Close request.
                // Existing ExitRequested still owns all real service drainage.
                app.exit(0);
            }
            pending.store(0, Ordering::SeqCst);
        });
    });
}
fn production_containment() -> Result<DelegatedCgroup, EngineError> {
    #[cfg(windows)]
    {
        Ok(DelegatedCgroup::native_job())
    }
    #[cfg(target_os = "linux")]
    {
        // Native provisioning only; no IPC accepts a delegation path.
        let delegation = std::env::var_os("TWENTYONEX_PRODUCTION_CGROUP_ROOT")
            .map(PathBuf::from)
            .ok_or_else(|| {
                unavailable(
                    "PRODUCTION_CONTAINMENT_UNAVAILABLE",
                    "production-delegation-missing",
                )
            })?;
        DelegatedCgroup::open(&delegation)
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    Err(unavailable(
        "PRODUCTION_CONTAINMENT_UNAVAILABLE",
        "production-detached-descendant-containment-unavailable",
    ))
}

async fn start(
    app: &tauri::AppHandle,
    native_work: NativeWorkOwner,
    oauth: native_oauth::NativeOAuthOwner,
    ui: NativeUiOwner,
    notifications: NativeNotificationOwner,
    tray_available: bool,
    energy: Option<NativeEnergyOwner>,
) -> Result<ProductionEngine, EngineError> {
    let containment = production_containment()?;
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
            workspace_cleanup: if cfg!(target_os = "linux") {
                HostCapability::Host
            } else {
                HostCapability::Unsupported
            },
            tray: if tray_available {
                HostCapability::Host
            } else {
                HostCapability::Unsupported
            },
            workspace_files: if cfg!(target_os = "linux") {
                HostCapability::Host
            } else {
                HostCapability::Unsupported
            },
            window_state: HostCapability::Host,
            attachment_selections: if cfg!(target_os = "linux") {
                HostCapability::Host
            } else {
                HostCapability::Unsupported
            },
            attachment_files: if cfg!(target_os = "linux") {
                HostCapability::Host
            } else {
                HostCapability::Unsupported
            },
            attachment_downloads: if cfg!(target_os = "linux") {
                HostCapability::Host
            } else {
                HostCapability::Unsupported
            },
            artifact_clipboard: if cfg!(target_os = "linux") {
                HostCapability::Host
            } else {
                HostCapability::Unsupported
            },
            external_urls: HostCapability::Host,
            oauth_flows: HostCapability::Host,
            notifications: if cfg!(target_os = "linux") {
                HostCapability::Host
            } else {
                HostCapability::Unsupported
            },
            energy: if cfg!(target_os = "linux") && energy.is_some() {
                HostCapability::Host
            } else {
                HostCapability::Unsupported
            },
            ui: HostCapability::Host,
            voice: HostCapability::Unsupported,
            configured_mcp: OptionalCapability::Disabled,
            connectors: OptionalCapability::Disabled,
            managed_task_mcp: OptionalCapability::Enabled,
        },
    };
    let handle = app.clone();
    let external_app = app.clone();
    let workspace_file = workspace_file_host(app, native_work.clone(), &descriptor)?;
    let workspace_cleanup = workspace_cleanup_host(app, native_work.clone(), &descriptor)?;
    let attachment_file = attachment_file_host(app, native_work.clone(), ui.clone(), &descriptor)?;
    let attachment_download = native_attachment_download::host(
        app,
        native_work.clone(),
        ui.clone(),
        descriptor.paths.attachment_root.clone(),
    )?;
    let artifact_clipboard = native_artifact_clipboard::host(
        app,
        native_work.clone(),
        ui.clone(),
        descriptor.paths.workspace_root.clone(),
    )?;
    let notification = if cfg!(target_os = "linux") {
        let owner = notifications.clone();
        let closing = notifications.clone();
        let callback_app = app.clone();
        let callback_work = native_work.clone();
        Some(ProductionNotificationHost {
            invoke: Arc::new(move |title, body, inactive, epoch| {
                let (owner, app, work) =
                    (owner.clone(), callback_app.clone(), callback_work.clone());
                Box::pin(async move {
                    let current: NotificationScope = Arc::new(move || {
                        work.assert_open()?;
                        available_engine(&app, Some(&epoch))?;
                        Ok(())
                    });
                    owner.show(title, body, inactive, current).await
                })
            }),
            close: Arc::new(move || {
                let owner = closing.clone();
                Box::pin(async move { owner.close().await })
            }),
        })
    } else {
        None
    };
    let ui_snapshot = ui.snapshot_callback(app.clone(), native_work.clone());
    let energy_host = if cfg!(target_os = "linux") {
        energy.map(|owner| {
            let closing = owner.clone();
            let work = native_work.clone();
            ProductionEnergyHost {
                invoke: Arc::new(move |enabled, current| {
                    let (owner, work) = (owner.clone(), work.clone());
                    Box::pin(async move {
                        if !enabled && work.assert_open().is_err() {
                            owner.close().await?;
                            return Ok(false);
                        }
                        let scope: native_energy::Scope = Arc::new(move || {
                            work.assert_open()?;
                            current()
                        });
                        owner.set_active(enabled, scope).await
                    })
                }),
                close: Arc::new(move || {
                    let owner = closing.clone();
                    Box::pin(async move { owner.close().await })
                }),
            }
        })
    } else {
        None
    };
    let ui_command = ui.command_callback(app.clone(), native_work.clone());
    let installer_progress = ui.installer_progress_callback(app.clone(), native_work.clone());
    let attachment_selection = native_attachment_selection::host(
        app,
        native_work.clone(),
        ui.clone(),
        descriptor.paths.profile_root.clone(),
    );
    ProductionEngine::start(
        TrustedProductionLaunch {
            descriptor,
            containment,
        },
        ProductionNativeHost {
            oauth: Some(oauth.host(app, native_work.clone())),
            workspace_cleanup,
            workspace_file,
            attachment_file,
            attachment_download,
            attachment_selection,
            artifact_clipboard,
            event_sink: Arc::new(move |frame| {
                let frame = if is_document_notice(frame["operation"].as_str().unwrap_or("")) {
                    let Some(state) = handle.try_state::<ProductionState>() else {
                        return Ok(());
                    };
                    let captured = state
                        .notice_document
                        .lock()
                        .map_err(|_| EngineError::new("DISCONNECTED"))?
                        .clone();
                    let Some((epoch, lease)) = captured else {
                        return Ok(());
                    };
                    if frame["engineEpoch"] != epoch {
                        return Ok(());
                    }
                    let Some(window) = handle.get_webview_window("main") else {
                        return Ok(());
                    };
                    // Only bootstrap activates this lease. Do not mint a new
                    // document grant or redirect a queued notice after reload.
                    if state.ui.assert_publish(&window, &epoch, &lease).is_err() {
                        return Ok(());
                    }
                    document_notice_frame(&frame, &epoch, &lease)?
                } else {
                    frame
                };
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
            notification,
            energy: energy_host,
            ui_snapshot: Some(ui_snapshot),
            ui_command: Some(ui_command),
            installer_progress: Some(installer_progress),
        },
    )
    .await
}

pub fn run() {
    let context = tauri::generate_context!();
    let builder = tauri::Builder::default();
    #[cfg(target_os = "linux")]
    let builder = builder.plugin(native_oauth::single_instance(&context.config().identifier));
    let app = builder
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
            let oauth = native_oauth::NativeOAuthOwner::default();
            oauth.reject_cold_callback(
                &std::env::args_os()
                    .take(3)
                    .map(|value| value.to_string_lossy().into_owned())
                    .collect::<Vec<_>>(),
            );
            let ui = NativeUiOwner::default();
            let notifications = NativeNotificationOwner::new(app.handle(), native_work.clone())
                .map_err(|_| std::io::Error::other("PRODUCTION_NOTIFICATION_UNAVAILABLE"))?;
            let energy = NativeEnergyOwner::new(app.handle(), native_work.clone()).ok();
            let (tray_app, tray_work, tray_ui) =
                (app.handle().clone(), native_work.clone(), ui.clone());
            let tray_scope: native_tray::Scope = Arc::new(move || {
                tray_work.assert_open()?;
                let window = tray_app
                    .get_webview_window("main")
                    .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
                tray_ui.assert_window(&window)
            });
            let tray = NativeTrayOwner::new(app.handle(), native_work.clone(), tray_scope).ok();
            let started = tauri::async_runtime::block_on(start(
                app.handle(),
                native_work.clone(),
                oauth.clone(),
                ui.clone(),
                notifications.clone(),
                tray.as_ref().is_some_and(|owner| owner.is_available()),
                energy.clone(),
            ));
            let saved_window = match &started {
                Ok(engine) => {
                    tauri::async_runtime::block_on(engine.load_window_state(&engine.epoch()))
                        .unwrap_or_else(|_| {
                            eprintln!("PRODUCTION_WINDOW_RESTORE_UNAVAILABLE");
                            None
                        })
                }
                Err(_) => None,
            };
            let window_owner =
                NativeWindowOwner::new(native_work.clone(), started.as_ref().ok().cloned());
            let state = match started {
                Ok(engine) => ProductionState {
                    engine: Some(engine),
                    failure: None,
                    native_work: native_work.clone(),
                    oauth: oauth.clone(),
                    ui: ui.clone(),
                    window: window_owner.clone(),
                    notifications: notifications.clone(),
                    tray: tray.clone(),
                    energy: energy.clone(),
                    notice_document: Mutex::new(None),
                },
                Err(error) => ProductionState {
                    engine: None,
                    failure: Some(error),
                    native_work,
                    oauth: oauth.clone(),
                    ui: ui.clone(),
                    window: window_owner.clone(),
                    notifications: notifications.clone(),
                    tray: tray.clone(),
                    energy: energy.clone(),
                    notice_document: Mutex::new(None),
                },
            };
            app.manage(state);
            let ticket = ui
                .reserve_window()
                .map_err(|_| std::io::Error::other("PRODUCTION_UI_UNAVAILABLE"))?;
            let navigation_ui = ui.clone();
            let page_ui = ui.clone();
            let media_navigation = native_media::StartupNavigation::default();
            let window = tauri::WebviewWindowBuilder::new(app, "main", native_media::initial_url())
                .title("21x Production Preview")
                .visible(false)
                .inner_size(1280.0, 850.0)
                .on_navigation(move |url| {
                    if media_navigation.allows_blank(url) {
                        return true;
                    }
                    if !trusted_origin(url) {
                        return false;
                    }
                    media_navigation.application();
                    navigation_ui.navigation(ticket).is_ok()
                })
                .on_page_load(move |window, payload| match payload.event() {
                    tauri::webview::PageLoadEvent::Started => {
                        // A hidden first load must obtain its physical handle
                        // before recording the start; never infer readiness from
                        // an unmatched completion after native realization.
                        let _ = native_window::prepare(&window);
                        let _ = page_ui.page_started(ticket, &window);
                    }
                    tauri::webview::PageLoadEvent::Finished => {
                        if trusted_origin(payload.url()) {
                            let _ = page_ui.page_finished(ticket, &window);
                        }
                    }
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_download(|_, _| false)
                .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
                .build()?;
            native_window::prepare(&window)
                .map_err(|_| std::io::Error::other("PRODUCTION_WINDOW_CONTROLS_UNAVAILABLE"))?;
            #[cfg(not(target_os = "linux"))]
            ui.attach_window(ticket, &window)
                .map_err(|_| std::io::Error::other("PRODUCTION_UI_UNAVAILABLE"))?;
            ui.watch_destroy(ticket, &window)
                .map_err(|_| std::io::Error::other("PRODUCTION_UI_UNAVAILABLE"))?;
            let restored =
                native_window::apply_restore(&window, saved_window).unwrap_or_else(|_| {
                    eprintln!("PRODUCTION_WINDOW_RESTORE_UNAVAILABLE");
                    twentyonex_engine::production_window::restore(
                        None,
                        &native_window::monitors(&window),
                    )
                });
            if window_owner.attach(&window, ui.clone(), restored).is_err() {
                // Geometry/menu platform failures must not turn a usable
                // trusted window into a blank startup failure.
                eprintln!("PRODUCTION_WINDOW_CONTROLS_UNAVAILABLE");
            }
            window.show()?;
            native_media::load(
                window.clone(),
                app.state::<ProductionState>().native_work.clone(),
            )
            .map_err(|_| std::io::Error::other("PRODUCTION_MEDIA_ADMISSION_UNAVAILABLE"))?;
            if let Some(tray) = tray.filter(|owner| owner.is_available()) {
                attach_tray_close(
                    &window,
                    tray,
                    app.state::<ProductionState>().native_work.clone(),
                    ui.clone(),
                );
            }
            Ok(())
        })
        .build(context)
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
            if state.window.stop().is_err()
                || state.oauth.stop().is_err()
                || state.ui.close().is_err()
                || state.native_work.close().is_err()
            {
                eprintln!("PRODUCTION_NATIVE_WORK_DRAIN_BLOCKED");
                quitting.store(0, Ordering::SeqCst);
                return;
            }
            let engine = state.engine.clone();
            let native_work = state.native_work.clone();
            let window_owner = state.window.clone();
            let notifications = state.notifications.clone();
            let tray = state.tray.clone();
            let energy = state.energy.clone();
            let handle = handle.clone();
            let quitting = quitting.clone();
            tauri::async_runtime::spawn(async move {
                let mut code = 0;
                // Cancel the owned portal interaction before joining normal
                // work, which can include an unanswered permission response.
                if let Some(energy) = energy {
                    if energy.close().await.is_err() {
                        eprintln!("PRODUCTION_ENERGY_DRAIN_BLOCKED");
                        quitting.store(0, Ordering::SeqCst);
                        return;
                    }
                }
                // Flush only captured normal geometry while Source still owns
                // the database. Raw writes remain joined across public timeout.
                match window_owner.close().await {
                    Ok(true) => {}
                    Ok(false) => eprintln!("PRODUCTION_WINDOW_PERSISTENCE_UNAVAILABLE"),
                    Err(_) => {
                        eprintln!("PRODUCTION_WINDOW_DRAIN_BLOCKED");
                        quitting.store(0, Ordering::SeqCst);
                        return;
                    }
                }
                // Join native invocations before Node may release its profile
                // and stores, as well as before the application exits.
                if native_work.drain().await.is_err() {
                    eprintln!("PRODUCTION_NATIVE_WORK_DRAIN_BLOCKED");
                    quitting.store(0, Ordering::SeqCst);
                    return;
                }
                if let Some(tray) = tray {
                    if tray.close().await.is_err() {
                        eprintln!("PRODUCTION_TRAY_DRAIN_BLOCKED");
                        quitting.store(0, Ordering::SeqCst);
                        return;
                    }
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
                if notifications.close().await.is_err() {
                    eprintln!("PRODUCTION_NOTIFICATION_DRAIN_BLOCKED");
                    quitting.store(0, Ordering::SeqCst);
                    return;
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
    fn only_exact_validated_notices_receive_a_native_document_envelope() {
        for (operation, payload) in [
            (
                "agent:incompatible-session",
                json!({"taskId":"task_fixture","agentId":"agent_fixture","error":"The backend session is no longer available. Start a new session to continue with a recap."}),
            ),
            (
                "task:checkpointAnswered",
                json!({"taskId":"task_fixture","approved":false}),
            ),
            (
                "task:source-action-failed",
                json!({"taskId":"task_fixture","taskTitle":"Review 雪","error":"The task source action failed. Review the task and retry."}),
            ),
        ] {
            let frame = json!({"kind":"event","protocolVersion":1,"engineEpoch":"engine_fixture","sequence":42,"operation":operation,"payload":payload});
            assert_eq!(
                document_notice_frame(&frame, "engine_fixture", "document:fixture").unwrap(),
                json!({"engineEpoch":"engine_fixture","leaseId":"document:fixture","event":frame})
            );
            assert!(document_notice_frame(&frame, "foreign_epoch", "document:fixture").is_err());
            assert!(document_notice_frame(&frame, "engine_fixture", "../foreign").is_err());
            let mut injected = frame.clone();
            injected["leaseId"] = json!("caller-document");
            assert!(
                document_notice_frame(&injected, "engine_fixture", "document:fixture").is_err()
            );
            injected = frame.clone();
            injected["payload"]["rawError"] = json!("private backend credential");
            assert!(
                document_notice_frame(&injected, "engine_fixture", "document:fixture").is_err()
            );
        }
        let checkpoint = json!({"kind":"event","protocolVersion":1,"engineEpoch":"engine_fixture","sequence":1,"operation":"task:checkpointAnswered","payload":{"taskId":"task_fixture","approved":"true"}});
        assert!(document_notice_frame(&checkpoint, "engine_fixture", "document:fixture").is_err());
        assert!(!is_document_notice("agent:status"));
        assert!(!is_document_notice("tasks:refresh"));
    }

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
