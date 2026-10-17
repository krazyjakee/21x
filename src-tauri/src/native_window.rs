//! App-owned physical-window state, local menus and chrome. No renderer route
//! chooses a window, callback, persistence path or editing command.
use super::{native_services::NativeWorkOwner, production_ui::NativeUiOwner};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::{Manager, WebviewWindow};
use twentyonex_engine::{
    production::{HostFuture, ProductionEngine},
    production_window::{self as policy, Action, MonitorArea, WindowState, Zoom},
    EngineError,
};

type Save = Arc<dyn Fn(WindowState) -> HostFuture<()> + Send + Sync>;
#[derive(Default)]
struct SaveState {
    stopped: bool,
    latest: Option<WindowState>,
    revision: u64,
    accepted: u64,
    writing: bool,
    failed: bool,
}
struct Inner {
    state: Mutex<SaveState>,
    settled: tokio::sync::Notify,
    work: NativeWorkOwner,
    save: Save,
    zoom: Mutex<Zoom>,
}
#[derive(Clone)]
pub struct NativeWindowOwner(Arc<Inner>);
impl NativeWindowOwner {
    pub fn new(work: NativeWorkOwner, engine: Option<ProductionEngine>) -> Self {
        let save: Save = Arc::new(move |state| {
            let engine = engine.clone();
            Box::pin(async move {
                let engine = engine.ok_or_else(|| EngineError::new("DISCONNECTED"))?;
                engine.save_window_state(&engine.epoch(), state).await
            })
        });
        Self::with_sink(work, save)
    }
    fn with_sink(work: NativeWorkOwner, save: Save) -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(SaveState::default()),
            settled: tokio::sync::Notify::new(),
            work,
            save,
            zoom: Mutex::new(Zoom::default()),
        }))
    }
    pub fn observe(&self, value: WindowState) -> Result<(), EngineError> {
        if WindowState::parse(&value.value()).is_none() {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        let start = {
            let mut state = self
                .0
                .state
                .lock()
                .map_err(|_| EngineError::new("DISCONNECTED"))?;
            if state.stopped {
                return Err(EngineError::new("DISCONNECTED"));
            }
            if state.latest == Some(value) && !state.failed {
                return Ok(());
            }
            state.revision = state
                .revision
                .checked_add(1)
                .ok_or_else(|| EngineError::new("BACKPRESSURE"))?;
            state.latest = Some(value);
            state.failed = false;
            if state.writing {
                false
            } else {
                state.writing = true;
                true
            }
        };
        if start {
            self.drive();
        }
        Ok(())
    }
    fn drive(&self) {
        let owner = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::select! { _ = tokio::time::sleep(std::time::Duration::from_millis(150)) => {}, _ = owner.0.settled.notified() => {} }
            loop {
                let next = {
                    let mut state = match owner.0.state.lock() {
                        Ok(value) => value,
                        Err(_) => {
                            owner.0.settled.notify_waiters();
                            return;
                        }
                    };
                    if state.accepted == state.revision {
                        state.writing = false;
                        None
                    } else {
                        state.latest.map(|value| (state.revision, value))
                    }
                };
                let Some((revision, value)) = next else {
                    owner.0.settled.notify_waiters();
                    return;
                };
                let save = owner.0.save.clone();
                // This is cleanup of a captured native observation, allowed to
                // flush after normal native admission closes. observe() itself
                // is synchronously fenced by stop(). No new UI intent is read.
                let result = owner
                    .0
                    .work
                    .run_cleanup(move || tauri::async_runtime::block_on(save(value)))
                    .await;
                let mut state = match owner.0.state.lock() {
                    Ok(value) => value,
                    Err(_) => {
                        owner.0.settled.notify_waiters();
                        return;
                    }
                };
                if result.is_err() {
                    state.failed = true;
                    state.writing = false;
                    owner.0.settled.notify_waiters();
                    return;
                }
                state.accepted = revision;
                drop(state);
            }
        });
    }
    pub fn stop(&self) -> Result<(), EngineError> {
        self.0
            .state
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?
            .stopped = true;
        self.0.settled.notify_waiters();
        Ok(())
    }
    /// Joins raw writes even after public waiter loss. false explicitly means
    /// the last observation was not saved; it never invents persistence success.
    /// A completed preference failure does not prevent owned service shutdown.
    pub async fn close(&self) -> Result<bool, EngineError> {
        self.stop()?;
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let notified = self.0.settled.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let result = {
                    let state = self
                        .0
                        .state
                        .lock()
                        .map_err(|_| EngineError::new("DISCONNECTED"))?;
                    (!state.writing).then_some(!state.failed && state.accepted == state.revision)
                };
                if let Some(saved) = result {
                    return Ok(saved);
                }
                notified.await;
            }
        })
        .await
        .map_err(|_| EngineError::new("TIMEOUT"))?
    }
    pub fn attach(
        &self,
        window: &WebviewWindow,
        ui: NativeUiOwner,
        initial: WindowState,
    ) -> Result<(), EngineError> {
        let normal = Arc::new(Mutex::new(initial));
        let (owner, captured, captured_ui) = (self.clone(), window.clone(), ui.clone());
        window.on_window_event(move |event| {
            if !matches!(
                event,
                tauri::WindowEvent::Moved(_)
                    | tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. }
            ) {
                return;
            }
            if captured_ui.assert_window(&captured).is_err() || owner.0.work.assert_open().is_err()
            {
                return;
            }
            let observation = (|| {
                if !captured.is_visible().map_err(|_| ())?
                    || captured.is_minimized().map_err(|_| ())?
                {
                    return Err(());
                }
                let (maximized, fullscreen) = (
                    captured.is_maximized().map_err(|_| ())?,
                    captured.is_fullscreen().map_err(|_| ())?,
                );
                let mut state = normal.lock().map_err(|_| ())?;
                if !maximized && !fullscreen {
                    let position = captured.outer_position().map_err(|_| ())?;
                    let size = captured.inner_size().map_err(|_| ())?;
                    state.x = position.x;
                    state.y = position.y;
                    state.width = size.width;
                    state.height = size.height;
                    state.scale = captured.scale_factor().map_err(|_| ())?;
                }
                state.maximized = maximized;
                state.fullscreen = fullscreen;
                Ok(*state)
            })();
            if let Ok(value) = observation {
                let _ = owner.observe(value);
            }
        });
        // First load resets zoom once per launch. Subsequent navigations retain
        // the owned in-session zoom, matching the retained desktop behavior.
        let owner = self.clone();
        let (captured, captured_ui) = (window.clone(), ui.clone());
        window.on_menu_event(move |_, event| {
            if let Some(action) = Action::menu(event.id().as_ref()) {
                owner.action(captured.clone(), captured_ui.clone(), action);
            }
        });
        install_menu(window)?;
        #[cfg(target_os = "linux")]
        install_linux_keyboard(window, self.clone(), ui)?;
        Ok(())
    }
    fn assert_active(&self) -> Result<(), EngineError> {
        self.0.work.assert_open()?;
        if self
            .0
            .state
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?
            .stopped
        {
            return Err(EngineError::new("DISCONNECTED"));
        }
        Ok(())
    }
    fn action(&self, window: WebviewWindow, ui: NativeUiOwner, action: Action) {
        // App-owned Quit must still reach the existing shutdown coordinator
        // after a failed drain. It requests exit; it never bypasses the root
        // coordinator or reopens ordinary UI/native admission.
        if action == Action::Quit {
            window.app_handle().exit(0);
            return;
        }
        if self.assert_active().is_err() {
            return;
        }
        let owner = self.clone();
        tauri::async_runtime::spawn(async move {
            let app = window.app_handle().clone();
            let work = owner.0.work.clone();
            let _ = work
                .run(move || {
                    let (send, done) = std::sync::mpsc::channel::<
                        Result<
                            Option<std::sync::mpsc::Receiver<Result<(), EngineError>>>,
                            EngineError,
                        >,
                    >();
                    app.run_on_main_thread(move || {
                        let result = (|| {
                            owner.assert_active()?;
                            ui.assert_window(&window)?;
                            if action != Action::Open
                                && action != Action::Quit
                                && !window
                                    .is_focused()
                                    .map_err(|_| EngineError::new("DISCONNECTED"))?
                            {
                                return Err(EngineError::new("INVALID_REQUEST"));
                            }
                            if let Some(factor) = owner
                                .0
                                .zoom
                                .lock()
                                .map_err(|_| EngineError::new("DISCONNECTED"))?
                                .apply(action)
                            {
                                return window
                                    .set_zoom(factor)
                                    .map(|_| None)
                                    .map_err(|_| EngineError::new("INTERNAL_ERROR"));
                            }
                            match action {
                                Action::Open => {
                                    window
                                        .show()
                                        .and_then(|_| window.unminimize())
                                        .and_then(|_| window.set_focus())
                                        .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
                                }
                                Action::Quit => window.app_handle().exit(0),
                                Action::Close => window
                                    .close()
                                    .map_err(|_| EngineError::new("INTERNAL_ERROR"))?,
                                Action::Minimize => window
                                    .minimize()
                                    .map_err(|_| EngineError::new("INTERNAL_ERROR"))?,
                                Action::Maximize => window
                                    .is_maximized()
                                    .and_then(|max| {
                                        if max {
                                            window.unmaximize()
                                        } else {
                                            window.maximize()
                                        }
                                    })
                                    .map_err(|_| EngineError::new("INTERNAL_ERROR"))?,
                                Action::Fullscreen => window
                                    .is_fullscreen()
                                    .and_then(|full| window.set_fullscreen(!full))
                                    .map_err(|_| EngineError::new("INTERNAL_ERROR"))?,
                                Action::Reload => {
                                    ui.navigation_current(&window)?;
                                    window
                                        .reload()
                                        .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
                                }
                                _ => {
                                    if let Some(command) = action.editing_command() {
                                        #[cfg(target_os = "linux")]
                                        {
                                            let (reply, actual) = std::sync::mpsc::channel();
                                            let captured = ui.capture_window_action(&window)?;
                                            let checked_ui = ui.clone();
                                            let checked_owner = owner.clone();
                                            window
                                                .with_webview(move |webview| {
                                                    use webkit2gtk::WebViewExt;
                                                    let result = (|| {
                                                        checked_owner.assert_active()?;
                                                        checked_ui
                                                            .assert_window_action(&captured)?;
                                                        webview
                                                            .inner()
                                                            .execute_editing_command(command);
                                                        Ok(())
                                                    })(
                                                    );
                                                    let _ = reply.send(result);
                                                })
                                                .map_err(|_| EngineError::new("DISCONNECTED"))?;
                                            // with_webview on the main thread may enqueue its callback.
                                            // Never block the GTK loop waiting here; transfer the actual
                                            // receipt to the retained blocking worker below instead.
                                            return Ok(Some(actual));
                                        }
                                        #[cfg(not(target_os = "linux"))]
                                        {
                                            let _ = command;
                                            return Err(EngineError::new("UNKNOWN_OPERATION"));
                                        }
                                    }
                                }
                            }
                            Ok(None)
                        })();
                        let _ = send.send(result);
                    })
                    .map_err(|_| EngineError::new("DISCONNECTED"))?;
                    let result = done
                        .recv()
                        .map_err(|_| EngineError::new("DISCONNECTED"))??;
                    if let Some(actual) = result {
                        actual
                            .recv()
                            .map_err(|_| EngineError::new("DISCONNECTED"))??;
                    }
                    Ok(())
                })
                .await;
        });
    }
}

