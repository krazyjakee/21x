//! A separate excluded static HTML viewer. This private owner adds no desktop
//! operation, capability grant, OS protocol handler or renderer HTML input.
use super::{available_engine, native_services::NativeWorkOwner, production_ui::NativeUiOwner};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindow};
use tokio::sync::{Mutex as AsyncMutex, Notify};
use twentyonex_engine::{
    production::HostFuture, production_artifact_viewer as policy, EngineError,
};

pub type Scope = Arc<dyn Fn() -> Result<(), EngineError> + Send + Sync>;
pub type Closed = Arc<dyn Fn(String, Value) -> HostFuture<Value> + Send + Sync>;
const FAILURE: &str = "DISCONNECTED";
fn error(code: &'static str) -> EngineError {
    EngineError::new(code)
}

struct EntryState {
    closing: bool,
    retired: bool,
    attempted: bool,
    loaded: bool,
    served: bool,
    window: Option<WebviewWindow>,
    destroyed: bool,
    raw: usize,
    reason: &'static str,
    html: Option<Arc<Vec<u8>>>,
}
struct Entry {
    id: String,
    parent: WebviewWindow,
    scope: Scope,
    deadline: Instant,
    state: Mutex<EntryState>,
    changed: Notify,
    retirement: AsyncMutex<()>,
    #[cfg(test)]
    rejected_navigations: std::sync::atomic::AtomicUsize,
}
#[derive(Default)]
struct State {
    epoch: Option<String>,
    closing: bool,
    entries: HashMap<String, Arc<Entry>>,
    ids: HashSet<String>,
}
struct Inner {
    state: Mutex<State>,
    work: NativeWorkOwner,
    closed: Closed,
}
#[derive(Clone)]
pub struct NativeArtifactViewerOwner(Arc<Inner>);
struct Raw(Arc<Entry>);
impl Drop for Raw {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.state.lock() {
            state.raw -= 1;
        }
        self.0.changed.notify_waiters();
    }
}
impl Entry {
    fn current(&self) -> Result<(), EngineError> {
        (self.scope)()?;
        let state = self.state.lock().map_err(|_| error(FAILURE))?;
        if state.closing || state.retired || Instant::now() >= self.deadline {
            return Err(error("STALE_EPOCH"));
        }
        Ok(())
    }
    fn fence(&self, reason: &'static str) {
        if let Ok(mut state) = self.state.lock() {
            if !state.closing {
                state.reason = reason;
            }
            state.closing = true;
        }
        self.changed.notify_waiters();
    }
}
impl NativeArtifactViewerOwner {
    pub fn new(work: NativeWorkOwner, closed: Closed) -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(State::default()),
            work,
            closed,
        }))
    }
    pub fn host(
        &self,
        app: &tauri::AppHandle,
        ui: NativeUiOwner,
    ) -> twentyonex_engine::production::ProductionArtifactViewerHost {
        let (owner, app, closing) = (self.clone(), app.clone(), self.clone());
        let close_app = app.clone();
        twentyonex_engine::production::ProductionArtifactViewerHost {
            invoke: Arc::new(move |operation, payload, epoch| {
                let (owner, app, ui) = (owner.clone(), app.clone(), ui.clone());
                Box::pin(async move {
                    owner.bind_epoch(&epoch)?;
                    if operation == "host.artifactViewer.retire" {
                        if !policy::identity(&payload) {
                            return Err(error("INVALID_ARGUMENTS"));
                        }
                        return owner
                            .retire(app, payload["viewerId"].as_str().unwrap().into())
                            .await;
                    }
                    owner.0.work.assert_open()?;
                    available_engine(&app, Some(&epoch))?;
                    if operation == "host.artifactViewer.register" {
                        if !policy::registration(&payload) {
                            return Err(error("INVALID_ARGUMENTS"));
                        }
                        let window = app
                            .get_webview_window("main")
                            .ok_or_else(|| error(FAILURE))?;
                        let lease = payload["uiLeaseId"].as_str().unwrap().to_owned();
                        ui.assert_publish(&window, &epoch, &lease)?;
                        let (checking, guard_app) = (owner.0.work.clone(), app.clone());
                        let captured_window = window.clone();
                        let scope: Scope = Arc::new(move || {
                            checking.assert_open()?;
                            available_engine(&guard_app, Some(&epoch))?;
                            ui.assert_publish(&captured_window, &epoch, &lease)
                        });
                        return owner.register(&app, &payload, scope, window);
                    }
                    if operation != "host.artifactViewer.open" || !policy::identity(&payload) {
                        return Err(error("INVALID_ARGUMENTS"));
                    }
                    owner
                        .open(app, payload["viewerId"].as_str().unwrap().into())
                        .await
                })
            }),
            close: Arc::new(move || {
                closing.stop();
                let (owner, app) = (closing.clone(), close_app.clone());
                Box::pin(async move { owner.close(app).await })
            }),
        }
    }
    pub fn bind_epoch(&self, epoch: &str) -> Result<(), EngineError> {
        let mut state = self.0.state.lock().map_err(|_| error(FAILURE))?;
        match &state.epoch {
            Some(current) if current != epoch => Err(error("STALE_EPOCH")),
            Some(_) => Ok(()),
            None if !epoch.is_empty() && epoch.len() <= 128 => {
                state.epoch = Some(epoch.into());
                Ok(())
            }
            None => Err(error("INVALID_ARGUMENTS")),
        }
    }
    fn entry(&self, id: &str) -> Result<Arc<Entry>, EngineError> {
        self.0
            .state
            .lock()
            .map_err(|_| error(FAILURE))?
            .entries
            .get(id)
            .cloned()
            .ok_or_else(|| error("STALE_EPOCH"))
    }
    pub fn register(
        &self,
        app: &tauri::AppHandle,
        payload: &Value,
        scope: Scope,
        parent: WebviewWindow,
    ) -> Result<Value, EngineError> {
        if !cfg!(target_os = "linux") {
            return Err(error("UNSUPPORTED"));
        }
        if !policy::registration(payload) {
            return Err(error("INVALID_ARGUMENTS"));
        }
        self.0.work.assert_open()?;
        scope()?;
        let id = payload["viewerId"].as_str().unwrap().to_owned();
        let entry = {
            let mut state = self.0.state.lock().map_err(|_| error(FAILURE))?;
            if state.closing || state.epoch.is_none() {
                return Err(error(FAILURE));
            }
            if state.ids.contains(&id) {
                return Err(error("STALE_EPOCH"));
            }
            if state.entries.len() >= policy::ACTIVE || state.ids.len() >= policy::EPOCH_IDS {
                return Err(error("BACKPRESSURE"));
            }
            state.ids.insert(id.clone());
            let entry = Arc::new(Entry {
                id: id.clone(),
                parent,
                scope,
                deadline: Instant::now() + Duration::from_millis(policy::TTL_MS),
                state: Mutex::new(EntryState {
                    closing: false,
                    retired: false,
                    attempted: false,
                    loaded: false,
                    served: false,
                    window: None,
                    destroyed: false,
                    raw: 0,
                    reason: "closed",
                    html: Some(Arc::new(
                        payload["html"].as_str().unwrap().as_bytes().to_vec(),
                    )),
                }),
                changed: Notify::new(),
                retirement: AsyncMutex::new(()),
                #[cfg(test)]
                rejected_navigations: std::sync::atomic::AtomicUsize::new(0),
            });
            state.entries.insert(id.clone(), entry.clone());
            entry
        };
        // One bounded timer per admitted owner. Retirement wakes it immediately;
        // no 600-second timer holds global shutdown open.
        let (owner, timer_app, timer) = (self.clone(), app.clone(), entry.clone());
        tauri::async_runtime::spawn(async move {
            loop {
                let changed = timer.changed.notified();
                if timer.state.lock().map_or(true, |s| s.closing) {
                    return;
                }
                tokio::select! {
                    _ = tokio::time::sleep_until(tokio::time::Instant::from_std(timer.deadline)) => {
                        timer.fence("expired"); let _ = owner.retire(timer_app, timer.id.clone()).await; return;
                    }
                    _ = changed => {}
                }
            }
        });
        if let Err(error) = entry.current() {
            entry.fence("failed");
            let (owner, app, id) = (self.clone(), app.clone(), id.clone());
            tauri::async_runtime::spawn(async move {
                let _ = owner.retire(app, id).await;
            });
            return Err(error);
        }
        Ok(json!({"viewerId":id,"registered":true}))
    }
    /// The content handler is WebView-only, not an OS/app identity scheme.
    pub fn protocol(&self, label: &str, method: &str, uri: &str) -> tauri::http::Response<Vec<u8>> {
        let result = (|| {
            let id = label
                .strip_prefix("artifact-")
                .ok_or_else(|| error("UNAUTHORIZED"))?;
            if !policy::document_request(label, method, uri, id) {
                return Err(error("UNAUTHORIZED"));
            }
            let entry = self.entry(id)?;
            entry.current()?;
            let mut state = entry.state.lock().map_err(|_| error(FAILURE))?;
            if !state.attempted || state.served || state.closing {
                return Err(error("STALE_EPOCH"));
            }
            let html = state
                .html
                .as_ref()
                .ok_or_else(|| error("STALE_EPOCH"))?
                .as_ref()
                .clone();
            state.served = true;
            Ok(html)
        })();
        #[cfg(test)]
        eprintln!(
            "VIEWER_PROTOCOL label={label} method={method} uri={uri} accepted={}",
            result.is_ok()
        );
        tauri::http::Response::builder()
            .status(if result.is_ok() { 200 } else { 403 })
            .header("Content-Type", "text/html; charset=utf-8")
            .header("Content-Security-Policy", policy::CSP)
            .header("X-Content-Type-Options", "nosniff")
            .header("Cache-Control", "no-store")
            .body(result.unwrap_or_default())
            .expect("fixed viewer response headers")
    }
    pub async fn open(&self, app: tauri::AppHandle, id: String) -> Result<Value, EngineError> {
        let entry = self.entry(&id)?;
        entry.current()?;
        self.0.work.assert_open()?;
        {
            let state = self.0.state.lock().map_err(|_| error(FAILURE))?;
            if state.closing {
                return Err(error(FAILURE));
            }
            let mut state = entry.state.lock().map_err(|_| error(FAILURE))?;
            if state.attempted || state.closing {
                return Err(error("STALE_EPOCH"));
            }
            state.attempted = true;
            state.raw += 1;
        }
        let raw = Raw(entry.clone());
        let (send, receive) = tokio::sync::oneshot::channel();
        let owner = self.clone();
        // The owned driver survives loss of the requesting RPC future.
        tauri::async_runtime::spawn(async move {
            let result = owner.open_raw(app.clone(), entry.clone()).await;
            drop(raw);
            if result.is_err() {
                entry.fence("failed");
            }
            let failed = result.is_err();
            let _ = send.send(result.map(|()| json!({"viewerId":id,"opened":true})));
            if failed {
                let _ = owner.retire(app, entry.id.clone()).await;
            }
        });
        receive.await.map_err(|_| error(FAILURE))?
    }
    async fn open_raw(&self, app: tauri::AppHandle, entry: Arc<Entry>) -> Result<(), EngineError> {
        let (building, owner) = (entry.clone(), self.clone());
        self.0
            .work
            .run(move || {
                building.current()?;
                let (navigation, loaded, first) =
                    (building.clone(), building.clone(), AtomicBool::new(false));
                let window = tauri::WebviewWindowBuilder::new(
                    &app,
                    policy::label(&building.id),
                    tauri::WebviewUrl::External(
                        tauri::Url::parse("about:blank").expect("fixed blank viewer URL"),
                    ),
                )
                .parent(&building.parent)
                .map_err(|_| error(FAILURE))?
                .title("Artifact preview")
                .inner_size(720.0, 540.0)
                .visible(false)
                .incognito(true)
                .disable_javascript()
                .on_navigation(move |url| {
                    if url.as_str() == "about:blank" {
                        return navigation.current().is_ok() && !first.load(Ordering::SeqCst);
                    }
                    let allowed = navigation.current().is_ok()
                        && navigation
                            .state
                            .lock()
                            .is_ok_and(|state| !state.loaded && !state.served)
                        && url.as_str() == policy::document_url(&navigation.id)
                        && !first.swap(true, Ordering::SeqCst);
                    #[cfg(test)]
                    {
                        if !allowed {
                            navigation
                                .rejected_navigations
                                .fetch_add(1, Ordering::SeqCst);
                        }
                        eprintln!("VIEWER_NAVIGATION allowed={allowed} url={url}");
                    }
                    allowed
                })
                .on_document_title_changed(|window, title| {
                    if title != "Artifact preview" {
                        let _ = window.set_title("Artifact preview");
                    }
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_download(|_, _| false)
                .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
                .on_page_load(move |_, payload| {
                    #[cfg(test)]
                    eprintln!("VIEWER_LOAD {:?} {}", payload.event(), payload.url());
                    if payload.event() == tauri::webview::PageLoadEvent::Finished
                        && payload.url().as_str() == policy::document_url(&loaded.id)
                    {
                        if let Ok(mut state) = loaded.state.lock() {
                            if state.served {
                                state.loaded = true;
                            }
                        }
                        loaded.changed.notify_waiters();
                    }
                })
                .build()
                .map_err(|_| error(FAILURE))?;
                #[cfg(test)]
                eprintln!("VIEWER_BUILT {}", building.id);
                let (observing, receipt, destroyed_app) =
                    (owner.clone(), building.clone(), app.clone());
                window.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        observing.destroyed(receipt.clone(), destroyed_app.clone());
                    }
                });
                // Store the actual child before a post-build scope assertion may
                // fail. A parent retirement during build must still own destruction.
                building.state.lock().map_err(|_| error(FAILURE))?.window = Some(window.clone());
                building.changed.notify_waiters();
                owner.install_document(&window, building)
            })
            .await?;
        loop {
            let changed = entry.changed.notified();
            entry.current()?;
            let (loaded, window) = {
                let state = entry.state.lock().map_err(|_| error(FAILURE))?;
                (state.loaded, state.window.clone())
            };
            if loaded {
                let window = window.ok_or_else(|| error(FAILURE))?;
                let showing = entry.clone();
                self.0
                    .work
                    .run(move || {
                        showing.current()?;
                        window.show().map_err(|_| error(FAILURE))?;
                        showing.current()
                    })
                    .await?;
                return entry.current();
            }
            tokio::select! { _=changed=>{}, _=tokio::time::sleep_until(tokio::time::Instant::from_std(entry.deadline))=>return Err(error("STALE_EPOCH")) }
        }
    }
    /// Register only on this child's ephemeral WebKit context. Wry's shared
    /// runtime scheme registry does not represent an incognito WebKit context.
    /// The actual callback receipt stays owned by open's raw driver.
    #[cfg(target_os = "linux")]
    fn install_document(
        &self,
        window: &WebviewWindow,
        entry: Arc<Entry>,
    ) -> Result<(), EngineError> {
        use webkit2gtk::{
            glib::object::ObjectExt, URISchemeRequestExt, URISchemeResponseExt, WebContextExt,
            WebViewExt,
        };
        let owner = Arc::downgrade(&self.0);
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        window
            .with_webview(move |platform| {
                let result = (|| {
                    entry.current()?;
                    let view = platform.inner();
                    let context = view.context().ok_or_else(|| error(FAILURE))?;
                    if !context.is_ephemeral() {
                        return Err(error("UNAUTHORIZED"));
                    }
                    let native_view = view.downgrade();
                    let label = policy::label(&entry.id);
                    context.register_uri_scheme(policy::SCHEME, move |request| {
                        let response =
                            match (owner.upgrade(), native_view.upgrade(), request.web_view()) {
                                (Some(owner), Some(expected), Some(actual))
                                    if expected == actual =>
                                {
                                    NativeArtifactViewerOwner(owner).protocol(
                                        &label,
                                        request.http_method().as_deref().unwrap_or(""),
                                        request.uri().as_deref().unwrap_or(""),
                                    )
                                }
                                _ => tauri::http::Response::builder()
                                    .status(403)
                                    .body(Vec::new())
                                    .expect("fixed denied response"),
                            };
                        let (parts, body) = response.into_parts();
                        let len = body.len() as i64;
                        let stream = webkit2gtk::gio::MemoryInputStream::from_bytes(
                            &webkit2gtk::glib::Bytes::from_owned(body),
                        );
                        let response = webkit2gtk::URISchemeResponse::new(&stream, len);
                        response.set_status(u32::from(parts.status.as_u16()), None);
                        response.set_content_type("text/html; charset=utf-8");
                        let headers = soup::MessageHeaders::new(soup::MessageHeadersType::Response);
                        for (key, value) in &parts.headers {
                            if let Ok(value) = value.to_str() {
                                headers.append(key.as_str(), value);
                            }
                        }
                        response.set_http_headers(headers);
                        request.finish_with_response(&response);
                    });
                    entry.current()?;
                    view.load_uri(&policy::document_url(&entry.id));
                    Ok(())
                })();
                let _ = send.send(result);
            })
            .map_err(|_| error(FAILURE))?;
        receive.recv().map_err(|_| error(FAILURE))?
    }
    #[cfg(not(target_os = "linux"))]
    fn install_document(&self, _: &WebviewWindow, _: Arc<Entry>) -> Result<(), EngineError> {
        Err(error("UNAVAILABLE"))
    }
    fn destroyed(&self, entry: Arc<Entry>, app: tauri::AppHandle) {
        entry.fence("closed");
        let reason = {
            let Ok(mut state) = entry.state.lock() else {
                return;
            };
            if state.destroyed {
                return;
            };
            state.destroyed = true;
            state.raw += 1;
            state.reason
        };
        entry.changed.notify_waiters();
        let epoch = self
            .0
            .state
            .lock()
            .ok()
            .and_then(|s| s.epoch.clone())
            .unwrap_or_default();
        let (owner, raw) = (self.clone(), Raw(entry.clone()));
        tauri::async_runtime::spawn(async move {
            let _ = (owner.0.closed)(epoch, json!({"viewerId":entry.id,"reason":reason})).await;
            drop(raw);
            entry.changed.notify_waiters();
            let _ = owner.retire(app, entry.id.clone()).await;
        });
    }
    pub fn stop_document(&self, app: &tauri::AppHandle) {
        let entries = self
            .0
            .state
            .lock()
            .map(|s| s.entries.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for entry in entries {
            entry.fence("parent-retired");
            let (owner, app, id) = (self.clone(), app.clone(), entry.id.clone());
            tauri::async_runtime::spawn(async move {
                let _ = owner.retire(app, id).await;
            });
        }
    }
    #[cfg(target_os = "linux")]
    pub fn watch_parent(&self, window: &WebviewWindow) -> Result<(), EngineError> {
        use gtk::prelude::WidgetExt;
        let (owner, app) = (self.clone(), window.app_handle().clone());
        window
            .gtk_window()
            .map_err(|_| error(FAILURE))?
            .connect_hide(move |_| owner.stop_document(&app));
        Ok(())
    }
    pub fn stop(&self) {
        if let Ok(mut state) = self.0.state.lock() {
            state.closing = true;
            for entry in state.entries.values() {
                entry.fence("parent-retired")
            }
        }
    }
    pub async fn retire(&self, _app: tauri::AppHandle, id: String) -> Result<Value, EngineError> {
        if !policy::viewer_id(&id) {
            return Err(error("INVALID_ARGUMENTS"));
        }
        let entry = {
            let mut state = self.0.state.lock().map_err(|_| error(FAILURE))?;
            if let Some(entry) = state.entries.get(&id) {
                Some(entry.clone())
            } else {
                if !state.ids.contains(&id) && state.ids.len() >= policy::EPOCH_IDS {
                    return Err(error("BACKPRESSURE"));
                }
                state.ids.insert(id.clone());
                None
            }
        };
        let Some(entry) = entry else {
            return Ok(json!({"viewerId":id,"retired":true}));
        };
        entry.fence("closed");
        let _serial = entry.retirement.lock().await;
        loop {
            let changed = entry.changed.notified();
            let (window, destroyed, raw) = {
                let state = entry.state.lock().map_err(|_| error(FAILURE))?;
                (state.window.clone(), state.destroyed, state.raw)
            };
            if let Some(window) = window.filter(|_| !destroyed) {
                self.0
                    .work
                    .run_cleanup(move || window.destroy().map_err(|_| error(FAILURE)))
                    .await?;
                // Destroyed is a distinct native event; destroy() returning is
                // not an acknowledgement and does not release the owner.
            }
            if raw == 0
                && (destroyed
                    || entry
                        .state
                        .lock()
                        .map_err(|_| error(FAILURE))?
                        .window
                        .is_none())
            {
                let mut state = entry.state.lock().map_err(|_| error(FAILURE))?;
                state.retired = true;
                state.html = None;
                state.window = None;
                drop(state);
                self.0
                    .state
                    .lock()
                    .map_err(|_| error(FAILURE))?
                    .entries
                    .remove(&id);
                entry.changed.notify_waiters();
                return Ok(json!({"viewerId":id,"retired":true}));
            }
            changed.await;
        }
    }
    pub async fn close(&self, app: tauri::AppHandle) -> Result<(), EngineError> {
        self.stop();
        let entries = {
            let state = self.0.state.lock().map_err(|_| error(FAILURE))?;
            state.entries.values().cloned().collect::<Vec<_>>()
        };
        for entry in &entries {
            entry.fence("parent-retired")
        }
        for entry in entries {
            self.retire(app.clone(), entry.id.clone()).await?;
        }
        Ok(())
    }
}

