//! A fixed debug diagnostic. Production artifacts require a separate unprivileged Webview.
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindow};
use twentyonex_engine::Engine;

const LABEL: &str = "artifact-proof";
const SCHEME: &str = "artifact-proof";
const SCRIPT: &str = include_str!("artifact-proof.js");
const FRAME_SCRIPT: &str = include_str!("artifact-frame-proof.js");
const DENIAL_MATCHER: &str = include_str!("artifact-denial-matcher.js");

pub(crate) fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_uri_scheme_protocol(SCHEME, |context, request| {
        let enabled = context.app_handle().try_state::<std::sync::Arc<crate::NativeSmoke>>()
            .is_some_and(|smoke| smoke.enabled());
        let permitted = enabled && context.webview_label() == LABEL && request.method() == "GET";
        let frame_script = FRAME_SCRIPT.replace("__21X_DENIAL_MATCHER__", DENIAL_MATCHER);
        let (kind, body): (&str, &[u8]) = match (permitted, request.uri().path()) {
            (true, "/outer") => ("text/html", b"<!doctype html><meta charset=utf-8><title>Artifact authorization diagnostic</title><iframe id=hostile-artifact sandbox=allow-scripts src=frame></iframe>"),
            (true, "/frame") => ("text/html", b"<!doctype html><meta charset=utf-8><title>Opaque hostile fixture</title><script src=frame.js></script>"),
            (true, "/frame.js") => ("text/javascript", frame_script.as_bytes()),
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
    SCRIPT
        .replace("__21X_DENIAL_MATCHER__", DENIAL_MATCHER)
        .replace(
            "__21X_PROOF_CONFIG__",
            &json!({"mode":mode,"engineEpoch":epoch}).to_string(),
        )
}
fn evaluate(window: &WebviewWindow) -> Option<Value> {
    evaluate_expression(window, "window.__21X_ARTIFACT_PROOF__ || null")
}
fn evaluate_expression(window: &WebviewWindow, expression: &str) -> Option<Value> {
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .eval_with_callback(expression, move |value| {
            let _ = sender.try_send(value);
        })
        .ok()?;
    serde_json::from_str(&receiver.recv_timeout(Duration::from_millis(500)).ok()?).ok()
}
fn wait_document(window: &WebviewWindow, deadline: Instant, artifact: bool) -> bool {
    let expression = if artifact {
        "document.readyState === 'complete' && location.pathname === '/outer' && (location.protocol === 'artifact-proof:' || location.hostname === 'artifact-proof.localhost')"
    } else {
        "document.readyState === 'complete' && location.protocol !== 'about:'"
    };
    while Instant::now() < deadline {
        if evaluate_expression(window, expression) == Some(json!(true)) {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    false
}
fn wait(
    window: &WebviewWindow,
    deadline: Instant,
    phase: &str,
    require_event: bool,
) -> Option<Value> {
    let mut last = None;
    while Instant::now() < deadline {
        if let Some(value) = evaluate(window) {
            if value["phase"] == phase {
                last = Some(value.clone());
            }
            if value["phase"] == phase
                && value["complete"] == true
                && (!require_event || value["eventReceived"] == true)
            {
                return Some(value);
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
    last
}
fn all(value: &Value, keys: &[&str]) -> bool {
    keys.iter().all(|key| value[*key] == true)
}
fn frame_ipc_denied(value: &Value) -> bool {
    if [
        "directDeadlineReached",
        "directUnrecognizedFailure",
        "directAccepted",
    ]
    .iter()
    .any(|key| value[*key] != false)
    {
        return false;
    }
    let denials = [
        "directDesktopDenied",
        "directStatusDenied",
        "directListenDenied",
    ];
    if value["frameBridgeAbsent"] == true {
        value["directAttempted"] == false && denials.iter().all(|key| value[*key] == false)
    } else {
        value["frameBridgeAbsent"] == false
            && value["directAttempted"] == true
            && all(value, &denials)
    }
}
fn initial_app_url(url: &tauri::Url) -> bool {
    // Tauri intentionally omits index.html. Its non-HTTP packaged root is
    // tauri://localhost with an EMPTY path, unlike HTTP's slash root.
    crate::trusted_origin(url)
        && matches!(url.path(), "" | "/" | "/index.html")
        && url.query().is_none()
        && url.fragment().is_none()
}
fn navigation_class(url: &tauri::Url) -> (&'static str, bool) {
    if url.as_str() == "about:blank" {
        ("initial-blank", true)
    } else if initial_app_url(url) {
        (
            match url.path() {
                "" => "app-empty-root",
                "/" => "app-slash-root",
                _ => "app-index",
            },
            true,
        )
    } else if artifact_url(url) {
        ("fixed-artifact", true)
    } else if crate::trusted_origin(url) {
        ("blocked-app-route", false)
    } else {
        ("blocked-origin", false)
    }
}
struct NavigationEvidence {
    observed: u32,
    allowed: u32,
    denied: u32,
    last_class: &'static str,
}
impl NavigationEvidence {
    fn record(&mut self, class: &'static str, allowed: bool) {
        self.observed = self.observed.saturating_add(1);
        if allowed {
            self.allowed = self.allowed.saturating_add(1);
        } else {
            self.denied = self.denied.saturating_add(1);
        }
        self.last_class = class;
    }
    fn report(&self) -> Value {
        json!({"observed":self.observed,"allowed":self.allowed,"denied":self.denied,"lastClass":self.last_class})
    }
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
        "policyVersion":2,"frameNativeAttemptMethod":"parent-relay-and-conditional-direct-frame","defaultMainCspUnchanged":true});
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
    let local_finished = Arc::new(AtomicBool::new(false));
    let local_injected = Arc::new(AtomicBool::new(false));
    let finished_for_load = local_finished.clone();
    let navigation = Arc::new(Mutex::new(NavigationEvidence {
        observed: 0,
        allowed: 0,
        denied: 0,
        last_class: "none",
    }));
    let navigation_for_load = navigation.clone();
    let built = tauri::WebviewWindowBuilder::new(
        main.app_handle(),
        LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Artifact authorization diagnostic")
    .inner_size(420.0, 180.0)
    .on_navigation(move |url| {
        let (class, allowed) = navigation_class(url);
        navigation_for_load.lock().unwrap().record(class, allowed);
        allowed
    })
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .on_download(|_, _| false)
    .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
    .on_page_load(move |window, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            if initial_app_url(payload.url()) {
                finished_for_load.store(true, Ordering::SeqCst);
            }
            // A dynamically created Webview can complete its first load before
            // this callback is observed. The worker verifies document readiness
            // and injects once, independently of callback delivery.
            let _ = window;
        }
    })
    .build();
    let Ok(window) = built else {
        report["artifactWindowCreated"] = json!(false);
        report["navigation"] = navigation.lock().unwrap().report();
        return report;
    };
    report["artifactWindowCreated"] = json!(true);
    let artifact = OwnedWindow(window);
    let local_ready = wait_document(&artifact.0, deadline, false);
    let same_origin = artifact
        .0
        .url()
        .is_ok_and(|url| crate::trusted_origin(&url));
    report["excludedDocumentReady"] = json!(local_ready);
    report["excludedSameAppOrigin"] = json!(same_origin);
    if local_ready && same_origin {
        local_injected.store(
            artifact.0.eval(script("excluded", epoch)).is_ok(),
            Ordering::SeqCst,
        );
    }
    let local = wait(&artifact.0, deadline, "excluded", false);
    report["sameLocalOriginExcludedWebview"] = local.clone().unwrap_or(Value::Null);
    report["excludedPageFinished"] = json!(local_finished.load(Ordering::SeqCst));
    report["excludedScriptSubmitted"] = json!(local_injected.load(Ordering::SeqCst));
    report["navigation"] = navigation.lock().unwrap().report();
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
    if !wait_document(&artifact.0, deadline, true)
        || !artifact.0.url().is_ok_and(|url| artifact_url(&url))
    {
        return report;
    }
    if artifact.0.eval(script("frame", epoch)).is_err() {
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
                "relayDesktopDenied",
                "relayStatusDenied",
                "relayListenDenied",
            ],
        ) && frame_ipc_denied(value)
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
    let received = canary
        .as_ref()
        .is_some_and(|value| value["eventReceived"] == true);
    report["mainReceivedTargetedServiceEvent"] = json!(received);
    let _ = artifact.0.close();
    while Instant::now() < deadline && main.app_handle().get_webview_window(LABEL).is_some() {
        thread::sleep(Duration::from_millis(25));
    }
    report["artifactWindowClosed"] = json!(main.app_handle().get_webview_window(LABEL).is_none());
    report["navigation"] = navigation.lock().unwrap().report();
    report["passed"] = json!(frame_ok && received && report["artifactWindowClosed"] == true);
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injected_frame_requires_all_direct_native_denials() {
        let absent = json!({"frameBridgeAbsent":true,"directAttempted":false,
            "directDesktopDenied":false,"directStatusDenied":false,"directListenDenied":false,
            "directDeadlineReached":false,"directUnrecognizedFailure":false,"directAccepted":false});
        assert!(frame_ipc_denied(&absent));
        let injected = json!({"frameBridgeAbsent":false,"directAttempted":true,
            "directDesktopDenied":true,"directStatusDenied":true,"directListenDenied":true,
            "directDeadlineReached":false,"directUnrecognizedFailure":false,"directAccepted":false});
        assert!(frame_ipc_denied(&injected));
        for key in [
            "directAttempted",
            "directDesktopDenied",
            "directStatusDenied",
            "directListenDenied",
        ] {
            let mut invalid = injected.clone();
            invalid[key] = json!(false);
            assert!(!frame_ipc_denied(&invalid));
            invalid[key] = Value::Null;
            assert!(!frame_ipc_denied(&invalid));
            let mut invented = absent.clone();
            invented[key] = json!(true);
            assert!(!frame_ipc_denied(&invented));
        }
    }

    #[test]
    fn packaged_root_uses_tauris_actual_empty_path() {
        let url = tauri::Url::parse("tauri://localhost").unwrap();
        assert_eq!(url.path(), "");
        assert_eq!(navigation_class(&url), ("app-empty-root", true));
        for raw in [
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
        ] {
            assert!(initial_app_url(&tauri::Url::parse(raw).unwrap()));
        }
    }

    #[test]
    fn root_compatibility_does_not_grant_other_routes_or_origins() {
        for raw in [
            "tauri://localhost/private",
            "tauri://localhost?fixture=1",
            "tauri://localhost#fixture",
            "tauri://user@localhost",
            "https://example.invalid/",
            "artifact-proof://localhost/other",
            "artifact-proof://localhost/outer?fixture=1",
        ] {
            assert!(!navigation_class(&tauri::Url::parse(raw).unwrap()).1);
        }
        assert_eq!(
            navigation_class(&tauri::Url::parse("about:blank").unwrap()),
            ("initial-blank", true)
        );
        assert_eq!(
            navigation_class(&tauri::Url::parse("artifact-proof://localhost/outer").unwrap()),
            ("fixed-artifact", true)
        );
    }
}
