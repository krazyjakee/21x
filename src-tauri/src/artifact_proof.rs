//! A fixed debug diagnostic. Production artifacts require a separate unprivileged Webview.
use serde_json::{json, Value};
use std::{
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindow};
use twentyonex_engine::Engine;

const LABEL: &str = "artifact-proof";
const SCHEME: &str = "artifact-proof";
const SCRIPT: &str = include_str!("artifact-proof.js");
const FRAME_SCRIPT: &str = include_str!("artifact-frame-proof.js");

pub(crate) fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_uri_scheme_protocol(SCHEME, |context, request| {
        let enabled = context.app_handle().try_state::<std::sync::Arc<crate::NativeSmoke>>()
            .is_some_and(|smoke| smoke.enabled());
        let permitted = enabled && context.webview_label() == LABEL && request.method() == "GET";
        let (kind, body): (&str, &[u8]) = match (permitted, request.uri().path()) {
            (true, "/outer") => ("text/html", b"<!doctype html><meta charset=utf-8><title>Artifact authorization diagnostic</title><iframe id=hostile-artifact sandbox=allow-scripts src=frame></iframe>"),
            (true, "/frame") => ("text/html", b"<!doctype html><meta charset=utf-8><title>Opaque hostile fixture</title><script src=frame.js></script>"),
            (true, "/frame.js") => ("text/javascript", FRAME_SCRIPT.as_bytes()),
            _ => ("text/plain", b"Artifact diagnostic resource unavailable."),
        };
        // This protocol exists only in this debug feature, only for this label.
        // The app's own CSP remains frame-src 'none' and has no new grants.
        let allowed = permitted && matches!(request.uri().path(), "/outer" | "/frame" | "/frame.js");
        tauri::http::Response::builder().status(if allowed { 200 } else { 403 })
            .header("Content-Type", format!("{kind}; charset=utf-8"))
            .header("X-Content-Type-Options", "nosniff")
            .header("Cache-Control", "no-store")
            .header("Content-Security-Policy", "default-src 'none'; script-src artifact-proof: http://artifact-proof.localhost https://artifact-proof.localhost; frame-src artifact-proof: http://artifact-proof.localhost https://artifact-proof.localhost; connect-src ipc: http://ipc.localhost; base-uri 'none'; form-action 'none'")
            .body(body.to_vec()).unwrap()
    })
}