#[cfg(all(test, target_os = "linux"))]
mod proof {
    use super::super::native_window::wry_proof::{js, pump};
    use super::super::{
        native_notifications::NativeNotificationOwner, native_window, ProductionState,
    };
    use super::*;
    use std::borrow::Cow;
    use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
    use webkit2gtk::{SettingsExt, WebViewExt};
    struct LoopbackProbe {
        address: std::net::SocketAddr,
        requests: Arc<std::sync::atomic::AtomicUsize>,
        stop: Arc<AtomicBool>,
        worker: Option<std::thread::JoinHandle<()>>,
    }
    impl LoopbackProbe {
        fn new() -> Self {
            use std::io::Write;
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            assert!(address.ip().is_loopback());
            listener.set_nonblocking(true).unwrap();
            let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let stop = Arc::new(AtomicBool::new(false));
            let (count, finished) = (requests.clone(), stop.clone());
            let worker = std::thread::spawn(move || {
                while !finished.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((mut stream, peer)) => {
                            assert!(peer.ip().is_loopback());
                            count.fetch_add(1, Ordering::SeqCst);
                            let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
                            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(2))
                        }
                        Err(error) => panic!("controlled loopback probe failed: {error}"),
                    }
                }
            });
            Self {
                address,
                requests,
                stop,
                worker: Some(worker),
            }
        }
    }
    impl Drop for LoopbackProbe {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            self.worker.take().unwrap().join().unwrap();
        }
    }
    struct Assets;
    impl tauri::Assets<tauri::Wry> for Assets {
        fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
            Some(Cow::Borrowed(
                b"<!doctype html><title>Controlled parent</title><p>parent</p>",
            ))
        }
        fn iter(&self) -> Box<AssetsIter<'_>> {
            Box::new(std::iter::once((
                Cow::Borrowed("index.html"),
                self.get(&AssetKey::from("index.html")).unwrap(),
            )))
        }
        fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
            Box::new(std::iter::empty())
        }
    }
    fn wait_js(app: &mut tauri::App, window: &WebviewWindow, expression: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(value) = serde_json::from_str::<Value>(&js(app, window, expression)) {
                if !value.is_null() {
                    return value;
                }
            }
            assert!(
                Instant::now() < deadline,
                "native viewer JS control deadline"
            );
            pump(app, || true);
        }
    }
    #[test]
    #[ignore = "requires isolated Xvfb/Wry; synthetic content and profiles only, no public viewer activation"]
    fn real_excluded_static_viewer_denies_hostile_authority_and_joins_actual_destruction() {
        let mut context = tauri::test::mock_context::<tauri::Wry, _>(Assets);
        let mut production: tauri::Context<tauri::Wry> =
            tauri::generate_context!("tauri.production.conf.json");
        // Use the actual compiled permission resolver (main only), with tiny
        // synthetic assets. No test capability grants the excluded child.
        std::mem::swap(
            context.runtime_authority_mut(),
            production.runtime_authority_mut(),
        );
        context.config_mut().identifier = "invalid.synthetic.artifact-viewer-proof".into();
        context.config_mut().app.with_global_tauri = true;
        let work = NativeWorkOwner::default();
        let callback_gate = Arc::new(Notify::new());
        let hold_callback = Arc::new(AtomicBool::new(false));
        let callbacks = Arc::new(Mutex::new(Vec::<Value>::new()));
        let (gate, holding, observed) = (
            callback_gate.clone(),
            hold_callback.clone(),
            callbacks.clone(),
        );
        let owner = NativeArtifactViewerOwner::new(
            work.clone(),
            Arc::new(move |epoch, payload| {
                assert_eq!(epoch, "native_viewer_fixture_epoch");
                let (gate, holding, observed) = (gate.clone(), holding.clone(), observed.clone());
                Box::pin(async move {
                    observed.lock().unwrap().push(payload);
                    while holding.load(Ordering::SeqCst) {
                        let changed = gate.notified();
                        if !holding.load(Ordering::SeqCst) {
                            break;
                        }
                        changed.await;
                    }
                    Ok(json!({"accepted":true}))
                })
            }),
        );
        owner.bind_epoch("native_viewer_fixture_epoch").unwrap();
        assert_eq!(
            owner.bind_epoch("foreign_epoch").unwrap_err().code,
            "STALE_EPOCH"
        );
        let mut app = tauri::Builder::default()
            .any_thread()
            .plugin(
                tauri_plugin_opener::Builder::new()
                    .open_js_links_on_click(false)
                    .build(),
            )
            .invoke_handler(tauri::generate_handler![
                super::super::engine_status,
                super::super::desktop_invoke
            ])
            .build(context)
            .unwrap();
        let ui = NativeUiOwner::default();
        app.manage(ProductionState {
            engine: None,
            failure: Some(error(FAILURE)),
            native_work: work.clone(),
            oauth: Default::default(),
            ui: ui.clone(),
            artifact_viewer: owner.clone(),
            drops: Default::default(),
            window: native_window::NativeWindowOwner::new(work.clone(), None),
            notifications: NativeNotificationOwner::new(app.handle(), work.clone()).unwrap(),
            tray: None,
            energy: None,
            notice_document: Mutex::new(None),
        });
        let ticket = ui.reserve_window().unwrap();
        let (navigation_ui, navigation_owner, navigation_app) =
            (ui.clone(), owner.clone(), app.handle().clone());
        let page_ui = ui.clone();
        let media_navigation = super::super::native_media::StartupNavigation::default();
        let main = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            super::super::native_media::initial_url(),
        )
        .on_navigation(move |url| {
            if media_navigation.allows_blank(url) {
                return true;
            }
            if !super::super::trusted_origin(url) {
                return false;
            }
            media_navigation.application();
            navigation_owner.stop_document(&navigation_app);
            navigation_ui.navigation(ticket).is_ok()
        })
        .on_page_load(move |window, payload| match payload.event() {
            tauri::webview::PageLoadEvent::Started => {
                let _ = native_window::prepare(&window);
                let _ = page_ui.page_started(ticket, &window);
            }
            tauri::webview::PageLoadEvent::Finished => {
                if super::super::trusted_origin(payload.url()) {
                    let _ = page_ui.page_finished(ticket, &window);
                }
            }
        })
        .build()
        .unwrap();
        native_window::prepare(&main).unwrap();
        owner.watch_parent(&main).unwrap();
        ui.watch_destroy(ticket, &main).unwrap();
        main.show().unwrap();
        super::super::native_media::load(main.clone(), work.clone()).unwrap();
        eprintln!("VIEWER_PROOF parent-document");
        pump(&mut app, || ui.completed_document_for_test(&main));
        ui.activate_synthetic_document(&main, "native_viewer_fixture_epoch");
        let action = Arc::new(ui.capture_window_action(&main).unwrap());
        let captured = ui.clone();
        let scope: Scope = Arc::new(move || captured.assert_window_action(&action));
        let id = "12345678-1234-4234-8234-123456789abc";
        let network = LoopbackProbe::new();
        let html=format!("<!doctype html><title>untrusted title</title><script>window.hostileRan=true;fetch('http://{0}/script')</script><link rel=stylesheet href='http://{0}/style'><img src='http://{0}/image'><iframe src='http://{0}/frame'></iframe><meta http-equiv=refresh content='0;url=http://{0}/navigation'><iframe src='file:///etc/passwd'></iframe><p>bounded immutable preview</p>",network.address);
        let payload =
            json!({"viewerId":id,"uiLeaseId":"document_native_viewer_fixture","html":html});
        assert_eq!(
            owner
                .register(app.handle(), &payload, scope.clone(), main.clone())
                .unwrap(),
            json!({"viewerId":id,"registered":true})
        );
        assert!(owner
            .register(app.handle(), &payload, scope.clone(), main.clone())
            .is_err());
        assert_eq!(
            owner
                .protocol("main", "GET", &policy::document_url(id))
                .status(),
            403
        );
        assert_eq!(
            owner
                .protocol(&policy::label(id), "POST", &policy::document_url(id))
                .status(),
            403
        );
        let (opening_owner, opening_app) = (owner.clone(), app.handle().clone());
        let opening =
            tauri::async_runtime::spawn(
                async move { opening_owner.open(opening_app, id.into()).await },
            );
        eprintln!("VIEWER_PROOF child-open");
        let inspect_started = Instant::now();
        let mut inspected = false;
        pump(&mut app, || {
            if !inspected && inspect_started.elapsed() > Duration::from_secs(8) {
                let entry = owner.entry(id).unwrap();
                let state = entry.state.lock().unwrap();
                eprintln!(
                    "VIEWER_PENDING served={} loaded={} window={} raw={} closing={}",
                    state.served,
                    state.loaded,
                    state.window.is_some(),
                    state.raw,
                    state.closing
                );
                inspected = true;
            }
            opening.inner().is_finished()
        });
        assert_eq!(
            tauri::async_runtime::block_on(opening).unwrap().unwrap(),
            json!({"viewerId":id,"opened":true})
        );
        let child = app.get_webview_window(&policy::label(id)).unwrap();
        assert_eq!(child.url().unwrap().as_str(), policy::document_url(id));
        assert_eq!(
            super::super::authorize(&child).unwrap_err().code,
            "UNAUTHORIZED"
        );
        let setting = Arc::new(Mutex::new(None));
        let result = setting.clone();
        child
            .with_webview(move |view| {
                *result.lock().unwrap() =
                    Some(view.inner().settings().unwrap().enables_javascript());
            })
            .unwrap();
        pump(&mut app, || setting.lock().unwrap().is_some());
        assert_eq!(*setting.lock().unwrap(), Some(false));
        // Even a native diagnostic evaluation cannot execute in this static
        // sandbox. Do not enable JS merely to inspect the hostile document.
        let (evaluated, evaluation) = std::sync::mpsc::channel();
        child
            .with_webview(move |view| {
                #[allow(deprecated)]
                view.inner().run_javascript(
                    "window.hostileRan=true",
                    None::<&webkit2gtk::gio::Cancellable>,
                    move |result| {
                        let _ =
                            evaluated.send(result.map(|_| ()).map_err(|error| error.to_string()));
                    },
                );
            })
            .unwrap();
        let mut execution = None;
        pump(&mut app, || {
            execution = evaluation.try_recv().ok();
            execution.is_some()
        });
        assert!(execution
            .unwrap()
            .unwrap_err()
            .contains("Cannot execute JavaScript in this document"));
        assert_eq!(child.title().unwrap(), "Artifact preview");
        assert_eq!(
            network.requests.load(Ordering::SeqCst),
            0,
            "actual CSP must refuse loopback image/frame/stylesheet/script/navigation effects"
        );
        assert_eq!(
            owner
                .protocol(&policy::label(id), "GET", &policy::document_url(id))
                .status(),
            403,
            "document delivery cannot replay"
        );
        let navigation_entry = owner.entry(id).unwrap();
        let rejected_before = navigation_entry.rejected_navigations.load(Ordering::SeqCst);
        child
            .navigate(tauri::Url::parse("https://example.invalid/").unwrap())
            .unwrap();
        // navigate() only queues a native load. Observe the actual policy
        // callback before inspecting committed state, not the provisional URI.
        pump(&mut app, || {
            navigation_entry.rejected_navigations.load(Ordering::SeqCst) > rejected_before
        });
        assert_eq!(child.url().unwrap().as_str(), policy::document_url(id));

        // A separately excluded executable probe exercises actual IPC and event
        // ACLs. The production static child above keeps JavaScript disabled.
        let probe_finished = Arc::new(AtomicBool::new(false));
        let finished = probe_finished.clone();
        let probe = tauri::WebviewWindowBuilder::new(
            &app,
            "artifact-hostile-probe",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .visible(false)
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                finished.store(true, Ordering::SeqCst);
            }
        })
        .build()
        .unwrap();
        eprintln!("VIEWER_PROOF executable-excluded-probe");
        pump(&mut app, || probe_finished.load(Ordering::SeqCst));
        let script = r#"window.__viewerProbe=null;(async()=>{const native=window.__TAURI_INTERNALS__;if(!native?.invoke||!native?.transformCallback){window.__viewerProbe={transport:false};return}const out={transport:true};for(const [key,call]of Object.entries({status:()=>native.invoke('engine_status'),desktop:()=>native.invoke('desktop_invoke',{engineEpoch:'fixture',operation:'db:getTasks',payload:{}}),listen:()=>native.invoke('plugin:event|listen',{event:'desktop:event',target:{kind:'Any'},handler:native.transformCallback(()=>{})}),emit:()=>native.invoke('plugin:event|emit',{event:'viewer-proof-only',payload:{synthetic:true}}),opener:()=>native.invoke('plugin:opener|reveal_item_in_dir',{paths:[]})})){try{await call();out[key]={accepted:true}}catch(error){out[key]={accepted:false,error}}}window.__viewerProbe=out})();'started'"#;
        js(&mut app, &probe, script);
        let denied = wait_js(&mut app, &probe, "JSON.stringify(window.__viewerProbe)");
        assert_eq!(denied["transport"], true);
        for key in ["status", "desktop", "listen", "emit", "opener"] {
            assert_eq!(denied[key]["accepted"], false, "{key}: {denied}");
            let error = &denied[key]["error"];
            assert!(
                error["code"] == "UNAUTHORIZED"
                    || error
                        .as_str()
                        .is_some_and(|error| error.contains("not allowed by ACL")
                            || error.contains("not allowed on window")
                            || error.contains("explicitly denied on origin")
                            || error.contains(
                                "not allowed. Permissions associated with this command:"
                            )),
                "expected actual authorization rejection for {key}: {denied}"
            );
        }
        js(&mut app,&main,"window.__viewerPositive=null;window.__TAURI_INTERNALS__.invoke('engine_status').then(value=>window.__viewerPositive=value);'started'");
        assert_eq!(
            wait_js(&mut app, &main, "JSON.stringify(window.__viewerPositive)")["available"],
            false
        );
        probe.destroy().unwrap();
        // Positive control: the same physical WebKit runtime can request this
        // controlled loopback resource when the separate test page has no CSP.
        let resource_probe = tauri::WebviewWindowBuilder::new(
            &app,
            "artifact-resource-probe",
            tauri::WebviewUrl::External(tauri::Url::parse("about:blank").unwrap()),
        )
        .visible(false)
        .incognito(true)
        .disable_javascript()
        .build()
        .unwrap();
        let positive_html = format!(
            "<!doctype html><img src='http://{}/positive'>",
            network.address
        );
        resource_probe
            .with_webview(move |view| view.inner().load_html(&positive_html, Some("about:blank")))
            .unwrap();
        pump(&mut app, || network.requests.load(Ordering::SeqCst) == 1);
        resource_probe.destroy().unwrap();

        hold_callback.store(true, Ordering::SeqCst);
        let (closing_owner, closing_app) = (owner.clone(), app.handle().clone());
        let closing = tauri::async_runtime::spawn(async move {
            closing_owner.retire(closing_app, id.into()).await
        });
        eprintln!("VIEWER_PROOF actual-destruction");
        pump(&mut app, || {
            owner.entry(id).unwrap().state.lock().unwrap().destroyed
        });
        assert!(app.get_webview_window(&policy::label(id)).is_none());
        pump(&mut app, || !callbacks.lock().unwrap().is_empty());
        assert!(
            !closing.inner().is_finished(),
            "actual destruction does not discard raw closed delivery"
        );
        hold_callback.store(false, Ordering::SeqCst);
        callback_gate.notify_waiters();
        pump(&mut app, || closing.inner().is_finished());
        assert_eq!(
            tauri::async_runtime::block_on(closing).unwrap().unwrap(),
            json!({"viewerId":id,"retired":true})
        );
        assert!(owner.entry(id).is_err());
        assert!(owner
            .register(app.handle(), &payload, scope.clone(), main.clone())
            .is_err());
        fn open_fixture(
            app: &mut tauri::App,
            owner: &NativeArtifactViewerOwner,
            main: &WebviewWindow,
            scope: Scope,
            id: &str,
        ) -> WebviewWindow {
            owner.register(app.handle(), &json!({"viewerId":id,"uiLeaseId":"document_native_viewer_fixture","html":"<!doctype html><p>controlled lifecycle</p>"}), scope, main.clone()).unwrap();
            let (owned, handle, identity) = (owner.clone(), app.handle().clone(), id.to_owned());
            let opening =
                tauri::async_runtime::spawn(async move { owned.open(handle, identity).await });
            pump(app, || opening.inner().is_finished());
            tauri::async_runtime::block_on(opening).unwrap().unwrap();
            app.get_webview_window(&policy::label(id)).unwrap()
        }
        let hidden_id = "12345679-1234-4234-8234-123456789abc";
        let hidden = open_fixture(&mut app, &owner, &main, scope.clone(), hidden_id);
        main.hide().unwrap();
        pump(&mut app, || owner.entry(hidden_id).is_err());
        assert!(app.get_webview_window(hidden.label()).is_none());
        assert!(callbacks
            .lock()
            .unwrap()
            .iter()
            .any(|value| value["viewerId"] == hidden_id && value["reason"] == "parent-retired"));
        main.show().unwrap();
        let reloaded_id = "1234567a-1234-4234-8234-123456789abc";
        let reloaded = open_fixture(&mut app, &owner, &main, scope.clone(), reloaded_id);
        js(&mut app, &main, "location.reload();'requested'");
        pump(&mut app, || {
            owner.entry(reloaded_id).is_err() && ui.completed_document_for_test(&main)
        });
        assert!(app.get_webview_window(reloaded.label()).is_none());
        assert!(
            scope().is_err(),
            "original physical document authority cannot survive reload"
        );
        let current_action = Arc::new(ui.capture_window_action(&main).unwrap());
        let current_ui = ui.clone();
        let current_scope: Scope =
            Arc::new(move || current_ui.assert_window_action(&current_action));
        let reserved: Vec<String> = (10..26)
            .map(|n| format!("{n:08x}-1234-4234-8234-123456789abc"))
            .collect();
        for id in &reserved {
            owner.register(app.handle(), &json!({"viewerId":id,"uiLeaseId":"document_native_viewer_fixture","html":"<p>reserved</p>"}), current_scope.clone(), main.clone()).unwrap();
        }
        let overflow = json!({"viewerId":"1234567b-1234-4234-8234-123456789abc","uiLeaseId":"document_native_viewer_fixture","html":"<p>overflow</p>"});
        assert_eq!(
            owner
                .register(app.handle(), &overflow, current_scope.clone(), main.clone())
                .unwrap_err()
                .code,
            "BACKPRESSURE"
        );
        for id in &reserved {
            tauri::async_runtime::block_on(owner.retire(app.handle().clone(), id.clone())).unwrap();
        }
        let retired_first = "1234567c-1234-4234-8234-123456789abc";
        tauri::async_runtime::block_on(owner.retire(app.handle().clone(), retired_first.into()))
            .unwrap();
        assert_eq!(owner.register(app.handle(), &json!({"viewerId":retired_first,"uiLeaseId":"document_native_viewer_fixture","html":"<p>late</p>"}),current_scope.clone(),main.clone()).unwrap_err().code,"STALE_EPOCH");
        let destroyed_id = "1234567d-1234-4234-8234-123456789abc";
        let last_child = open_fixture(&mut app, &owner, &main, current_scope.clone(), destroyed_id);
        let mut next = 1000;
        while owner.0.state.lock().unwrap().ids.len() < policy::EPOCH_IDS {
            tauri::async_runtime::block_on(owner.retire(
                app.handle().clone(),
                format!("{next:08x}-1234-4234-8234-123456789abc"),
            ))
            .unwrap();
            next += 1;
        }
        assert_eq!(
            owner
                .register(app.handle(), &overflow, current_scope, main.clone())
                .unwrap_err()
                .code,
            "BACKPRESSURE"
        );
        main.destroy().unwrap();
        pump(&mut app, || owner.entry(destroyed_id).is_err());
        assert!(app.get_webview_window(last_child.label()).is_none());
        assert!(callbacks
            .lock()
            .unwrap()
            .iter()
            .any(|value| value["viewerId"] == destroyed_id && value["reason"] == "parent-retired"));
        let handle = app.handle().clone();
        let closing_owner = owner.clone();
        let cleanup = tauri::async_runtime::spawn(async move { closing_owner.close(handle).await });
        pump(&mut app, || cleanup.inner().is_finished());
        tauri::async_runtime::block_on(cleanup).unwrap().unwrap();
        let destroyed_app = app.handle().clone();
        pump(&mut app, || {
            destroyed_app.get_webview_window("main").is_none()
        });
        assert_eq!(
            network.requests.load(Ordering::SeqCst),
            1,
            "only the separate positive-control resource request is allowed"
        );
        println!(
            "{}",
            json!({"passed":true,"boundary":"separate-native-static-webview","privateSourceRegistered":false,"publicViewerEnabled":false,"javascriptEnabled":false,"actualDestroyedAcknowledged":true,"rawClosedDeliveryJoined":true,"parentHideReloadDestroy":true,"nativeActiveBound":16,"nativeEpochIdBound":4096,"loopbackDeniedResourceRequests":0,"loopbackPositiveResourceRequests":network.requests.load(Ordering::SeqCst),"hostileExcludedProbe":denied,"closed":callbacks.lock().unwrap().clone(),"webkitCrate":"2.0.2"})
        );
    }
}
