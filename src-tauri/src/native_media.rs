//! No application JavaScript runs with an unowned media API. Permission-request
//! denial alone must not be treated as revocation of a cached WebView grant.
use super::native_services::NativeWorkOwner;
#[cfg(target_os = "linux")]
use tauri::Manager;
use tauri::WebviewWindow;
use twentyonex_engine::EngineError;

// Tauri deliberately skips its initial load for the exact `about:blank` string.
// A fixed fragment makes WebKit commit an identifiable inert document instead
// of treating an empty/uncommitted URI as native authority.
const START_URL: &str = "about:blank#21x-native-start";

#[derive(Clone, Default)]
pub struct StartupNavigation(std::sync::Arc<std::sync::atomic::AtomicBool>);
impl StartupNavigation {
    pub fn allows_blank(&self, url: &tauri::Url) -> bool {
        cfg!(target_os = "linux")
            && url.as_str() == START_URL
            && !self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
    pub fn application(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

pub fn initial_url() -> tauri::WebviewUrl {
    #[cfg(target_os = "linux")]
    {
        tauri::WebviewUrl::External(tauri::Url::parse(START_URL).expect("fixed blank URL"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        tauri::WebviewUrl::App("index.html".into())
    }
}

#[cfg(target_os = "linux")]
fn current_blank(window: &WebviewWindow, work: &NativeWorkOwner) -> Result<(), EngineError> {
    use raw_window_handle::HasWindowHandle;
    work.assert_open()?;
    let current = window
        .app_handle()
        .get_webview_window("main")
        .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
    if window.label() != "main"
        || window.url().ok().as_ref().map(tauri::Url::as_str) != Some(START_URL)
        || window
            .window_handle()
            .map_err(|_| EngineError::new("DISCONNECTED"))?
            .as_raw()
            != current
                .window_handle()
                .map_err(|_| EngineError::new("DISCONNECTED"))?
                .as_raw()
    {
        return Err(EngineError::new("STALE_EPOCH"));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn deny_before_script(view: &webkit2gtk::WebView) -> Result<(), EngineError> {
    use webkit2gtk::{MediaCaptureState, SettingsExt, WebViewExt};
    // A startup property is not an acknowledgement that an existing stream
    // stopped. Refuse to load the application if this supposedly blank view
    // already reports any capture. Native voice remains unsupported.
    if view.microphone_capture_state() != MediaCaptureState::None
        || view.camera_capture_state() != MediaCaptureState::None
        || view.display_capture_state() != MediaCaptureState::None
    {
        return Err(EngineError::new("INVALID_RESULT"));
    }
    let settings = view
        .settings()
        .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
    settings.set_enable_webrtc(false);
    settings.set_enable_media_stream(false);
    if settings.enables_webrtc() || settings.enables_media_stream() {
        return Err(EngineError::new("INVALID_RESULT"));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn unavailable(window: &WebviewWindow, work: &NativeWorkOwner) {
    if current_blank(window, work).is_ok() {
        // Fixed native wording only, on the original inert document. Never
        // navigate to app code or display raw platform/profile diagnostics.
        let _ = window.set_title("21x — Desktop permissions unavailable");
        let _ = window.eval("document.body.textContent='Desktop permissions could not be initialized. Close this preview and relaunch.';");
    }
}

/// The retained native-work driver owns both UI callbacks through shutdown.
/// No renderer URL, permission status or cached grant can open this boundary.
pub fn load(window: WebviewWindow, work: NativeWorkOwner) -> Result<(), EngineError> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window, work);
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        load_with_prepare(window, work, deny_before_script)
    }
}

#[cfg(target_os = "linux")]
fn load_with_prepare(
    window: WebviewWindow,
    work: NativeWorkOwner,
    prepare: impl FnOnce(&webkit2gtk::WebView) -> Result<(), EngineError> + Send + 'static,
) -> Result<(), EngineError> {
    if window.label() != "main" {
        return Err(EngineError::new("UNAUTHORIZED"));
    }
    let target = if tauri::is_dev() {
        window.app_handle().config().build.dev_url.clone()
    } else {
        None
    }
    .unwrap_or_else(|| tauri::Url::parse("tauri://localhost/index.html").expect("fixed app URL"));
    if !super::trusted_origin(&target) {
        return Err(EngineError::new("UNAUTHORIZED"));
    }
    let guard = work.clone();
    tauri::async_runtime::spawn(async move {
        let failed_window = window.clone();
        let failed_work = work.clone();
        let result = work
            .run(move || {
                current_blank(&window, &guard)?;
                let (send, receive) = std::sync::mpsc::channel();
                let ready = window.clone();
                window
                    .with_webview(move |platform| {
                        if let Err(error) = prepare(&platform.inner()) {
                            let _ = send.send(Err(error));
                            return;
                        }
                        // with_webview can hold the runtime's borrow. A later idle
                        // callback must perform Tauri identity/navigation calls.
                        gtk::glib::idle_add_local_once(move || {
                            let result = current_blank(&ready, &guard).and_then(|()| {
                                ready
                                    .navigate(target)
                                    .map_err(|_| EngineError::new("DISCONNECTED"))
                            });
                            let _ = send.send(result);
                        });
                    })
                    .map_err(|_| EngineError::new("DISCONNECTED"))?;
                receive
                    .recv()
                    .map_err(|_| EngineError::new("DISCONNECTED"))?
            })
            .await;
        if let Err(error) = result {
            eprintln!("PRODUCTION_MEDIA_ADMISSION_UNAVAILABLE:{}", error.code);
            unavailable(&failed_window, &failed_work);
        }
    });
    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
mod proof {
    use super::super::native_window::wry_proof::{js, pump};
    use super::*;
    use std::{
        borrow::Cow,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc,
        },
    };
    use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
    use webkit2gtk::{MediaCaptureState, SettingsExt, WebViewExt};
    const HTML: &[u8] = b"<!doctype html><html><head><meta charset='utf-8'><script src='/media-proof.js'></script></head><body>Controlled media admission</body></html>";
    const SCRIPT: &[u8] = b"window.nativeMediaBoot={gum:!!navigator.mediaDevices?.getUserMedia,rtc:typeof RTCPeerConnection!=='undefined'};";
    struct Assets;
    impl tauri::Assets<tauri::Wry> for Assets {
        fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
            Some(Cow::Borrowed(if key.as_ref().ends_with(".js") {
                SCRIPT
            } else {
                HTML
            }))
        }
        fn iter(&self) -> Box<AssetsIter<'_>> {
            Box::new(
                [("index.html", HTML), ("media-proof.js", SCRIPT)]
                    .into_iter()
                    .map(|(key, bytes)| (Cow::Borrowed(key), Cow::Borrowed(bytes))),
            )
        }
        fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
            Box::new(std::iter::empty())
        }
    }
    fn webkit(
        app: &mut tauri::App,
        window: &WebviewWindow,
        effect: impl FnOnce(&webkit2gtk::WebView) + Send + 'static,
    ) {
        let (send, receive) = std::sync::mpsc::channel();
        window
            .with_webview(move |platform| {
                effect(&platform.inner());
                let _ = send.send(());
            })
            .unwrap();
        pump(app, || receive.try_recv().is_ok());
    }
    fn until_js(app: &mut tauri::App, window: &WebviewWindow, script: &str, wanted: &str) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let actual = js(app, window, script);
            if actual == wanted {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "mock capture receipt: expected {wanted}, actual {actual}"
            );
            pump(app, || true);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    fn fresh_main(app: &tauri::App, app_navigations: Arc<AtomicUsize>) -> WebviewWindow {
        let window = tauri::WebviewWindowBuilder::new(app, "main", initial_url())
            .visible(false)
            .on_navigation(move |url| {
                if super::super::trusted_origin(url) {
                    app_navigations.fetch_add(1, Ordering::SeqCst);
                    true
                } else {
                    url.as_str() == START_URL
                }
            })
            .build()
            .unwrap();
        super::super::native_window::prepare(&window).unwrap();
        window.show().unwrap();
        window
    }
    #[test]
    fn linux_starts_with_an_inert_blank_before_any_application_resource() {
        assert!(
            matches!(initial_url(),tauri::WebviewUrl::External(url) if url.as_str()==START_URL)
        );
        let navigation = StartupNavigation::default();
        let blank = tauri::Url::parse(START_URL).unwrap();
        assert!(navigation.allows_blank(&blank));
        assert!(!navigation.allows_blank(&tauri::Url::parse("about:blank").unwrap()));
        assert!(!navigation.allows_blank(&tauri::Url::parse("about:blank#alias").unwrap()));
        assert!(!super::super::trusted_origin(&blank));
        navigation.application();
        assert!(!navigation.allows_blank(&blank));
    }
    #[test]
    #[ignore = "requires isolated Xvfb/Wry and WebKit mock capture devices; never uses real microphone"]
    fn real_wry_mock_capture_then_native_denial_before_first_app_script() {
        let mut context = tauri::test::mock_context::<tauri::Wry, _>(Assets);
        context.config_mut().identifier = "invalid.synthetic.media-proof".into();
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.production.conf.json")).unwrap();
        let csp = tauri::utils::config::Csp::Policy(
            config["app"]["security"]["csp"].as_str().unwrap().into(),
        );
        context.config_mut().app.security.csp = Some(csp.clone());
        context.config_mut().app.security.dev_csp = Some(csp);
        let mut app = tauri::Builder::default()
            .any_thread()
            .build(context)
            .unwrap();
        pump(&mut app, || true);
        // Positive control is deliberately permissive, with fake devices only.
        // Main production code never enables mock devices or grants permission.
        let grants = Arc::new(AtomicUsize::new(0));
        let granted = grants.clone();
        let ready = Arc::new(AtomicBool::new(false));
        let loaded = ready.clone();
        let control = tauri::WebviewWindowBuilder::new(&app, "media-control", initial_url())
            .visible(false)
            .on_permission_request(move |_, _| {
                granted.fetch_add(1, Ordering::SeqCst);
                tauri::webview::PermissionResponse::Allow
            })
            .on_page_load(move |_, event| {
                if matches!(event.event(), tauri::webview::PageLoadEvent::Finished)
                    && super::super::trusted_origin(event.url())
                {
                    loaded.store(true, Ordering::SeqCst);
                }
            })
            .build()
            .unwrap();
        webkit(&mut app, &control, |view| {
            let settings = view.settings().unwrap();
            settings.set_enable_mock_capture_devices(true);
            settings.set_enable_media_stream(true);
            assert!(settings.enables_mock_capture_devices());
        });
        control
            .navigate(tauri::Url::parse("tauri://localhost/index.html").unwrap())
            .unwrap();
        pump(&mut app, || ready.load(Ordering::SeqCst));
        control.show().unwrap();
        control.set_focus().unwrap();
        until_js(&mut app, &control, "document.visibilityState", "visible");
        assert_eq!(
            js(
                &mut app,
                &control,
                "String(!!navigator.mediaDevices?.getUserMedia)"
            ),
            "true"
        );
        js(&mut app,&control,"window.captureResult='pending';window.cachedGum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);cachedGum({audio:true}).then(s=>{window.mockStream=s;captureResult='active'}).catch(e=>captureResult=e.name);'requested'");
        until_js(&mut app, &control, "captureResult", "active");
        assert!(grants.load(Ordering::SeqCst) > 0);
        webkit(&mut app, &control, |view| {
            assert_eq!(view.microphone_capture_state(), MediaCaptureState::Active);
            assert!(deny_before_script(view).is_err());
            view.set_microphone_capture_state(MediaCaptureState::None);
        });
        until_js(
            &mut app,
            &control,
            "String(mockStream.getTracks().every(t=>t.readyState==='ended'))",
            "true",
        );
        // A previously active/scripted document cannot masquerade as startup.
        assert!(current_blank(&control, &NativeWorkOwner::default()).is_err());
        assert_eq!(
            load(control.clone(), NativeWorkOwner::default())
                .unwrap_err()
                .code,
            "UNAUTHORIZED"
        );
        let ready = Arc::new(AtomicBool::new(false));
        let loaded = ready.clone();
        let main_grants = Arc::new(AtomicUsize::new(0));
        let allowed = main_grants.clone();
        let ui = super::super::production_ui::NativeUiOwner::default();
        let ticket = ui.reserve_window().unwrap();
        let navigation_ui = ui.clone();
        let page_ui = ui.clone();
        let navigation = StartupNavigation::default();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", initial_url())
            .visible(false)
            .on_permission_request(move |_, _| {
                allowed.fetch_add(1, Ordering::SeqCst);
                tauri::webview::PermissionResponse::Allow
            })
            .on_navigation(move |url| {
                if navigation.allows_blank(url) {
                    return true;
                }
                if !super::super::trusted_origin(url) {
                    return false;
                }
                navigation.application();
                navigation_ui.navigation(ticket).is_ok()
            })
            .on_page_load(move |window, event| match event.event() {
                tauri::webview::PageLoadEvent::Started => {
                    let _ = super::super::native_window::prepare(&window);
                    let _ = page_ui.page_started(ticket, &window);
                }
                tauri::webview::PageLoadEvent::Finished => {
                    if super::super::trusted_origin(event.url()) {
                        page_ui.page_finished(ticket, &window).unwrap();
                        loaded.store(true, Ordering::SeqCst);
                    }
                }
            })
            .build()
            .unwrap();
        super::super::native_window::prepare(&window).unwrap();
        ui.watch_destroy(ticket, &window).unwrap();
        window.show().unwrap();
        assert_eq!(
            window.url().unwrap().as_str(),
            START_URL,
            "initial native URL"
        );
        let work = NativeWorkOwner::default();
        load(window.clone(), work.clone()).unwrap();
        pump(&mut app, || ready.load(Ordering::SeqCst));
        assert_eq!(
            js(&mut app, &window, "JSON.stringify(nativeMediaBoot)"),
            "{\"gum\":false,\"rtc\":false}"
        );
        assert_eq!(main_grants.load(Ordering::SeqCst), 0);
        assert!(ui.completed_document_for_test(&window));
        webkit(&mut app, &window, |view| {
            let settings = view.settings().unwrap();
            assert!(!settings.enables_media_stream());
            assert!(!settings.enables_webrtc());
            assert_eq!(view.microphone_capture_state(), MediaCaptureState::None);
        });
        pump(&mut app, || work.active().unwrap() == 0);
        assert_eq!(work.active().unwrap(), 0);
        window.close().unwrap();
        let handle = app.handle().clone();
        pump(&mut app, || handle.get_webview_window("main").is_none());

        // A native preparation failure shows only fixed native wording and
        // never navigates to an application page or mints document authority.
        let navigations = Arc::new(AtomicUsize::new(0));
        let refused = fresh_main(&app, navigations.clone());
        let work = NativeWorkOwner::default();
        load_with_prepare(refused.clone(), work.clone(), |_| {
            Err(EngineError::new("INVALID_RESULT"))
        })
        .unwrap();
        until_js(
            &mut app,
            &refused,
            "document.body.textContent",
            "Desktop permissions could not be initialized. Close this preview and relaunch.",
        );
        pump(&mut app, || work.active().unwrap() == 0);
        assert_eq!(refused.url().unwrap().as_str(), START_URL);
        assert_eq!(navigations.load(Ordering::SeqCst), 0);
        assert_eq!(
            js(&mut app, &refused, "typeof nativeMediaBoot"),
            "undefined"
        );
        assert!(!ui.completed_document_for_test(&refused));
        refused.close().unwrap();
        pump(&mut app, || handle.get_webview_window("main").is_none());

        // Closing native admission after settings acknowledgement but before
        // the later navigation callback fences the accepted raw work. The
        // driver still joins that callback; no replacement app load is sent.
        let navigations = Arc::new(AtomicUsize::new(0));
        let closing = fresh_main(&app, navigations.clone());
        let work = NativeWorkOwner::default();
        let close = work.clone();
        let prepared = Arc::new(AtomicBool::new(false));
        let captured = prepared.clone();
        load_with_prepare(closing.clone(), work.clone(), move |view| {
            deny_before_script(view)?;
            close.close()?;
            captured.store(true, Ordering::SeqCst);
            Ok(())
        })
        .unwrap();
        pump(&mut app, || {
            prepared.load(Ordering::SeqCst) && work.active().unwrap() == 0
        });
        assert_eq!(closing.url().unwrap().as_str(), START_URL);
        assert_eq!(navigations.load(Ordering::SeqCst), 0);
        assert_eq!(
            js(&mut app, &closing, "typeof nativeMediaBoot"),
            "undefined"
        );
        closing.close().unwrap();
        control.close().unwrap();
        pump(&mut app, || true);
    }
}