fn script(mode: &str, epoch: &str) -> String {
    SCRIPT.replace(
        "__21X_PROOF_CONFIG__",
        &json!({"mode":mode,"engineEpoch":epoch}).to_string(),
    )
}
fn evaluate(window: &WebviewWindow) -> Option<Value> {
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .eval_with_callback("window.__21X_ARTIFACT_PROOF__ || null", move |value| {
            let _ = sender.try_send(value);
        })
        .ok()?;
    serde_json::from_str(&receiver.recv_timeout(Duration::from_millis(500)).ok()?).ok()
}
fn wait(
    window: &WebviewWindow,
    deadline: Instant,
    phase: &str,
    require_event: bool,
) -> Option<Value> {
    while Instant::now() < deadline {
        if let Some(value) = evaluate(window) {
            if value["phase"] == phase
                && value["complete"] == true
                && (!require_event || value["eventReceived"] == true)
            {
                return Some(value);
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
    None
}
fn all(value: &Value, keys: &[&str]) -> bool {
    keys.iter().all(|key| value[*key] == true)
}
fn artifact_url(url: &tauri::Url) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && ((url.scheme() == SCHEME && url.host_str() == Some("localhost"))
            || url.scheme() == "http" && url.host_str() == Some("artifact-proof.localhost"))
        && matches!(url.path(), "/outer" | "/frame")
}
struct OwnedWindow(WebviewWindow);
impl Drop for OwnedWindow {
    fn drop(&mut self) {
        let _ = self.0.destroy();
    }
}
struct MainListener(WebviewWindow);
impl Drop for MainListener {
    fn drop(&mut self) {
        let _ = self.0.eval("window.__21X_ARTIFACT_PROOF_UNLISTEN__?.(); delete window.__21X_ARTIFACT_PROOF_UNLISTEN__;");
    }
}

pub(crate) fn run(main: &WebviewWindow) -> Value {
    let mut report = json!({"passed":false,"boundary":"separate-webview","sameMainIframeIsolationProven":false,
        "frameNativeAttemptMethod":"unprivileged-parent-relay","defaultMainCspUnchanged":true});
    let deadline = Instant::now() + Duration::from_secs(15);
    let engine = main.state::<Engine>().inner().clone();
    let status = engine.status();
    let Some(epoch) = status["engineEpoch"].as_str() else {
        return report;
    };
    if status["syntheticDesktop"] != true {
        return report;
    }
    let _main_listener = MainListener(main.clone());
    let main_injected = main.eval(script("main", epoch)).is_ok();
    let controls = if main_injected {
        wait(main, deadline, "main", false)
    } else {
        None
    };
    report["mainPositiveControls"] = controls.clone().unwrap_or(Value::Null);
    if !controls.as_ref().is_some_and(|value| {
        all(
            value,
            &[
                "transportAvailable",
                "desktopAccepted",
                "statusAccepted",
                "listenAccepted",
            ],
        )
    }) {
        return report;
    }
    let epoch_owned = epoch.to_string();
    let epoch_for_load = epoch_owned.clone();
    let built = tauri::WebviewWindowBuilder::new(
        main.app_handle(),
        LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Artifact authorization diagnostic")
    .inner_size(420.0, 180.0)
    .on_navigation(|url| {
        (crate::trusted_origin(url)
            && matches!(url.path(), "/" | "/index.html")
            && url.query().is_none()
            && url.fragment().is_none())
            || artifact_url(url)
    })
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .on_download(|_, _| false)
    .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
    .on_page_load(move |window, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            let mode = if artifact_url(payload.url()) {
                "frame"
            } else {
                "excluded"
            };
            let _ = window.eval(script(mode, &epoch_for_load));
        }
    })
    .build();
    let Ok(window) = built else {
        return report;
    };
    let artifact = OwnedWindow(window);
    let local = wait(&artifact.0, deadline, "excluded", false);
    report["sameLocalOriginExcludedWebview"] = local.clone().unwrap_or(Value::Null);
    if !local.as_ref().is_some_and(|value| {
        all(
            value,
            &[
                "transportAvailable",
                "desktopDenied",
                "statusDenied",
                "listenDenied",
            ],
        )
    }) {
        return report;
    }
    // Reset the old result before navigation; readiness is observed through the
    // new document's Finished callback, not assumed from build/navigate return.
    let _ = artifact.0.eval("window.__21X_ARTIFACT_PROOF__ = null");
    let url = if cfg!(windows) {
        "http://artifact-proof.localhost/outer"
    } else {
        "artifact-proof://localhost/outer"
    };
    if artifact.0.navigate(url.parse().unwrap()).is_err() {
        return report;
    }
    let frame = wait(&artifact.0, deadline, "frame", false);
    report["sandboxedArtifactFrame"] = frame.clone().unwrap_or(Value::Null);
    let frame_ok = frame.as_ref().is_some_and(|value| {
        all(
            value,
            &[
                "transportAvailable",
                "frameLoaded",
                "parentAccessDenied",
                "parentGlobalDenied",
                "frameBridgeAbsent",
                "relayDesktopDenied",
                "relayStatusDenied",
                "relayListenDenied",
            ],
        )
    });
    // Exercise the real service event path after the excluded-context listener
    // attempts. Existing renderer codecs must receive a valid domain event.
    let (sender, receiver) = mpsc::sync_channel(1);
    let mutation = tauri::async_runtime::spawn(async move {
        let emitted = engine
            .desktop_request(
                &epoch_owned,
                "db:createTask",
                json!({"data":{"title":"Artifact isolation canary"}}),
            )
            .await
            .is_ok();
        let _ = sender.try_send(emitted);
    });
    let emitted = receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .unwrap_or(false);
    mutation.abort();
    let canary = if emitted {
        wait(main, deadline, "main", true)
    } else {
        None
    };
    report["mainReceivedTargetedServiceEvent"] = json!(canary.is_some());
    let _ = artifact.0.close();
    while Instant::now() < deadline && main.app_handle().get_webview_window(LABEL).is_some() {
        thread::sleep(Duration::from_millis(25));
    }
    report["artifactWindowClosed"] = json!(main.app_handle().get_webview_window(LABEL).is_none());
    report["passed"] =
        json!(frame_ok && canary.is_some() && report["artifactWindowClosed"] == true);
    report
}