/// Construct CSD before GTK realization, then obtain a physical handle while
/// still hidden. Never unrealize/recreate an already-authorized native window.
pub fn prepare(window: &WebviewWindow) -> Result<(), EngineError> {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let gtk = window
            .gtk_window()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        if !gtk.is_realized() && gtk.titlebar().is_none() {
            let header = gtk::HeaderBar::new();
            header.set_show_close_button(true);
            header.set_title(gtk.title().as_deref());
            header.set_widget_name("native-main-header");
            gtk.set_titlebar(Some(&header));
            header.show_all();
        }
        gtk.realize();
    }
    #[cfg(not(target_os = "linux"))]
    let _ = window;
    Ok(())
}
#[cfg(target_os = "linux")]
thread_local! {
    // Exactly one captured main-window style; replacement removes the old
    // provider, and a weak widget reference cannot keep a destroyed window alive.
    static HEADER_STYLE: std::cell::RefCell<Option<(Vec<gtk::glib::WeakRef<gtk::Widget>>, gtk::CssProvider)>> = const { std::cell::RefCell::new(None) };
}
#[cfg(target_os = "linux")]
fn style_header(header: &gtk::HeaderBar, css: &[u8]) -> Result<(), EngineError> {
    use gtk::prelude::*;
    let provider = gtk::CssProvider::new();
    provider
        .load_from_data(css)
        .map_err(|_| EngineError::new("INVALID_ARGUMENTS"))?;
    fn collect(widget: &gtk::Widget, widgets: &mut Vec<gtk::Widget>) -> Result<(), EngineError> {
        if widgets.len() >= 64 {
            return Err(EngineError::new("BACKPRESSURE"));
        }
        widgets.push(widget.clone());
        if let Some(container) = widget.downcast_ref::<gtk::Container>() {
            let mut result = Ok(());
            container.forall(|child| {
                if result.is_ok() {
                    result = collect(child, widgets);
                }
            });
            result?;
        }
        Ok(())
    }
    let mut widgets = Vec::new();
    collect(header.upcast_ref(), &mut widgets)?;
    HEADER_STYLE.with(|slot| {
        if let Some((old, provider)) = slot.borrow_mut().take() {
            for old in old {
                if let Some(old) = old.upgrade() {
                    old.style_context().remove_provider(&provider);
                }
            }
        }
        for widget in &widgets {
            widget
                .style_context()
                .add_provider(&provider, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
        }
        *slot.borrow_mut() = Some((
            widgets.iter().map(|widget| widget.downgrade()).collect(),
            provider,
        ));
    });
    Ok(())
}
pub fn monitors(window: &WebviewWindow) -> Vec<MonitorArea> {
    let mut monitors = Vec::new();
    if let Ok(Some(primary)) = window.primary_monitor() {
        monitors.push(primary);
    }
    if let Ok(others) = window.available_monitors() {
        for monitor in others.into_iter().take(32) {
            if !monitors
                .iter()
                .any(|m| m.position() == monitor.position() && m.size() == monitor.size())
            {
                monitors.push(monitor);
            }
        }
    }
    monitors
        .into_iter()
        .map(|m| {
            let area = m.work_area();
            MonitorArea {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width,
                height: area.size.height,
                scale: m.scale_factor(),
            }
        })
        .collect()
}
pub fn apply_restore(
    window: &WebviewWindow,
    saved: Option<WindowState>,
) -> Result<WindowState, EngineError> {
    let restored = policy::restore(saved, &monitors(window));
    window
        .set_size(tauri::PhysicalSize::new(restored.width, restored.height))
        .and_then(|_| window.set_position(tauri::PhysicalPosition::new(restored.x, restored.y)))
        .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
    if restored.maximized {
        window
            .maximize()
            .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
    }
    if restored.fullscreen {
        window
            .set_fullscreen(true)
            .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
    }
    window
        .set_zoom(1.)
        .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
    Ok(restored)
}
fn install_menu(window: &WebviewWindow) -> Result<(), EngineError> {
    use tauri::menu::{Menu, MenuItem, Submenu};
    let make = |id, label, accelerator: Option<&str>| {
        MenuItem::with_id(window, id, label, true, accelerator)
            .map_err(|_| EngineError::new("INTERNAL_ERROR"))
    };
    // Editing accelerators remain with the focused WebView/terminal. Explicit
    // native menu clicks use only the fixed editing-command table above.
    let edit = [
        make("native.edit.undo", "Undo", None)?,
        make("native.edit.redo", "Redo", None)?,
        make("native.edit.cut", "Cut", None)?,
        make("native.edit.copy", "Copy", None)?,
        make("native.edit.paste", "Paste", None)?,
        make("native.edit.select-all", "Select all", None)?,
    ];
    for item in &edit {
        item.set_enabled(cfg!(target_os = "linux"))
            .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
    }
    let view = [
        make("native.view.reload", "Reload", Some("CmdOrCtrl+R"))?,
        make("native.view.zoom-in", "Zoom in", Some("CmdOrCtrl+="))?,
        make("native.view.zoom-out", "Zoom out", Some("CmdOrCtrl+-"))?,
        make("native.view.zoom-reset", "Actual size", Some("CmdOrCtrl+0"))?,
        make("native.view.fullscreen", "Full screen", Some("F11"))?,
    ];
    let controls = [
        make("native.window.open", "Show window", None)?,
        make("native.window.minimize", "Minimize", None)?,
        make("native.window.maximize", "Maximize / restore", None)?,
        make("native.window.close", "Close window", Some("CmdOrCtrl+W"))?,
        make("native.app.quit", "Quit", Some("CmdOrCtrl+Q"))?,
    ];
    let submenu = |label, items: &[MenuItem<tauri::Wry>]| {
        Submenu::with_items(
            window,
            label,
            true,
            &items
                .iter()
                .map(|item| item as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
                .collect::<Vec<_>>(),
        )
        .map_err(|_| EngineError::new("INTERNAL_ERROR"))
    };
    let (edit, view, controls) = (
        submenu("Edit", &edit)?,
        submenu("View", &view)?,
        submenu("Window", &controls)?,
    );
    let menu = Menu::with_items(window, &[&edit, &view, &controls])
        .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
    window
        .set_menu(menu)
        .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
    Ok(())
}
#[cfg(target_os = "linux")]
fn install_linux_keyboard(
    window: &WebviewWindow,
    owner: NativeWindowOwner,
    ui: NativeUiOwner,
) -> Result<(), EngineError> {
    use gtk::prelude::*;
    let gtk = window
        .gtk_window()
        .map_err(|_| EngineError::new("DISCONNECTED"))?;
    let window = window.clone();
    gtk.connect_key_press_event(move |_, key| {
        let modifiers = key.state();
        if modifiers.intersects(
            gtk::gdk::ModifierType::MOD1_MASK
                | gtk::gdk::ModifierType::META_MASK
                | gtk::gdk::ModifierType::SUPER_MASK,
        ) {
            return gtk::glib::Propagation::Proceed;
        }
        // GTK menu accelerators own ordinary Ctrl+=/-/0. The shifted '+'
        // variant needs an exact fallback; it grants no global shortcut.
        if modifiers.contains(gtk::gdk::ModifierType::CONTROL_MASK)
            && key.keyval() == gtk::gdk::keys::constants::plus
            && ui.assert_window(&window).is_ok()
        {
            owner.action(window.clone(), ui.clone(), Action::ZoomIn);
            return gtk::glib::Propagation::Stop;
        }
        gtk::glib::Propagation::Proceed
    });
    Ok(())
}

pub fn overlay(
    window: WebviewWindow,
    work: NativeWorkOwner,
    ui: NativeUiOwner,
    epoch: String,
    lease: String,
    payload: Value,
) -> HostFuture<Value> {
    Box::pin(async move {
        if !policy::overlay(&payload) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        work.assert_open()?;
        ui.assert_publish(&window, &epoch, &lease)?;
        #[cfg(not(target_os = "linux"))]
        {
            Err(EngineError::new("UNKNOWN_OPERATION"))
        }
        #[cfg(target_os = "linux")]
        {
            let (app, guard_work) = (window.app_handle().clone(), work.clone());
            work.run(move || {
                let (send, response) = std::sync::mpsc::channel();
                app.run_on_main_thread(move || {
                    let result = (|| {
                        use gtk::prelude::*;
                        guard_work.assert_open()?; ui.assert_publish(&window, &epoch, &lease)?;
                        let gtk = window.gtk_window().map_err(|_| EngineError::new("DISCONNECTED"))?;
                        let header = gtk.titlebar().and_then(|v| v.downcast::<gtk::HeaderBar>().ok()).ok_or_else(|| EngineError::new("UNKNOWN_OPERATION"))?;
                        header.set_widget_name("native-main-header");
                        let css = format!("#native-main-header {{ background-image:none; background-color:{}; color:{}; }} #native-main-header button, #native-main-header image {{ color:{}; }}", payload["colors"]["color"].as_str().unwrap(), payload["colors"]["symbolColor"].as_str().unwrap(), payload["colors"]["symbolColor"].as_str().unwrap());
                        style_header(&header, css.as_bytes())?;
                        Ok(serde_json::json!({"defined":false}))
                    })();
                    let _ = send.send(result);
                }).map_err(|_| EngineError::new("DISCONNECTED"))?;
                response.recv().map_err(|_| EngineError::new("DISCONNECTED"))?
            }).await
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state(x: i32) -> WindowState {
        WindowState {
            x,
            y: 0,
            width: 1400,
            height: 900,
            scale: 1.,
            maximized: false,
            fullscreen: false,
        }
    }
    #[tokio::test]
    async fn coalesces_observations_and_flushes_latest_during_native_close() {
        let values = Arc::new(Mutex::new(Vec::new()));
        let writes = values.clone();
        let work = NativeWorkOwner::default();
        let owner = NativeWindowOwner::with_sink(
            work.clone(),
            Arc::new(move |value| {
                writes.lock().unwrap().push(value);
                Box::pin(async { Ok(()) })
            }),
        );
        for x in 0..100 {
            owner.observe(state(x)).unwrap();
        }
        owner.stop().unwrap();
        work.close().unwrap();
        assert!(owner.close().await.unwrap());
        assert_eq!(values.lock().unwrap().as_slice(), &[state(99)]);
        assert_eq!(work.active().unwrap(), 0);
        assert!(owner.observe(state(100)).is_err());
    }
    #[tokio::test]
    async fn cancelled_close_waiter_does_not_release_raw_profile_write_and_late_state_wins() {
        let started = Arc::new(tokio::sync::Notify::new());
        let held = Arc::new(tokio::sync::Notify::new());
        let (entered, gate) = (started.clone(), held.clone());
        let values = Arc::new(Mutex::new(Vec::new()));
        let writes = values.clone();
        let work = NativeWorkOwner::default();
        let owner = NativeWindowOwner::with_sink(
            work.clone(),
            Arc::new(move |value| {
                let (entered, gate, writes) = (entered.clone(), gate.clone(), writes.clone());
                Box::pin(async move {
                    writes.lock().unwrap().push(value);
                    if value.x == 1 {
                        entered.notify_one();
                        gate.notified().await;
                    }
                    Ok(())
                })
            }),
        );
        owner.observe(state(1)).unwrap();
        started.notified().await;
        owner.observe(state(2)).unwrap();
        let closing = owner.clone();
        let public = tokio::spawn(async move { closing.close().await });
        tokio::task::yield_now().await;
        public.abort();
        assert_eq!(work.active().unwrap(), 1);
        held.notify_one();
        assert!(owner.close().await.unwrap());
        assert_eq!(values.lock().unwrap().as_slice(), &[state(1), state(2)]);
        assert_eq!(work.active().unwrap(), 0);
    }
    #[tokio::test]
    async fn failed_persistence_is_explicit_without_fabricating_a_saved_receipt() {
        let owner = NativeWindowOwner::with_sink(
            NativeWorkOwner::default(),
            Arc::new(|_| Box::pin(async { Err(EngineError::new("DISCONNECTED")) })),
        );
        owner.observe(state(1)).unwrap();
        assert!(!owner.close().await.unwrap());
        assert_eq!(owner.0.state.lock().unwrap().latest, Some(state(1)));
        assert!(owner.0.state.lock().unwrap().failed);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod wry_proof {
    use super::*;
    use std::{
        borrow::Cow,
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
        time::{Duration, Instant},
    };
    use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
    use webkit2gtk::WebViewExt;
    struct ProofAssets;
    const HTML: &[u8] = b"<!doctype html><html><head><meta charset='utf-8'></head><body><textarea id='input'>controlled native text</textarea><button>Focusable control</button></body></html>";
    impl tauri::Assets<tauri::Wry> for ProofAssets {
        fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
            Some(Cow::Borrowed(HTML))
        }
        fn iter(&self) -> Box<AssetsIter<'_>> {
            Box::new(std::iter::once((
                Cow::Borrowed("index.html"),
                Cow::Borrowed(HTML),
            )))
        }
        fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
            Box::new(std::iter::empty())
        }
    }
    #[allow(deprecated)]
    fn pump(app: &mut tauri::App, mut ready: impl FnMut() -> bool) {
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            // Tao may otherwise wait for an OS event beyond the test deadline.
            // This bounded synthetic wakeup does not acknowledge any action.
            gtk::glib::timeout_add_local_once(Duration::from_millis(5), || {});
            app.run_iteration(|_, _| {});
            if ready() {
                return;
            }
            assert!(
                Instant::now() < until,
                "real Wry native-window proof deadline"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    #[allow(deprecated)]
    fn js(app: &mut tauri::App, window: &WebviewWindow, script: &str) -> String {
        let (send, receive) = std::sync::mpsc::channel();
        let script = script.to_owned();
        window
            .with_webview(move |w| {
                w.inner().run_javascript(
                    &script,
                    None::<&webkit2gtk::gio::Cancellable>,
                    move |result| {
                        let value = result
                            .map(|r| r.js_value().map(|v| v.to_string()).unwrap_or_default())
                            .map_err(|e| e.to_string());
                        let _ = send.send(value);
                    },
                );
            })
            .unwrap();
        let mut result = None;
        pump(app, || match receive.try_recv() {
            Ok(value) => {
                result = Some(value);
                true
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => false,
            Err(e) => panic!("actual WebKit JS callback missing: {e}"),
        });
        result.unwrap().unwrap()
    }
    fn activate_menu(window: &WebviewWindow, group: &str, label: &str) {
        use gtk::prelude::*;
        fn find(widget: &gtk::Widget, left: &mut usize) -> Option<gtk::MenuBar> {
            if *left == 0 {
                return None;
            }
            *left -= 1;
            if let Ok(menu) = widget.clone().downcast::<gtk::MenuBar>() {
                return Some(menu);
            }
            if let Ok(container) = widget.clone().downcast::<gtk::Container>() {
                for child in container.children() {
                    if let Some(menu) = find(&child, left) {
                        return Some(menu);
                    }
                }
            }
            None
        }
        fn labelled(widget: &gtk::Widget, wanted: &str, left: &mut usize) -> bool {
            if *left == 0 {
                return false;
            }
            *left -= 1;
            if let Some(label) = widget.downcast_ref::<gtk::Label>() {
                if label.text().replace('_', "") == wanted {
                    return true;
                }
            }
            if let Some(container) = widget.downcast_ref::<gtk::Container>() {
                return container
                    .children()
                    .iter()
                    .any(|child| labelled(child, wanted, left));
            }
            false
        }
        let gtk = window.gtk_window().unwrap();
        let mut remaining = 128;
        let menu = find(&gtk.upcast(), &mut remaining).expect("actual GTK menu bar");
        let submenu = menu
            .children()
            .into_iter()
            .filter_map(|v| v.downcast::<gtk::MenuItem>().ok())
            .find(|v| labelled(v.upcast_ref(), group, &mut 32))
            .unwrap()
            .submenu()
            .unwrap()
            .downcast::<gtk::Menu>()
            .unwrap();
        let item = submenu
            .children()
            .into_iter()
            .filter_map(|v| v.downcast::<gtk::MenuItem>().ok())
            .find(|v| labelled(v.upcast_ref(), label, &mut 32))
            .unwrap();
        assert!(item.is_sensitive());
        item.activate();
    }
    #[test]
    #[ignore = "requires an explicitly isolated Xvfb/Wry session; execute --ignored --test-threads=1"]
    fn real_wry_window_restoration_chrome_editing_zoom_and_untrusted_window_denial() {
        use gtk::prelude::*;
        let mut context = tauri::test::mock_context::<tauri::Wry, _>(ProofAssets);
        context.config_mut().identifier = "invalid.synthetic.window-proof".into();
        let config: Value =
            serde_json::from_str(include_str!("../tauri.production.conf.json")).unwrap();
        let csp = config["app"]["security"]["csp"]
            .as_str()
            .unwrap()
            .to_owned();
        context.config_mut().app.security.csp =
            Some(tauri::utils::config::Csp::Policy(csp.clone()));
        context.config_mut().app.security.dev_csp = Some(tauri::utils::config::Csp::Policy(csp));
        let ready = Arc::new(AtomicBool::new(false));
        let loaded = ready.clone();
        let denied = Arc::new(AtomicUsize::new(0));
        let refused = denied.clone();
        let ui = NativeUiOwner::default();
        let ticket = ui.reserve_window().unwrap();
        let page_ui = ui.clone();
        let navigation_ui = ui.clone();
        let mut app = tauri::Builder::default()
            .any_thread()
            .build(context)
            .unwrap();
        // Run setup before creating the actual physical Wry window.
        pump(&mut app, || true);
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .visible(false)
        .inner_size(1100., 750.)
        .on_navigation(move |url| {
            let trusted = super::super::trusted_origin(url);
            if !trusted {
                refused.fetch_add(1, Ordering::SeqCst);
            } else {
                navigation_ui.navigation(ticket).unwrap();
            }
            trusted
        })
        .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_page_load(move |window, event| match event.event() {
            tauri::webview::PageLoadEvent::Started => {
                prepare(&window).unwrap();
                page_ui.page_started(ticket, &window).unwrap();
            }
            tauri::webview::PageLoadEvent::Finished => {
                page_ui.page_finished(ticket, &window).unwrap();
                loaded.store(true, Ordering::SeqCst);
            }
        })
        .build()
        .unwrap();
        prepare(&window).unwrap();
        ui.attach_window(ticket, &window).unwrap();
        ui.watch_destroy(ticket, &window).unwrap();
        let values = Arc::new(Mutex::new(Vec::new()));
        let writes = values.clone();
        let work = NativeWorkOwner::default();
        let owner = NativeWindowOwner::with_sink(
            work.clone(),
            Arc::new(move |state| {
                writes.lock().unwrap().push(state);
                Box::pin(async { Ok(()) })
            }),
        );
        let restored = apply_restore(
            &window,
            Some(WindowState {
                x: -50000,
                y: -50000,
                width: 1100,
                height: 750,
                scale: 1.,
                maximized: false,
                fullscreen: false,
            }),
        )
        .unwrap();
        owner.attach(&window, ui.clone(), restored).unwrap();
        window.show().unwrap();
        window.set_focus().unwrap();
        pump(&mut app, || ready.load(Ordering::SeqCst));
        assert!(ui.assert_window(&window).is_ok());
        assert!(ui.completed_document_for_test(&window));
        eprintln!("WINDOW_PROOF: hidden document ready");
        let gtk = window.gtk_window().unwrap();
        let header = gtk
            .titlebar()
            .and_then(|v| v.downcast::<gtk::HeaderBar>().ok())
            .expect("native CSD exists before GTK realization");
        style_header(&header, b"#native-main-header { background-image:none; background-color:#141414; color:#8e8d91; } #native-main-header button, #native-main-header image { color:#8e8d91; }").unwrap();
        style_header(&header, b"#native-main-header { background-image:none; background-color:#f4f4f5; color:#141414; } #native-main-header button, #native-main-header image { color:#141414; }").unwrap();
        assert!(HEADER_STYLE.with(|slot| slot
            .borrow()
            .as_ref()
            .unwrap()
            .0
            .first()
            .and_then(|v| v.upgrade())
            == Some(header.clone().upcast())));
        eprintln!("WINDOW_PROOF: styles applied");
        pump(&mut app, || {
            let color = header.style_context().color(gtk::StateFlags::NORMAL);
            (color.red() - 20. / 255.).abs() < 0.01
                && (color.green() - 20. / 255.).abs() < 0.01
                && (color.blue() - 20. / 255.).abs() < 0.01
        });

        let symbols = HEADER_STYLE.with(|slot| {
            slot.borrow()
                .as_ref()
                .unwrap()
                .0
                .iter()
                .filter_map(|w| w.upgrade())
                .filter(|w| w.is::<gtk::Image>())
                .collect::<Vec<_>>()
        });
        assert!(!symbols.is_empty(), "actual native titlebar symbols");
        pump(&mut app, || {
            symbols.iter().all(|symbol| {
                let color = symbol.style_context().color(gtk::StateFlags::NORMAL);
                (color.red() - 20. / 255.).abs() < 0.01
                    && (color.green() - 20. / 255.).abs() < 0.01
                    && (color.blue() - 20. / 255.).abs() < 0.01
            })
        });
        eprintln!("WINDOW_PROOF: styles observed");
        assert_eq!(
            js(
                &mut app,
                &window,
                "document.querySelector('#input').focus();document.activeElement.id"
            ),
            "input"
        );
        // The real focused WebView receives exact editing commands. Keyboard
        // event accelerators remain with the input/terminal, not a global hook.
        pump(&mut app, || window.is_focused().unwrap_or(false));
        eprintln!("WINDOW_PROOF: selecting via GTK menu");
        activate_menu(&window, "Edit", "Select all");
        eprintln!("WINDOW_PROOF: GTK selection dispatched");
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            if js(&mut app, &window, "(()=>{const v=document.querySelector('#input');return v.selectionEnd-v.selectionStart})()") == "22" { break; }
            assert!(
                Instant::now() < until,
                "actual menu editing receipt deadline"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        eprintln!("WINDOW_PROOF: selection observed, zoom via GTK menu");
        activate_menu(&window, "View", "Zoom in");
        eprintln!("WINDOW_PROOF: GTK zoom dispatched");
        let zoomed = Arc::new(Mutex::new(1.));
        let observed = zoomed.clone();
        pump(&mut app, || {
            let observed = observed.clone();
            let _ = window.with_webview(move |w| {
                *observed.lock().unwrap() = w.inner().zoom_level();
            });
            *zoomed.lock().unwrap() > 1.
        });
        assert!((*zoomed.lock().unwrap() - 1.2_f64.sqrt()).abs() < 1e-8);
        let normal_size = window.inner_size().unwrap();
        pump(&mut app, || {
            owner.0.state.lock().unwrap().latest.is_some_and(|state| {
                state.width == normal_size.width
                    && state.height == normal_size.height
                    && !state.maximized
                    && !state.fullscreen
            })
        });
        activate_menu(&window, "Window", "Maximize / restore");
        pump(&mut app, || {
            window.is_maximized().unwrap_or(false)
                && owner
                    .0
                    .state
                    .lock()
                    .unwrap()
                    .latest
                    .is_some_and(|state| state.maximized)
        });
        let maximized = owner.0.state.lock().unwrap().latest.unwrap();
        assert_eq!(
            (maximized.width, maximized.height),
            (normal_size.width, normal_size.height),
            "maximized rectangle cannot replace normal bounds"
        );
        activate_menu(&window, "Window", "Maximize / restore");
        pump(&mut app, || {
            !window.is_maximized().unwrap_or(true)
                && owner
                    .0
                    .state
                    .lock()
                    .unwrap()
                    .latest
                    .is_some_and(|state| !state.maximized)
        });
        activate_menu(&window, "View", "Full screen");
        pump(&mut app, || {
            window.is_fullscreen().unwrap_or(false)
                && owner
                    .0
                    .state
                    .lock()
                    .unwrap()
                    .latest
                    .is_some_and(|state| state.fullscreen)
        });
        let fullscreen = owner.0.state.lock().unwrap().latest.unwrap();
        assert_eq!(
            (fullscreen.width, fullscreen.height),
            (normal_size.width, normal_size.height),
            "fullscreen rectangle cannot replace normal bounds"
        );
        activate_menu(&window, "View", "Full screen");
        pump(&mut app, || {
            !window.is_fullscreen().unwrap_or(true)
                && owner
                    .0
                    .state
                    .lock()
                    .unwrap()
                    .latest
                    .is_some_and(|state| !state.fullscreen)
        });
        window.hide().unwrap();
        pump(&mut app, || !window.is_visible().unwrap_or(true));
        let before_hidden_move = owner.0.state.lock().unwrap().latest;
        window
            .set_position(tauri::PhysicalPosition::new(80, 90))
            .unwrap();
        let hidden_settles = Instant::now() + Duration::from_millis(30);
        pump(&mut app, || Instant::now() >= hidden_settles);
        assert_eq!(
            owner.0.state.lock().unwrap().latest,
            before_hidden_move,
            "hidden rectangles cannot replace the last visible observation"
        );
        activate_menu(&window, "Window", "Show window");
        pump(&mut app, || {
            window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
        });
        let old_document = ui.capture_window_action(&window).unwrap();
        ready.store(false, Ordering::SeqCst);
        activate_menu(&window, "View", "Reload");
        pump(&mut app, || ready.load(Ordering::SeqCst));
        assert!(ui.completed_document_for_test(&window));
        assert!(
            ui.assert_window_action(&old_document).is_err(),
            "old native callback cannot act on the reloaded document"
        );
        eprintln!(
            "WINDOW_PROOF: normal/maximized/fullscreen/hide/reopen/reload ownership observed"
        );
        let foreign = tauri::WebviewWindowBuilder::new(
            &app,
            "untrusted",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        assert_eq!(
            super::super::authorize(&foreign).unwrap_err().code,
            "UNAUTHORIZED"
        );
        assert!(ui.assert_window(&foreign).is_err());
        assert_eq!(
            js(
                &mut app,
                &window,
                "location.href='https://example.invalid/untrusted';'requested'"
            ),
            "requested"
        );
        pump(&mut app, || denied.load(Ordering::SeqCst) > 0);
        assert!(super::super::authorize(&window).is_ok());
        let position = window.outer_position().unwrap();
        assert!(position.x >= 0 && position.y >= 0);
        owner.stop().unwrap();
        work.close().unwrap();
        assert!(tauri::async_runtime::block_on(owner.close()).unwrap());
        let count = values.lock().unwrap().len();
        owner.action(window.clone(), ui.clone(), Action::ZoomIn);
        assert_eq!(values.lock().unwrap().len(), count);
        foreign.destroy().unwrap();
        window.destroy().unwrap();
        app.cleanup_before_exit();
    }
}
