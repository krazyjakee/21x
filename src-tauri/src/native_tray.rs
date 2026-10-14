//! Production-preview Linux tray. Building an icon is not panel visibility:
//! hide requires a currently registered StatusNotifier host. Fixed app-owned
//! actions remain usable after Source failure; no renderer action is accepted.
use super::native_services::NativeWorkOwner;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex, Weak,
};
use tauri::{AppHandle, Manager, WebviewWindow};
use twentyonex_engine::EngineError;

pub(crate) type Scope = Arc<dyn Fn() -> Result<(), EngineError> + Send + Sync>;
const TRAY_ID: &str = "21x-production-owned-tray";
const OPEN_ID: &str = "21x-production-tray-open";
const QUIT_ID: &str = "21x-production-tray-quit";
static NEXT: AtomicU64 = AtomicU64::new(1);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Open,
    Quit,
}
fn action(value: &str) -> Option<Action> {
    match value {
        OPEN_ID => Some(Action::Open),
        QUIT_ID => Some(Action::Quit),
        _ => None,
    }
}
fn registered_host(expected: &str, observed: &str, registered: bool) -> bool {
    let Some((major, minor)) = expected.strip_prefix(':').and_then(|s| s.split_once('.')) else {
        return false;
    };
    registered
        && expected == observed
        && expected.len() <= 128
        && !major.is_empty()
        && !minor.is_empty()
        && major
            .bytes()
            .chain(minor.bytes())
            .all(|b| b.is_ascii_digit())
}
struct Active(Arc<AtomicBool>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
struct Completion<T> {
    reply: std::sync::mpsc::Sender<Result<T, EngineError>>,
    _lifetime: std::sync::mpsc::Sender<()>,
}
impl<T> Drop for Completion<T> {
    fn drop(&mut self) {}
}
impl<T> Completion<T> {
    fn finish(&self, result: Result<T, EngineError>) {
        let _ = self.reply.send(result);
    }
}
fn join_gui<T>(
    schedule: impl FnOnce(Completion<T>) -> Result<(), EngineError>,
) -> Result<T, EngineError> {
    let (reply, response) = std::sync::mpsc::channel();
    let (lifetime, retired) = std::sync::mpsc::channel::<()>();
    let scheduled = schedule(Completion {
        reply,
        _lifetime: lifetime,
    });
    let answer = response.recv();
    while retired.recv().is_ok() {} // an early response is not closure retirement
    scheduled?;
    answer.map_err(|_| EngineError::new("DISCONNECTED"))?
}
struct Request {
    current: Scope,
    completion: Completion<bool>,
}
impl Drop for Request {
    fn drop(&mut self) {}
}
async fn retained_action(
    work: NativeWorkOwner,
    current: Scope,
    schedule: impl FnOnce(Request) -> Result<(), EngineError> + Send + 'static,
) -> Result<bool, EngineError> {
    let active = Arc::new(AtomicBool::new(true));
    let _active = Active(active.clone());
    let current: Scope = Arc::new(move || {
        if !active.load(Ordering::SeqCst) {
            return Err(EngineError::new("CANCELLED"));
        }
        current()
    });
    let output = Arc::new(Mutex::new(None));
    let stored = output.clone();
    work.run(move || {
        current()?;
        let scope = current.clone();
        let result = join_gui(move |completion| {
            schedule(Request {
                current: scope,
                completion,
            })
        });
        current()?;
        *stored
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))? = Some(result?);
        Ok(())
    })
    .await?;
    let result = output
        .lock()
        .map_err(|_| EngineError::new("DISCONNECTED"))?
        .take()
        .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
    Ok(result)
}
struct Reservation(AtomicBool);
struct Inner {
    app: AppHandle,
    work: NativeWorkOwner,
    current: Scope,
    id: u64,
    closing: AtomicBool,
    installed: AtomicBool,
    #[cfg(target_os = "linux")]
    tray: Mutex<Option<tauri::tray::TrayIcon>>,
    #[cfg(target_os = "linux")]
    directory: Mutex<Option<linux::IconDirectory>>,
    close: Mutex<Option<tokio::sync::watch::Receiver<Option<Result<(), EngineError>>>>>,
}
impl Inner {
    fn current(&self) -> Result<(), EngineError> {
        if self.closing.load(Ordering::SeqCst) {
            return Err(EngineError::new("DISCONNECTED"));
        }
        self.work.assert_open()?;
        (self.current)()
    }
}
#[derive(Clone)]
pub struct NativeTrayOwner(Arc<Inner>);
impl NativeTrayOwner {
    pub fn new(
        app: &AppHandle,
        work: NativeWorkOwner,
        current: Scope,
    ) -> Result<Self, EngineError> {
        work.assert_open()?;
        // Tauri retains menu listeners globally and offers no unregister. One
        // permanent per-App reservation bounds that listener; it captures Weak.
        let _ = app.manage(Reservation(AtomicBool::new(false)));
        let reservation = app.state::<Reservation>();
        reservation
            .inner()
            .0
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| EngineError::new("TRAY_UNAVAILABLE"))?;
        let owner = Self(Arc::new(Inner {
            app: app.clone(),
            work,
            current,
            id: NEXT.fetch_add(1, Ordering::Relaxed),
            closing: AtomicBool::new(false),
            installed: AtomicBool::new(false),
            #[cfg(target_os = "linux")]
            tray: Mutex::new(None),
            #[cfg(target_os = "linux")]
            directory: Mutex::new(None),
            close: Mutex::new(None),
        }));
        #[cfg(target_os = "linux")]
        {
            // Once construction can accept native resources, always return the
            // owner even on failure so Root retains its cleanup/blocked lease.
            // Result::Err above is reserved for pre-effect admission failures.
            let _ = linux::install(&owner.0);
        }
        Ok(owner)
    }
    /// An actual owned icon was built. Linux hide separately verifies a host;
    /// neither fact claims the user's panel rendered the icon.
    pub fn is_available(&self) -> bool {
        self.0.installed.load(Ordering::SeqCst) && !self.0.closing.load(Ordering::SeqCst)
    }
    pub async fn hide_main(
        &self,
        window: &WebviewWindow,
        current: Scope,
    ) -> Result<bool, EngineError> {
        self.0.current()?;
        current()?;
        super::authorize(window)?;
        #[cfg(not(target_os = "linux"))]
        {
            Ok(false)
        }
        #[cfg(target_os = "linux")]
        {
            let (owner, app, window) = (self.0.clone(), self.0.app.clone(), window.clone());
            let guard = owner.clone();
            let current: Scope = Arc::new(move || {
                guard.current()?;
                current()
            });
            retained_action(self.0.work.clone(), current, move |request| {
                app.run_on_main_thread(move || linux::begin_hide(owner, window, request))
                    .map_err(|_| EngineError::new("DISCONNECTED"))
            })
            .await
        }
    }
    pub async fn close(&self) -> Result<(), EngineError> {
        self.0.closing.store(true, Ordering::SeqCst);
        self.0.installed.store(false, Ordering::SeqCst);
        let mut receiver = {
            let mut slot = self
                .0
                .close
                .lock()
                .map_err(|_| EngineError::new("DISCONNECTED"))?;
            let failed = slot
                .as_ref()
                .is_some_and(|receiver| receiver.borrow().as_ref().is_some_and(|r| r.is_err()));
            if let Some(receiver) = slot.as_ref().filter(|_| !failed) {
                receiver.clone()
            } else {
                let (tx, rx) = tokio::sync::watch::channel(None);
                *slot = Some(rx.clone());
                let owner = self.clone();
                // Independent driver: normal NativeWorkOwner admission is
                // already closed by ExitRequested; cleanup still must run.
                tauri::async_runtime::spawn(async move {
                    let result = owner.close_owned().await;
                    let _ = tx.send(Some(result));
                });
                rx
            }
        };
        loop {
            let result = receiver.borrow().clone();
            if let Some(result) = result {
                return result;
            }
            receiver
                .changed()
                .await
                .map_err(|_| EngineError::new("DISCONNECTED"))?;
        }
    }
    async fn close_owned(&self) -> Result<(), EngineError> {
        self.0.work.drain().await?;
        #[cfg(not(target_os = "linux"))]
        {
            Ok(())
        }
        #[cfg(target_os = "linux")]
        {
            let (owner, app) = (self.0.clone(), self.0.app.clone());
            let retired = tauri::async_runtime::spawn_blocking(move || {
                join_gui(move |completion| {
                    app.run_on_main_thread(move || linux::close(owner, completion))
                        .map_err(|_| EngineError::new("DISCONNECTED"))
                })
            })
            .await
            .map_err(|_| EngineError::new("INTERNAL_ERROR"))??;
            // GTK response/destruction handlers own a separate lifetime. Joining
            // the scheduling closure alone does not retire those handlers.
            if let Some(retired) = retired {
                tauri::async_runtime::spawn_blocking(move || while retired.recv().is_ok() {})
                    .await
                    .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
            }
            Ok(())
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use gtk::{
        gdk, gio,
        glib::{self, variant::ToVariant},
        prelude::*,
    };
    use raw_window_handle::HasWindowHandle;
    use std::{
        cell::RefCell,
        collections::HashMap,
        fs,
        os::unix::fs::{DirBuilderExt, MetadataExt},
        panic::{catch_unwind, AssertUnwindSafe},
        path::{Path, PathBuf},
        rc::Rc,
    };
    use twentyonex_engine::production_files::{
        NativeWorkspaceFileGuard, NativeWorkspaceFileOwner, NativeWorkspaceReceipt,
    };
    const WATCHER: &str = "org.kde.StatusNotifierWatcher";
    const WATCHER_PATH: &str = "/StatusNotifierWatcher";
    fn owner_name(value: &glib::Variant) -> Option<String> {
        if value.size() > 256 || value.type_().as_str() != "(s)" {
            return None;
        }
        let name = value.get::<(String,)>()?.0;
        registered_host(&name, &name, true).then_some(name)
    }
    fn host_property(value: &glib::Variant) -> bool {
        value.size() <= 32
            && value.type_().as_str() == "(v)"
            && value
                .get::<(glib::Variant,)>()
                .and_then(|v| v.0.get::<bool>())
                .unwrap_or(false)
    }
    pub(super) struct IconDirectory {
        pub(super) path: PathBuf,
        held: fs::File,
        inspection: IconInspection,
    }
    enum IconInspection {
        Pending,
        Missing,
        Captured {
            guard: NativeWorkspaceFileGuard,
            expected: fs::Metadata,
        },
    }
    impl IconDirectory {
        pub(super) fn new() -> Result<Self, EngineError> {
            for _ in 0..8 {
                let path = std::env::temp_dir().join(format!(
                    "21x-native-tray-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                match fs::DirBuilder::new().mode(0o700).create(&path) {
                    Ok(()) => {
                        let held = fs::File::open(&path)
                            .map_err(|_| EngineError::new("TRAY_UNAVAILABLE"))?;
                        let owner = Self {
                            path,
                            held,
                            inspection: IconInspection::Pending,
                        };
                        owner.recheck()?;
                        return Ok(owner);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(_) => return Err(EngineError::new("TRAY_UNAVAILABLE")),
                }
            }
            Err(EngineError::new("TRAY_UNAVAILABLE"))
        }
        fn recheck(&self) -> Result<(), EngineError> {
            let path = fs::symlink_metadata(&self.path)
                .map_err(|_| EngineError::new("TRAY_UNAVAILABLE"))?;
            let held = self
                .held
                .metadata()
                .map_err(|_| EngineError::new("TRAY_UNAVAILABLE"))?;
            if !path.is_dir() || path.dev() != held.dev() || path.ino() != held.ino() {
                return Err(EngineError::new("TRAY_UNAVAILABLE"));
            }
            Ok(())
        }
        pub(super) fn icon_path(&self) -> PathBuf {
            // Pinned tray-icon 0.25.1, initial icon; this owner never calls set_icon.
            self.path.join(format!("tray-icon-{TRAY_ID}-0.png"))
        }
        fn identity(path: &Path, metadata: &fs::Metadata) -> serde_json::Value {
            serde_json::json!({"path":path,"dev":metadata.dev().to_string(),"ino":metadata.ino().to_string(),"kind":if metadata.is_dir(){"directory"}else{"file"},"size":metadata.size().to_string(),"nlink":metadata.nlink().to_string()})
        }
        pub(super) fn capture_icon(&mut self) -> Result<(), EngineError> {
            self.recheck()?;
            let path = self.icon_path();
            let expected = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    self.inspection = IconInspection::Missing;
                    return Err(EngineError::new("TRAY_UNAVAILABLE"));
                }
                Err(_) => return Err(EngineError::new("TRAY_UNAVAILABLE")),
            };
            if !expected.is_file() || expected.nlink() != 1 || expected.size() > 1024 * 1024 {
                return Err(EngineError::new("TRAY_UNAVAILABLE"));
            }
            // Reuse actual metadata-only O_PATH authority. Never read/open a
            // substituted FIFO/device or adopt a later file during cleanup.
            let root = self
                .path
                .parent()
                .ok_or_else(|| EngineError::new("TRAY_UNAVAILABLE"))?;
            let task = self
                .path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| EngineError::new("TRAY_UNAVAILABLE"))?;
            let root_metadata =
                fs::symlink_metadata(root).map_err(|_| EngineError::new("TRAY_UNAVAILABLE"))?;
            let directory_metadata = self
                .held
                .metadata()
                .map_err(|_| EngineError::new("TRAY_UNAVAILABLE"))?;
            let receipt = NativeWorkspaceReceipt::from_value(&serde_json::json!({
                "version":1,"taskId":task,"workspaceRoot":root,"path":path,
                "root":Self::identity(root,&root_metadata),
                "ancestors":[Self::identity(&self.path,&directory_metadata)],
                "target":Self::identity(&path,&expected),
            }))
            .map_err(|_| EngineError::new("TRAY_UNAVAILABLE"))?;
            let owner = NativeWorkspaceFileOwner::open(root.to_path_buf())
                .map_err(|_| EngineError::new("TRAY_UNAVAILABLE"))?;
            let guard = owner
                .validate(&receipt)
                .map_err(|_| EngineError::new("TRAY_UNAVAILABLE"))?;
            guard
                .assert_clipboard_file(1024 * 1024)
                .map_err(|_| EngineError::new("TRAY_UNAVAILABLE"))?;
            self.inspection = IconInspection::Captured { guard, expected };
            self.recheck_icon_before_drop()
        }
        pub(super) fn recheck_icon_before_drop(&self) -> Result<(), EngineError> {
            self.recheck()?;
            let observed = match fs::symlink_metadata(self.icon_path()) {
                Ok(metadata) => metadata,
                // The pinned destructor may attempt to unlink this absent name,
                // but there is currently no foreign file to remove.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(_) => return Err(EngineError::new("TRAY_UNAVAILABLE")),
            };
            let IconInspection::Captured { guard, expected } = &self.inspection else {
                return Err(EngineError::new("TRAY_UNAVAILABLE"));
            };
            guard
                .assert_clipboard_file(1024 * 1024)
                .map_err(|_| EngineError::new("TRAY_UNAVAILABLE"))?;
            if !observed.is_file()
                || observed.nlink() != 1
                || observed.dev() != expected.dev()
                || observed.ino() != expected.ino()
                || observed.size() != expected.size()
                || observed.mode() != expected.mode()
                || observed.mtime() != expected.mtime()
                || observed.mtime_nsec() != expected.mtime_nsec()
                || observed.ctime() != expected.ctime()
                || observed.ctime_nsec() != expected.ctime_nsec()
            {
                return Err(EngineError::new("TRAY_UNAVAILABLE"));
            }
            Ok(())
        }
        pub(super) fn remove(&self) -> Result<(), EngineError> {
            self.recheck()?;
            fs::remove_dir(&self.path).map_err(|_| EngineError::new("TRAY_UNAVAILABLE"))
        }
    }
    fn icon() -> tauri::image::Image<'static> {
        let mut pixels = vec![0u8; 16 * 16 * 4];
        for y in 0..16 {
            for x in 0..16 {
                let offset = (y * 16 + x) * 4;
                let light = (3..6).contains(&x) && (3..13).contains(&y)
                    || (9..12).contains(&x) && (3..13).contains(&y);
                pixels[offset..offset + 4].copy_from_slice(if light {
                    &[235, 245, 255, 255]
                } else {
                    &[28, 67, 135, 255]
                });
            }
        }
        tauri::image::Image::new_owned(pixels, 16, 16)
    }
    pub(super) fn install(owner: &Arc<Inner>) -> Result<(), EngineError> {
        // Unsupported display/build is a real unavailable owner, never a hidden
        // window. Root still retains it for any accepted cleanup.
        if gdk::Display::default().is_none() {
            return Ok(());
        }
        if owner.app.tray_by_id(TRAY_ID).is_some() {
            return Err(EngineError::new("TRAY_UNAVAILABLE"));
        }
        let directory = match IconDirectory::new() {
            Ok(directory) => directory,
            Err(_) => return Ok(()),
        };
        let path = directory.path.clone();
        *owner
            .directory
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))? = Some(directory);
        let result = catch_unwind(AssertUnwindSafe(
            || -> Result<tauri::tray::TrayIcon, EngineError> {
                let open =
                    tauri::menu::MenuItem::with_id(&owner.app, OPEN_ID, "Open", true, None::<&str>)
                        .map_err(|_| EngineError::new("TRAY_UNAVAILABLE"))?;
                let quit =
                    tauri::menu::MenuItem::with_id(&owner.app, QUIT_ID, "Quit", true, None::<&str>)
                        .map_err(|_| EngineError::new("TRAY_UNAVAILABLE"))?;
                let menu = tauri::menu::Menu::with_items(&owner.app, &[&open, &quit])
                    .map_err(|_| EngineError::new("TRAY_UNAVAILABLE"))?;
                let weak = Arc::downgrade(owner);
                tauri::tray::TrayIconBuilder::with_id(TRAY_ID)
                    .icon(icon())
                    .menu(&menu)
                    .tooltip("21x Preview")
                    .temp_dir_path(path)
                    .on_menu_event(move |_app, event| {
                        if let Some(action) = action(event.id.as_ref()) {
                            dispatch(weak.clone(), action);
                        }
                    })
                    .build(&owner.app)
                    .map_err(|_| EngineError::new("TRAY_UNAVAILABLE"))
            },
        ))
        .unwrap_or_else(|_| Err(EngineError::new("TRAY_UNAVAILABLE")));
        if let Ok(tray) = result {
            *owner
                .tray
                .lock()
                .map_err(|_| EngineError::new("DISCONNECTED"))? = Some(tray);
            // Accepted tray ownership is retained even when inspection fails.
            // Such an owner stays unavailable and refuses unsafe cleanup.
            owner
                .directory
                .lock()
                .map_err(|_| EngineError::new("DISCONNECTED"))?
                .as_mut()
                .ok_or_else(|| EngineError::new("TRAY_UNAVAILABLE"))?
                .capture_icon()?;
            owner.installed.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
    fn main_current(owner: &Inner, window: &WebviewWindow) -> Result<(), EngineError> {
        owner.current()?;
        super::super::authorize(window)?;
        let current = owner
            .app
            .get_webview_window("main")
            .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
        super::super::authorize(&current)?;
        let expected = window
            .window_handle()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        let actual = current
            .window_handle()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        if expected.as_raw() != actual.as_raw() {
            return Err(EngineError::new("DISCONNECTED"));
        }
        Ok(())
    }
    fn dispatch(weak: Weak<Inner>, action: Action) {
        let Some(owner) = weak.upgrade() else { return };
        if owner.current().is_err() {
            return;
        }
        let current_owner = owner.clone();
        let current: Scope = Arc::new(move || current_owner.current());
        tauri::async_runtime::spawn(async move {
            let app = owner.app.clone();
            let work = owner.work.clone();
            let _ = retained_action(work, current, move |request| {
                app.run_on_main_thread(move || {
                    let result = catch_unwind(AssertUnwindSafe(|| -> Result<bool, EngineError> {
                        (request.current)()?;
                        let window = owner
                            .app
                            .get_webview_window("main")
                            .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
                        main_current(&owner, &window)?;
                        match action {
                            Action::Open => {
                                window
                                    .show()
                                    .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
                                (request.current)()?;
                                main_current(&owner, &window)?;
                                window
                                    .set_focus()
                                    .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
                            }
                            Action::Quit => owner.app.exit(0), // existing ExitRequested owns shutdown
                        }
                        Ok(true)
                    }))
                    .unwrap_or_else(|_| Err(EngineError::new("INTERNAL_ERROR")));
                    request.completion.finish(result);
                })
                .map_err(|_| EngineError::new("DISCONNECTED"))
            })
            .await;
        });
    }
    struct Hide {
        owner: Arc<Inner>,
        window: WebviewWindow,
        request: Request,
    }
    fn current(hide: &Hide) -> Result<(), EngineError> {
        (hide.request.current)()?;
        main_current(&hide.owner, &hide.window)
    }
    fn protected(hide: &Hide, effect: impl FnOnce() -> Result<(), EngineError>) {
        if let Err(error) = catch_unwind(AssertUnwindSafe(effect))
            .unwrap_or_else(|_| Err(EngineError::new("INTERNAL_ERROR")))
        {
            hide.request.completion.finish(Err(error));
        }
    }
    fn unavailable(hide: &Hide) -> Result<(), EngineError> {
        current(hide)?;
        hide.window
            .show()
            .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
        current(hide)?;
        hide.window
            .set_focus()
            .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
        show_unavailable_dialog(hide)?;
        hide.request.completion.finish(Ok(false));
        Ok(())
    }
    pub(super) fn begin_hide(owner: Arc<Inner>, window: WebviewWindow, request: Request) {
        let hide = Rc::new(Hide {
            owner,
            window,
            request,
        });
        protected(&hide, || {
            current(&hide)?;
            if !hide.owner.installed.load(Ordering::SeqCst)
                || hide.owner.app.tray_by_id(TRAY_ID).is_none()
            {
                return unavailable(&hide);
            }
            let retained = hide.clone();
            gio::bus_get(
                gio::BusType::Session,
                None::<&gio::Cancellable>,
                move |result| {
                    protected(&retained, || {
                        current(&retained)?;
                        match result {
                            Ok(connection) => query_host(retained.clone(), connection),
                            Err(_) => unavailable(&retained)?,
                        };
                        Ok(())
                    });
                },
            );
            Ok(())
        });
    }
    fn query_host(hide: Rc<Hide>, connection: gio::DBusConnection) {
        let captured = connection.clone();
        connection.call(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "GetNameOwner",
            Some(&(WATCHER,).to_variant()),
            None,
            gio::DBusCallFlags::NO_AUTO_START,
            1000,
            None::<&gio::Cancellable>,
            move |result| {
                protected(&hide, || {
                    current(&hide)?;
                    let Some(server) = result.ok().and_then(|v| owner_name(&v)) else {
                        return unavailable(&hide);
                    };
                    let connection = captured.clone();
                    let retained = hide.clone();
                    let observed = server.clone();
                    captured.call(
                        Some(&server),
                        WATCHER_PATH,
                        "org.freedesktop.DBus.Properties",
                        "Get",
                        Some(&(WATCHER, "IsStatusNotifierHostRegistered").to_variant()),
                        None,
                        gio::DBusCallFlags::NO_AUTO_START,
                        1000,
                        None::<&gio::Cancellable>,
                        move |result| {
                            protected(&retained, || {
                                current(&retained)?;
                                let registered = result.ok().is_some_and(|v| host_property(&v));
                                if !registered {
                                    return unavailable(&retained);
                                }
                                verify_host(retained.clone(), connection, observed);
                                Ok(())
                            });
                        },
                    );
                    Ok(())
                });
            },
        );
    }
    fn verify_host(hide: Rc<Hide>, connection: gio::DBusConnection, expected: String) {
        let captured = connection.clone();
        connection.call(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "GetNameOwner",
            Some(&(WATCHER,).to_variant()),
            None,
            gio::DBusCallFlags::NO_AUTO_START,
            1000,
            None::<&gio::Cancellable>,
            move |result| {
                protected(&hide, || {
                    current(&hide)?;
                    let observed = result.ok().and_then(|v| owner_name(&v)).unwrap_or_default();
                    if captured.is_closed() || !registered_host(&expected, &observed, true) {
                        return unavailable(&hide);
                    }
                    if !hide.owner.installed.load(Ordering::SeqCst)
                        || hide.owner.app.tray_by_id(TRAY_ID).is_none()
                    {
                        return unavailable(&hide);
                    }
                    current(&hide)?;
                    hide.window
                        .hide()
                        .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
                    current(&hide)?;
                    hide.request.completion.finish(Ok(true));
                    Ok(())
                });
            },
        );
    }
    struct SignalLifetime {
        _sender: std::sync::mpsc::Sender<()>,
    }
    impl Drop for SignalLifetime {
        fn drop(&mut self) {}
    }
    struct Dialog {
        widget: gtk::MessageDialog,
        handlers: Vec<glib::SignalHandlerId>,
        retired: std::sync::mpsc::Receiver<()>,
    }
    thread_local! {static DIALOGS:RefCell<HashMap<u64,Dialog>>=RefCell::new(HashMap::new());}
    fn retire_dialog(id: u64, destroy: bool) -> Option<std::sync::mpsc::Receiver<()>> {
        let dialog = DIALOGS.with(|dialogs| dialogs.borrow_mut().remove(&id))?;
        for handler in dialog.handlers {
            dialog.widget.disconnect(handler);
        }
        if destroy {
            unsafe {
                dialog.widget.destroy();
            }
        }
        Some(dialog.retired)
    }
    fn show_unavailable_dialog(hide: &Hide) -> Result<(), EngineError> {
        current(hide)?;
        let id = hide.owner.id;
        if DIALOGS.with(|dialogs| dialogs.borrow().contains_key(&id)) {
            return Ok(());
        }
        let parent = hide
            .window
            .gtk_window()
            .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
        let widget = gtk::MessageDialog::new(
            Some(&parent),
            gtk::DialogFlags::DESTROY_WITH_PARENT,
            gtk::MessageType::Info,
            gtk::ButtonsType::Ok,
            "No desktop tray host is available. The window will stay open.",
        );
        widget.set_title("Cannot minimize to tray");
        let (sender, retired) = std::sync::mpsc::channel();
        let response_lifetime = SignalLifetime {
            _sender: sender.clone(),
        };
        let destroy_lifetime = SignalLifetime { _sender: sender };
        let response = widget.connect_response(move |_widget, _| {
            let _keep = &response_lifetime;
            let _ = catch_unwind(AssertUnwindSafe(|| {
                drop(retire_dialog(id, true));
            }));
        });
        let destroy = widget.connect_destroy(move |_| {
            let _keep = &destroy_lifetime;
            let _ = catch_unwind(AssertUnwindSafe(|| {
                drop(retire_dialog(id, false));
            }));
        });
        DIALOGS.with(|dialogs| {
            dialogs.borrow_mut().insert(
                id,
                Dialog {
                    widget: widget.clone(),
                    handlers: vec![response, destroy],
                    retired,
                },
            );
        });
        current(hide)?;
        widget.show();
        Ok(())
    }
    pub(super) fn close(
        owner: Arc<Inner>,
        completion: Completion<Option<std::sync::mpsc::Receiver<()>>>,
    ) {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let retired = retire_dialog(owner.id, true);
            let mut tray = owner
                .tray
                .lock()
                .map_err(|_| EngineError::new("DISCONNECTED"))?;
            let mut directory = owner
                .directory
                .lock()
                .map_err(|_| EngineError::new("DISCONNECTED"))?;
            if let Some(directory) = directory.as_ref() {
                directory.recheck()?;
            }
            if let Some(icon) = tray.as_ref() {
                // Refuse known changes before making even the owned icon passive.
                directory
                    .as_ref()
                    .ok_or_else(|| EngineError::new("TRAY_UNAVAILABLE"))?
                    .recheck_icon_before_drop()?;
                icon.set_visible(false)
                    .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
            }
            if tray.is_some() {
                // The pinned library unlinks by pathname on final Drop. This
                // receipt check refuses known replacements but is not an atomic
                // unlink guarantee against concurrent same-UID namespace races.
                directory
                    .as_ref()
                    .ok_or_else(|| EngineError::new("TRAY_UNAVAILABLE"))?
                    .recheck_icon_before_drop()?;
                drop(owner.app.remove_tray_by_id(TRAY_ID));
                drop(tray.take());
            }
            if let Some(owned) = directory.as_ref() {
                owned.remove()?;
            }
            directory.take();
            Ok(retired)
        }))
        .unwrap_or_else(|_| Err(EngineError::new("INTERNAL_ERROR")));
        completion.finish(result);
    }
    #[cfg(test)]
    mod variants {
        use super::*;
        #[test]
        fn owner_reply_size_and_unique_name_are_checked_before_string_projection() {
            assert_eq!(
                owner_name(&(":1.23",).to_variant()).as_deref(),
                Some(":1.23")
            );
            let oversized = (format!(":1.{}", "1".repeat(4096)),).to_variant();
            assert!(oversized.size() > 256);
            assert!(owner_name(&oversized).is_none());
            for value in [
                ("org.kde.StatusNotifierWatcher",).to_variant(),
                (true,).to_variant(),
                (":1.23", ":1.24").to_variant(),
                (format!(":1.{}", "1".repeat(128)),).to_variant(),
            ] {
                assert!(owner_name(&value).is_none());
            }
        }
        #[test]
        fn registered_property_is_only_a_bounded_exact_variant_boolean() {
            assert!(host_property(&(true.to_variant(),).to_variant()));
            assert!(!host_property(&(false.to_variant(),).to_variant()));
            let oversized = (vec![true; 256].to_variant(),).to_variant();
            assert!(oversized.size() > 32);
            assert!(!host_property(&oversized));
            for value in [
                (1u32.to_variant(),).to_variant(),
                ("true".to_variant(),).to_variant(),
                ((true.to_variant(),).to_variant(),).to_variant(),
                (true,).to_variant(),
                (true.to_variant(), true.to_variant()).to_variant(),
            ] {
                assert!(!host_property(&value));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_actions_and_host_identity_never_admit_payload_or_well_known_aliases() {
        assert_eq!(action(OPEN_ID), Some(Action::Open));
        assert_eq!(action(QUIT_ID), Some(Action::Quit));
        for value in [
            "open",
            "quit",
            "app:exit",
            "https://example.test",
            TRAY_ID,
            "",
        ] {
            assert_eq!(action(value), None);
        }
        assert!(registered_host(":1.23", ":1.23", true));
        for (expected, observed, host) in [
            (":1.23", ":1.24", true),
            (":1.23", ":1.23", false),
            (
                "org.kde.StatusNotifierWatcher",
                "org.kde.StatusNotifierWatcher",
                true,
            ),
            (":1.2.3", ":1.2.3", true),
            (":1.", ":1.", true),
        ] {
            assert!(!registered_host(expected, observed, host));
        }
    }
    #[tokio::test]
    async fn early_hide_reply_does_not_retire_the_actual_gui_callback() {
        let work = NativeWorkOwner::default();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(retained_action(
            work.clone(),
            Arc::new(|| Ok(())),
            move |request| {
                let _ = tx.send(request);
                Ok(())
            },
        ));
        let request = rx.await.unwrap();
        request.completion.finish(Ok(true));
        assert_eq!(work.active().unwrap(), 1);
        assert!(!task.is_finished());
        drop(request);
        assert!(task.await.unwrap().unwrap());
        work.drain().await.unwrap();
        assert_eq!(work.active().unwrap(), 0);
    }
    #[tokio::test]
    async fn lost_hide_waiter_fences_future_gui_effect_and_retains_raw_work() {
        let work = NativeWorkOwner::default();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(retained_action(
            work.clone(),
            Arc::new(|| Ok(())),
            move |request| {
                let _ = tx.send(request);
                Ok(())
            },
        ));
        let request = rx.await.unwrap();
        task.abort();
        let _ = task.await;
        assert_eq!((request.current)().unwrap_err().code, "CANCELLED");
        assert_eq!(work.active().unwrap(), 1);
        drop(request);
        work.drain().await.unwrap();
    }
    #[tokio::test]
    async fn scheduling_error_and_late_scope_loss_never_fake_callback_acknowledgement() {
        let work = NativeWorkOwner::default();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(retained_action(
            work.clone(),
            Arc::new(|| Ok(())),
            move |request| {
                let _ = tx.send(request);
                Err(EngineError::new("DISCONNECTED"))
            },
        ));
        let request = rx.await.unwrap();
        request.completion.finish(Ok(false));
        assert_eq!(work.active().unwrap(), 1);
        assert!(!task.is_finished());
        drop(request);
        assert_eq!(task.await.unwrap().unwrap_err().code, "DISCONNECTED");
        work.drain().await.unwrap();
    }
    #[tokio::test]
    async fn authority_loss_after_accepted_hide_reply_still_joins_the_actual_callback() {
        let work = NativeWorkOwner::default();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let allowed = Arc::new(AtomicBool::new(true));
        let captured = allowed.clone();
        let current: Scope = Arc::new(move || {
            if captured.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(EngineError::new("UNAUTHORIZED"))
            }
        });
        let task = tokio::spawn(retained_action(work.clone(), current, move |request| {
            let _ = tx.send(request);
            Ok(())
        }));
        let request = rx.await.unwrap();
        request.completion.finish(Ok(true));
        allowed.store(false, Ordering::SeqCst);
        assert_eq!(work.active().unwrap(), 1);
        assert!(!task.is_finished());
        drop(request);
        assert_eq!(task.await.unwrap().unwrap_err().code, "UNAUTHORIZED");
        work.drain().await.unwrap();
        assert_eq!(work.active().unwrap(), 0);
    }
    #[tokio::test]
    async fn cleanup_can_join_gui_and_dialog_retirement_after_normal_work_closes() {
        let work = NativeWorkOwner::default();
        work.close().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let retired = tauri::async_runtime::spawn_blocking(move || {
                join_gui(
                    move |completion: Completion<Option<std::sync::mpsc::Receiver<()>>>| {
                        let _ = tx.send(completion);
                        Ok(())
                    },
                )
            })
            .await
            .unwrap()?;
            if let Some(retired) = retired {
                tauri::async_runtime::spawn_blocking(move || while retired.recv().is_ok() {})
                    .await
                    .unwrap();
            }
            Ok::<(), EngineError>(())
        });
        let completion = rx.await.unwrap();
        let (dialog, retired) = std::sync::mpsc::channel::<()>();
        completion.finish(Ok(Some(retired)));
        assert!(!task.is_finished());
        drop(completion);
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        drop(dialog);
        task.await.unwrap().unwrap();
        work.drain().await.unwrap();
    }
    #[cfg(target_os = "linux")]
    mod directory {
        use super::*;
        #[test]
        fn exact_icon_filename_replacement_blocks_destructor_and_preserves_both_files() {
            let mut directory = linux::IconDirectory::new().unwrap();
            let icon = directory.icon_path();
            std::fs::write(&icon, b"owned icon").unwrap();
            directory.capture_icon().unwrap();
            directory.recheck_icon_before_drop().unwrap();
            let retained = icon.with_extension("owned");
            std::fs::rename(&icon, &retained).unwrap();
            std::fs::write(&icon, b"other icon").unwrap();
            assert!(directory.recheck_icon_before_drop().is_err());
            assert_eq!(std::fs::read(&icon).unwrap(), b"other icon");
            assert_eq!(std::fs::read(&retained).unwrap(), b"owned icon");
            std::fs::remove_file(icon).unwrap();
            std::fs::remove_file(retained).unwrap();
            directory.remove().unwrap();
        }
        #[test]
        fn exact_icon_symlink_or_hardlink_replacement_never_removes_the_foreign_target() {
            use std::os::unix::fs::symlink;
            let mut directory = linux::IconDirectory::new().unwrap();
            let icon = directory.icon_path();
            std::fs::write(&icon, b"owned icon").unwrap();
            directory.capture_icon().unwrap();
            let original = icon.with_extension("retained");
            std::fs::rename(&icon, &original).unwrap();
            let foreign = directory.path.join("foreign");
            std::fs::write(&foreign, b"user data").unwrap();
            symlink(&foreign, &icon).unwrap();
            assert!(directory.recheck_icon_before_drop().is_err());
            assert!(std::fs::symlink_metadata(&icon)
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(std::fs::read(&foreign).unwrap(), b"user data");
            std::fs::remove_file(&icon).unwrap();
            std::fs::hard_link(&foreign, &icon).unwrap();
            assert!(directory.recheck_icon_before_drop().is_err());
            assert_eq!(std::fs::read(&foreign).unwrap(), b"user data");
            for path in [icon, original, foreign] {
                std::fs::remove_file(path).unwrap();
            }
            directory.remove().unwrap();
        }
        #[test]
        fn existing_uncaptured_icon_cannot_be_adopted_by_cleanup_after_inspection_failure() {
            let mut directory = linux::IconDirectory::new().unwrap();
            let icon = directory.icon_path();
            let oversized = std::fs::File::create(&icon).unwrap();
            oversized.set_len(1024 * 1024 + 1).unwrap();
            drop(oversized);
            assert!(directory.capture_icon().is_err());
            assert!(directory.recheck_icon_before_drop().is_err());
            assert_eq!(std::fs::metadata(&icon).unwrap().len(), 1024 * 1024 + 1);
            std::fs::remove_file(&icon).unwrap();
            assert!(directory.capture_icon().is_err());
            directory.recheck_icon_before_drop().unwrap();
            std::fs::write(&icon, b"later foreign icon").unwrap();
            assert!(directory.recheck_icon_before_drop().is_err());
            assert_eq!(std::fs::read(&icon).unwrap(), b"later foreign icon");
            std::fs::remove_file(icon).unwrap();
            directory.remove().unwrap();
        }
        #[test]
        fn absent_captured_icon_is_safe_but_a_new_file_at_the_name_blocks_cleanup() {
            let mut directory = linux::IconDirectory::new().unwrap();
            let icon = directory.icon_path();
            std::fs::write(&icon, b"owned").unwrap();
            directory.capture_icon().unwrap();
            std::fs::remove_file(&icon).unwrap();
            directory.recheck_icon_before_drop().unwrap();
            std::fs::write(&icon, b"foreign").unwrap();
            assert!(directory.recheck_icon_before_drop().is_err());
            assert_eq!(std::fs::read(&icon).unwrap(), b"foreign");
            std::fs::remove_file(icon).unwrap();
            directory.remove().unwrap();
        }
        #[test]
        fn same_inode_and_size_with_changed_metadata_refuses_destructor() {
            let mut directory = linux::IconDirectory::new().unwrap();
            let icon = directory.icon_path();
            std::fs::write(&icon, b"owned").unwrap();
            directory.capture_icon().unwrap();
            let held = std::fs::File::options().write(true).open(&icon).unwrap();
            held.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1))
                .unwrap();
            drop(held);
            assert!(directory.recheck_icon_before_drop().is_err());
            assert_eq!(std::fs::read(&icon).unwrap(), b"owned");
            std::fs::remove_file(icon).unwrap();
            directory.remove().unwrap();
        }
        #[test]
        fn icon_directory_cleanup_refuses_replacement_and_preserves_unrelated_files() {
            let directory = linux::IconDirectory::new().unwrap();
            let path = directory.path.clone();
            let moved = path.with_extension("moved");
            std::fs::rename(&path, &moved).unwrap();
            std::fs::create_dir(&path).unwrap();
            let unrelated = path.join("unrelated");
            std::fs::write(&unrelated, "keep").unwrap();
            assert!(directory.remove().is_err());
            assert_eq!(std::fs::read(&unrelated).unwrap(), b"keep");
            std::fs::remove_file(unrelated).unwrap();
            std::fs::remove_dir(&path).unwrap();
            std::fs::rename(moved, &path).unwrap();
            directory.remove().unwrap();
        }
        #[test]
        fn icon_directories_are_exclusive_private_and_never_recursively_remove_unknown_files() {
            use std::os::unix::fs::PermissionsExt;
            let first = linux::IconDirectory::new().unwrap();
            let second = linux::IconDirectory::new().unwrap();
            assert_ne!(first.path, second.path);
            assert_eq!(
                std::fs::metadata(&first.path).unwrap().permissions().mode() & 0o777,
                0o700
            );
            let unknown = first.path.join("not-owned-by-tray");
            std::fs::write(&unknown, "keep").unwrap();
            assert!(first.remove().is_err());
            assert_eq!(std::fs::read(&unknown).unwrap(), b"keep");
            std::fs::remove_file(unknown).unwrap();
            first.remove().unwrap();
            second.remove().unwrap();
        }
    }
}
