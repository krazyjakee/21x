//! Native-only two-phase drop ownership. A context is UI intent, never file or
//! task authority. Cancellation is synchronous; cleanup receipts join raw work.
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use twentyonex_engine::{production::HostFuture, EngineError};

pub const CONTEXT: &str = "attachments:setNativeDropContext";
pub const ACCEPT: &str = "native.attachment.drop.accept";
pub const CLOSE: &str = "native.attachment.drop.close";
#[cfg(target_os = "linux")]
pub const EVENT: &str = "desktop:attachment-drop";
const MAX_IDS: usize = 4096;
#[cfg(any(target_os = "linux", test))]
const MAX_GROUPS: usize = 16;
pub const OFFER_TTL: Duration = Duration::from_secs(15);
pub type Guard = Arc<dyn Fn() -> Result<(), EngineError> + Send + Sync>;
type Retire = Arc<dyn Fn(Arc<Group>) -> HostFuture<()> + Send + Sync>;
type Capture = Arc<dyn Fn(DropOwner, Vec<std::path::PathBuf>, String, String, Guard) + Send + Sync>;
fn refused() -> EngineError {
    EngineError::new("INVALID_REQUEST")
}
pub fn uuid(value: &Value) -> bool {
    value.as_str().is_some_and(|v| {
        v.len() == 36
            && v.bytes().enumerate().all(|(i, b)| {
                if [8, 13, 18, 23].contains(&i) {
                    b == b'-'
                } else {
                    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
                }
            })
            && v.as_bytes()[14] == b'4'
            && matches!(v.as_bytes()[19], b'8' | b'9' | b'a' | b'b')
    })
}
pub fn request(operation: &str, value: &Value) -> bool {
    let fields: &[&str] = match operation {
        CONTEXT => &["contextId", "contextRevision"],
        ACCEPT | CLOSE => &["dropId", "contextId"],
        _ => return false,
    };
    value
        .as_object()
        .is_some_and(|v| v.len() == fields.len() && fields.iter().all(|key| v.contains_key(*key)))
        && (operation == CONTEXT && value["contextId"].is_null() || uuid(&value["contextId"]))
        && (operation == CONTEXT || uuid(&value["dropId"]))
        && (operation != CONTEXT
            || value["contextRevision"]
                .as_u64()
                .is_some_and(|n| (1..=9007199254740991).contains(&n)))
}
#[cfg(target_os = "linux")]
pub fn event(value: &Value) -> bool {
    value.as_object().is_some_and(|v| {
        v.len() == 3
            && ["dropId", "contextId", "paths"]
                .iter()
                .all(|key| v.contains_key(*key))
    }) && uuid(&value["dropId"])
        && uuid(&value["contextId"])
        && value["paths"].as_array().is_some_and(|paths| {
            !paths.is_empty()
                && paths.len() <= 16
                && paths
                    .iter()
                    .all(twentyonex_engine::production_attachment_selection::path)
                && paths
                    .iter()
                    .map(|path| path.as_str())
                    .collect::<HashSet<_>>()
                    .len()
                    == paths.len()
        })
}

#[derive(Clone, Debug, PartialEq)]
pub struct Context {
    pub id: String,
    pub lease: String,
    pub epoch: String,
}
pub struct Group {
    pub id: String,
    pub context: Context,
    #[cfg(any(target_os = "linux", test))]
    pub selection_ids: Vec<String>,
    revision: u64,
    created: Instant,
    cancelled: AtomicBool,
    accepted: AtomicBool,
    retired: AtomicBool,
    raw: AtomicBool,
    settled: tokio::sync::Notify,
    #[cfg(any(target_os = "linux", test))]
    timer_started: AtomicBool,
    timer_active: AtomicBool,
    timer_cancelled: AtomicBool,
    timer_wake: tokio::sync::Notify,
    timer_done: tokio::sync::Notify,
    cleanup: tokio::sync::Mutex<()>,
    #[cfg(target_os = "linux")]
    pub offered: AtomicBool,
    guard: Guard,
}
impl Group {
    #[cfg(any(target_os = "linux", test))]
    pub fn finish_raw(&self) {
        self.raw.store(false, Ordering::SeqCst);
        self.settled.notify_waiters();
    }
    async fn join_raw(&self) {
        loop {
            let settled = self.settled.notified();
            tokio::pin!(settled);
            settled.as_mut().enable();
            if !self.raw.load(Ordering::SeqCst) {
                return;
            }
            settled.await;
        }
    }
    async fn stop_timer(&self) {
        self.timer_cancelled.store(true, Ordering::SeqCst);
        self.timer_wake.notify_waiters();
        loop {
            let done = self.timer_done.notified();
            tokio::pin!(done);
            done.as_mut().enable();
            if !self.timer_active.load(Ordering::SeqCst) {
                return;
            }
            done.await;
        }
    }
}
#[cfg(target_os = "linux")]
pub struct RawReceipt(pub Arc<Group>);
#[cfg(target_os = "linux")]
impl Drop for RawReceipt {
    fn drop(&mut self) {
        self.0.finish_raw();
    }
}

#[derive(Default)]
struct State {
    stopped: bool,
    revision: u64,
    active: Option<Context>,
    candidate: Option<Context>,
    registration: Option<(String, String, u64)>,
    used_contexts: HashSet<String>,
    used_drops: HashMap<String, Context>,
    groups: HashMap<String, Arc<Group>>,
    retire: Option<Retire>,
    capture: Option<Capture>,
}
#[derive(Clone, Default)]
pub struct DropOwner(Arc<Mutex<State>>);
impl DropOwner {
    #[cfg(any(target_os = "linux", test))]
    pub fn configure(&self, retire: Retire) -> Result<(), EngineError> {
        let mut state = self.0.lock().map_err(|_| refused())?;
        if state.retire.is_some() {
            return Err(refused());
        }
        state.retire = Some(retire);
        Ok(())
    }
    pub fn available(&self) -> bool {
        self.0
            .lock()
            .is_ok_and(|s| !s.stopped && s.retire.is_some() && s.capture.is_some())
    }
    #[cfg(any(target_os = "linux", test))]
    pub fn configure_capture(&self, capture: Capture) -> Result<(), EngineError> {
        let mut state = self.0.lock().map_err(|_| refused())?;
        if state.capture.is_some() {
            return Err(refused());
        }
        state.capture = Some(capture);
        Ok(())
    }
    pub fn native_drop(
        &self,
        paths: Vec<std::path::PathBuf>,
        epoch: String,
        lease: String,
        guard: Guard,
    ) {
        let capture = self
            .0
            .lock()
            .ok()
            .and_then(|s| if s.stopped { None } else { s.capture.clone() });
        if let Some(capture) = capture {
            capture(self.clone(), paths, epoch, lease, guard);
        }
    }
    /// Fence old admission before constructing any async cleanup future.
    fn begin_context(
        &self,
        context: Option<Context>,
        registration: Option<(String, String, u64)>,
    ) -> Result<(u64, Vec<Arc<Group>>), EngineError> {
        let mut state = self.0.lock().map_err(|_| refused())?;
        if state.stopped || state.retire.is_none() {
            return Err(EngineError::new("DISCONNECTED"));
        }
        if let Some((epoch, lease, revision)) = &registration {
            if state
                .registration
                .as_ref()
                .is_some_and(|(e, l, r)| e == epoch && l == lease && r >= revision)
            {
                return Err(refused());
            }
        }
        if let Some(context) = &context {
            if !uuid(&Value::String(context.id.clone())) {
                return Err(EngineError::new("INVALID_ARGUMENTS"));
            }
            // A retry may clean a failed candidate. A retired nonce cannot be
            // revived by a delayed registration, even in the same task view.
            if state.used_contexts.contains(&context.id)
                && state.candidate.as_ref() != Some(context)
                && state.active.as_ref() != Some(context)
            {
                return Err(refused());
            }
            if !state.used_contexts.contains(&context.id) && state.used_contexts.len() >= MAX_IDS {
                return Err(EngineError::new("BACKPRESSURE"));
            }
            state.used_contexts.insert(context.id.clone());
        }
        if registration.is_some() {
            state.registration = registration;
        }
        state.revision = state.revision.checked_add(1).ok_or_else(refused)?;
        state.active = None;
        state.candidate = context;
        let groups: Vec<_> = state.groups.values().cloned().collect();
        for group in &groups {
            group.cancelled.store(true, Ordering::SeqCst);
        }
        Ok((state.revision, groups))
    }
    #[cfg(test)]
    pub fn register(&self, context: Option<Context>, guard: Guard) -> HostFuture<()> {
        self.register_started(context, guard, None)
    }
    pub fn register_numbered(
        &self,
        context: Option<Context>,
        guard: Guard,
        epoch: String,
        lease: String,
        revision: u64,
    ) -> HostFuture<()> {
        self.register_started(context, guard, Some((epoch, lease, revision)))
    }
    fn register_started(
        &self,
        context: Option<Context>,
        guard: Guard,
        registration: Option<(String, String, u64)>,
    ) -> HostFuture<()> {
        let begun = self.begin_context(context.clone(), registration);
        let owner = self.clone();
        // The independent driver retains cleanup if the invoke receiver leaves.
        let (send, receive) = tokio::sync::oneshot::channel();
        tauri::async_runtime::spawn(async move {
            let result = async {
                let (revision, groups) = begun?;
                for group in groups {
                    owner.close_group(group).await?;
                }
                guard()?;
                let mut state = owner.0.lock().map_err(|_| refused())?;
                if state.stopped || state.revision != revision || state.candidate != context {
                    return Err(refused());
                }
                state.active = context;
                Ok(())
            }
            .await;
            let _ = send.send(result);
        });
        Box::pin(async move { receive.await.map_err(|_| refused())? })
    }
    /// The caller invokes this synchronously in the actual native Drop callback.
    /// No later current-document/context lookup may retarget this group.
    #[cfg(any(target_os = "linux", test))]
    pub fn capture(
        &self,
        id: String,
        selection_ids: Vec<String>,
        lease: &str,
        epoch: &str,
        guard: Guard,
    ) -> Result<Arc<Group>, EngineError> {
        if !uuid(&Value::String(id.clone()))
            || selection_ids.is_empty()
            || selection_ids.len() > 16
            || selection_ids
                .iter()
                .any(|id| !uuid(&Value::String(id.clone())))
            || selection_ids.iter().collect::<HashSet<_>>().len() != selection_ids.len()
        {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        guard()?;
        let mut state = self.0.lock().map_err(|_| refused())?;
        if state.stopped {
            return Err(EngineError::new("DISCONNECTED"));
        }
        let context = state
            .active
            .clone()
            .filter(|c| c.lease == lease && c.epoch == epoch)
            .ok_or_else(refused)?;
        if state.groups.len() >= MAX_GROUPS || state.used_drops.len() >= MAX_IDS {
            return Err(EngineError::new("BACKPRESSURE"));
        }
        if state.used_drops.contains_key(&id) {
            return Err(refused());
        }
        let group = Arc::new(Group {
            id: id.clone(),
            context: context.clone(),
            selection_ids,
            revision: state.revision,
            created: Instant::now(),
            cancelled: AtomicBool::new(false),
            accepted: AtomicBool::new(false),
            retired: AtomicBool::new(false),
            raw: AtomicBool::new(true),
            settled: tokio::sync::Notify::new(),
            timer_started: AtomicBool::new(false),
            timer_active: AtomicBool::new(false),
            timer_cancelled: AtomicBool::new(false),
            timer_wake: tokio::sync::Notify::new(),
            timer_done: tokio::sync::Notify::new(),
            cleanup: tokio::sync::Mutex::new(()),
            #[cfg(target_os = "linux")]
            offered: AtomicBool::new(false),
            guard,
        });
        state.used_drops.insert(id.clone(), context);
        state.groups.insert(id, group.clone());
        Ok(group)
    }
    pub fn check(&self, group: &Group, read: bool) -> Result<(), EngineError> {
        if group.cancelled.load(Ordering::SeqCst)
            || group.retired.load(Ordering::SeqCst)
            || read && !group.accepted.load(Ordering::SeqCst)
            || !group.accepted.load(Ordering::SeqCst) && group.created.elapsed() >= OFFER_TTL
        {
            return Err(refused());
        }
        (group.guard)()?;
        let state = self.0.lock().map_err(|_| refused())?;
        if state.stopped
            || state.revision != group.revision
            || state.active.as_ref() != Some(&group.context)
        {
            return Err(refused());
        }
        Ok(())
    }
    #[cfg(any(target_os = "linux", test))]
    pub fn check_selection(&self, id: &str, lease: &str) -> Result<(), EngineError> {
        let group = self
            .0
            .lock()
            .map_err(|_| refused())?
            .groups
            .values()
            .find(|g| g.selection_ids.iter().any(|selected| selected == id))
            .cloned();
        if let Some(group) = group {
            if group.context.lease != lease {
                return Err(refused());
            }
            self.check(&group, true)?;
        }
        Ok(()) // non-drop picker grants retain their existing native policy
    }
    pub fn accept(&self, id: &str, context: &Context) -> Result<(), EngineError> {
        let group = self
            .0
            .lock()
            .map_err(|_| refused())?
            .groups
            .get(id)
            .cloned()
            .ok_or_else(refused)?;
        if &group.context != context {
            return Err(refused());
        }
        self.check(&group, false)?;
        // Serialize the final context check and acceptance with replacement.
        let state = self.0.lock().map_err(|_| refused())?;
        if state.stopped
            || state.revision != group.revision
            || state.active.as_ref() != Some(context)
            || group.cancelled.load(Ordering::SeqCst)
        {
            return Err(refused());
        }
        group.accepted.store(true, Ordering::SeqCst);
        Ok(())
    }
    pub fn close(&self, id: &str, context: &Context) -> HostFuture<()> {
        let found = (|| {
            let state = self.0.lock().map_err(|_| refused())?;
            if state.used_drops.get(id) != Some(context) {
                return Err(refused());
            }
            let group = state.groups.get(id).cloned();
            if let Some(group) = &group {
                group.cancelled.store(true, Ordering::SeqCst);
            }
            Ok(group)
        })();
        let owner = self.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        tauri::async_runtime::spawn(async move {
            let result = async {
                if let Some(group) = found? {
                    owner.close_group(group).await?;
                }
                Ok(())
            }
            .await;
            let _ = send.send(result);
        });
        Box::pin(async move { receive.await.map_err(|_| refused())? })
    }
    pub async fn close_group(&self, group: Arc<Group>) -> Result<(), EngineError> {
        group.cancelled.store(true, Ordering::SeqCst);
        let _serial = group.cleanup.lock().await;
        if group.retired.load(Ordering::SeqCst) {
            return Ok(());
        }
        group.join_raw().await;
        // Capture installs its timer before releasing its raw receipt. Joining
        // raw first also covers a concurrent close just before timer admission.
        group.stop_timer().await;
        let retire = self
            .0
            .lock()
            .map_err(|_| refused())?
            .retire
            .clone()
            .ok_or_else(refused)?;
        retire(group.clone()).await?;
        group.retired.store(true, Ordering::SeqCst);
        group.settled.notify_waiters();
        self.0
            .lock()
            .map_err(|_| refused())?
            .groups
            .remove(&group.id);
        Ok(())
    }
    #[cfg(any(target_os = "linux", test))]
    pub fn expire(&self, group: Arc<Group>) {
        if group.timer_started.swap(true, Ordering::SeqCst) {
            return;
        }
        group.timer_active.store(true, Ordering::SeqCst);
        let owner = self.clone();
        tauri::async_runtime::spawn(async move {
            let wake = group.timer_wake.notified();
            tokio::pin!(wake);
            wake.as_mut().enable();
            let expired = if group.timer_cancelled.load(Ordering::SeqCst) {
                false
            } else {
                tokio::select! { _ = tokio::time::sleep(OFFER_TTL.saturating_sub(group.created.elapsed())) => true, _ = wake => false }
            };
            // Retire the timer before entering group cleanup; cleanup can join
            // this receipt without creating a timer/retirement await cycle.
            group.timer_active.store(false, Ordering::SeqCst);
            group.timer_done.notify_waiters();
            if expired && !group.accepted.load(Ordering::SeqCst) {
                // Failure retains the cancelled group for context/explicit close retry.
                let _ = owner.close_group(group.clone()).await;
            }
        });
    }
    pub fn invalidate(&self, stop: bool) -> Result<Vec<Arc<Group>>, EngineError> {
        let mut state = self.0.lock().map_err(|_| refused())?;
        state.revision = state.revision.checked_add(1).ok_or_else(refused)?;
        state.active = None;
        state.candidate = None;
        state.stopped |= stop;
        let groups: Vec<_> = state.groups.values().cloned().collect();
        for group in &groups {
            group.cancelled.store(true, Ordering::SeqCst);
        }
        Ok(groups)
    }
    pub fn retire_document(&self) {
        if let Ok(groups) = self.invalidate(false) {
            let owner = self.clone();
            tauri::async_runtime::spawn(async move {
                for group in groups {
                    let _ = owner.close_group(group).await;
                }
            });
        }
    }
    pub async fn shutdown(&self) -> Result<(), EngineError> {
        for group in self.invalidate(true)? {
            self.close_group(group).await?;
        }
        Ok(())
    }
}

pub fn watch(
    window: &tauri::WebviewWindow,
    ticket: u64,
    ui: super::production_ui::NativeUiOwner,
    owner: DropOwner,
) {
    // The native OS drop identifies this physical target. Keyboard focus stays
    // with a file manager while dragging; it does not identify the drop target.
    // Never dispatch getters or follow a replacement page after this callback.
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Destroyed => {
            owner.retire_document();
        }
        tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
            if let Ok((epoch, lease, document)) = ui.capture_drop_document(ticket) {
                owner.native_drop(paths.clone(), epoch, lease, document);
            }
        }
        _ => {}
    });
}

#[cfg(all(test, target_os = "linux"))]
mod wry_proof {
    use super::super::{
        native_window::wry_proof::{js, pump},
        production_ui::NativeUiOwner,
    };
    use super::*;
    use gtk::prelude::*;
    use std::{borrow::Cow, sync::atomic::AtomicUsize};
    use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
    use twentyonex_engine::production_attachment_selection::SelectionAuthority;
    struct Assets;
    impl tauri::Assets<tauri::Wry> for Assets {
        fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
            Some(Cow::Borrowed(
                b"<!doctype html><html><body>Native file drop target</body></html>",
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
    #[test]
    #[ignore = "requires isolated Xvfb/Openbox/Wry and controlled GTK URI-list drag source; no user files"]
    fn real_linux_os_drop_captures_original_document_context_and_held_file() {
        let base = std::env::temp_dir().join(format!(
            "21x-drop-wry-{}",
            super::super::native_attachment_selection::selection_id().unwrap()
        ));
        std::fs::create_dir(&base).unwrap();
        let file = base.join("controlled.txt");
        std::fs::write(&file, "fixture").unwrap();
        let mut context = tauri::test::mock_context::<tauri::Wry, _>(Assets);
        context.config_mut().identifier = "invalid.synthetic.drop-proof".into();
        let config: Value =
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
        let ui = NativeUiOwner::default();
        let ticket = ui.reserve_window().unwrap();
        let (page_ui, navigation_ui) = (ui.clone(), ui.clone());
        let owner = DropOwner::default();
        let navigation_owner = owner.clone();
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("Controlled native drop target")
        .visible(false)
        .inner_size(650., 450.)
        .position(600., 60.)
        .on_navigation(move |url| {
            if !super::super::trusted_origin(url) {
                return false;
            }
            navigation_owner.retire_document();
            navigation_ui.navigation(ticket).is_ok()
        })
        .on_page_load(move |window, event| match event.event() {
            tauri::webview::PageLoadEvent::Started => {
                super::super::native_window::prepare(&window).unwrap();
                page_ui.page_started(ticket, &window).unwrap();
            }
            tauri::webview::PageLoadEvent::Finished => {
                page_ui.page_finished(ticket, &window).unwrap();
            }
        })
        .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
        .build()
        .unwrap();
        super::super::native_window::prepare(&window).unwrap();
        ui.watch_destroy(ticket, &window).unwrap();
        watch(&window, ticket, ui.clone(), owner.clone());
        let observed = Arc::new(AtomicUsize::new(0));
        let observed_drop = observed.clone();
        window.on_window_event(move |event| {
            if matches!(
                event,
                tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { .. })
            ) {
                observed_drop.fetch_add(1, Ordering::SeqCst);
            }
        });
        window.show().unwrap();
        pump(&mut app, || ui.completed_document_for_test(&window));
        let lease = ui.activate_synthetic_document(&window, "synthetic-drop-epoch");
        assert!(ui.capture_drop_document(ticket + 1).is_err());
        let files = SelectionAuthority::default();
        let retiring_files = files.clone();
        owner
            .configure(Arc::new(move |group| {
                let files = retiring_files.clone();
                Box::pin(async move {
                    for id in &group.selection_ids {
                        files.invoke(
                            "host.attachment.selection.retire",
                            &serde_json::json!({"leaseId":group.context.lease,"selectionId":id}),
                            || Ok(()),
                        )?;
                    }
                    Ok(())
                })
            }))
            .unwrap();
        let captured = Arc::new(Mutex::new(None::<(Arc<Group>, Vec<std::path::PathBuf>)>));
        let received = captured.clone();
        let (capture_files, profile) = (files.clone(), base.join("protected-profile"));
        owner
            .configure_capture(Arc::new(move |owner, paths, epoch, lease, guard| {
                let ids: Vec<_> = paths
                    .iter()
                    .map(|_| super::super::native_attachment_selection::selection_id().unwrap())
                    .collect();
                let group = owner
                    .capture(
                        super::super::native_attachment_selection::selection_id().unwrap(),
                        ids,
                        &lease,
                        &epoch,
                        guard,
                    )
                    .unwrap();
                for (path, id) in paths.iter().zip(&group.selection_ids) {
                    capture_files
                        .select_scoped(path.clone(), id, &lease, &profile, || {
                            owner.check(&group, false)
                        })
                        .unwrap();
                }
                group.finish_raw();
                *received.lock().unwrap() = Some((group, paths));
            }))
            .unwrap();
        let intent = Context {
            id: "11111111-1111-4111-8111-111111111111".into(),
            lease,
            epoch: "synthetic-drop-epoch".into(),
        };
        tauri::async_runtime::block_on(owner.register(Some(intent.clone()), Arc::new(|| Ok(()))))
            .unwrap();
        let source = gtk::Window::new(gtk::WindowType::Toplevel);
        source.set_title("Controlled URI drag source");
        source.set_default_size(300, 200);
        source.move_(60, 60);
        let button = gtk::Button::with_label("Drag controlled fixture file");
        source.add(&button);
        button.drag_source_set(
            gtk::gdk::ModifierType::BUTTON1_MASK,
            &[gtk::TargetEntry::new(
                "text/uri-list",
                gtk::TargetFlags::OTHER_APP,
                0,
            )],
            gtk::gdk::DragAction::COPY,
        );
        let uri = tauri::Url::from_file_path(&file).unwrap().to_string();
        button.connect_drag_data_get(move |_, _, data, _, _| {
            assert!(data.set_uris(&[&uri]));
        });
        source.show_all();
        source.present();
        pump(&mut app, || {
            source.is_active() && !window.is_focused().unwrap()
        });
        let drag = std::thread::spawn(|| {
            std::process::Command::new("xdotool")
                .args([
                    "mousemove",
                    "--sync",
                    "180",
                    "160",
                    "mousedown",
                    "1",
                    "sleep",
                    "0.2",
                    "mousemove",
                    "--sync",
                    "260",
                    "160",
                    "sleep",
                    "0.2",
                    "mousemove",
                    "--sync",
                    "850",
                    "220",
                    "sleep",
                    "0.5",
                    "mouseup",
                    "1",
                ])
                .status()
                .unwrap()
        });
        pump(&mut app, || observed.load(Ordering::SeqCst) > 0);
        assert!(drag.join().unwrap().success());
        let (group, paths) = captured
            .lock()
            .unwrap()
            .clone()
            .expect("actual OS Drop must capture original registered intent");
        assert_eq!(paths, vec![file.clone()]);
        assert_eq!(group.context, intent);
        // Tauri's built-in drag event may carry display paths, but the retained
        // CSP and absence of a raw asset/file capability must not expose bytes.
        let raw_url =
            serde_json::to_string(&format!("asset://localhost{}", file.to_str().unwrap())).unwrap();
        js(&mut app,&window,&format!("window.rawDropRead='pending';fetch({raw_url}).then(r=>{{if(!r.ok)throw Error('denied');return r.text()}}).then(()=>window.rawDropRead='read').catch(()=>window.rawDropRead='denied');'scheduled'"));
        let until = Instant::now() + Duration::from_secs(10);
        while js(&mut app, &window, "window.rawDropRead") == "pending" {
            assert!(
                Instant::now() < until,
                "raw dropped-path read denial deadline"
            );
        }
        assert_eq!(js(&mut app, &window, "window.rawDropRead"), "denied");
        let id = &group.selection_ids[0];
        let read = serde_json::json!({"leaseId":group.context.lease,"selectionId":id,"offset":0,"length":3});
        assert!(files
            .invoke("host.attachment.selection.read", &read, || owner
                .check_selection(id, &group.context.lease))
            .is_err());
        owner.accept(&group.id, &intent).unwrap();
        assert_eq!(
            files
                .invoke("host.attachment.selection.read", &read, || owner
                    .check_selection(id, &group.context.lease))
                .unwrap(),
            serde_json::json!({"data":"Zml4"})
        );
        ui.navigation_current(&window).unwrap();
        assert!(owner.check(&group, true).is_err());
        tauri::async_runtime::block_on(owner.close(&group.id, &intent)).unwrap();
        source.close();
        window.close().unwrap();
        files.close().unwrap();
        std::fs::remove_dir_all(base).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    const A: &str = "11111111-1111-4111-8111-111111111111";
    const B: &str = "22222222-2222-4222-8222-222222222222";
    const DROP: &str = "33333333-3333-4333-8333-333333333333";
    const FILE: &str = "44444444-4444-4444-8444-444444444444";
    fn context(id: &str) -> Context {
        Context {
            id: id.into(),
            lease: "ui_exact_drop_document".into(),
            epoch: "epoch-exact".into(),
        }
    }
    fn guard() -> Guard {
        Arc::new(|| Ok(()))
    }
    fn owner() -> DropOwner {
        let owner = DropOwner::default();
        owner
            .configure(Arc::new(|_| Box::pin(async { Ok(()) })))
            .unwrap();
        owner
    }
    fn capture(owner: &DropOwner, context: &Context) -> Arc<Group> {
        owner
            .capture(
                DROP.into(),
                vec![FILE.into()],
                &context.lease,
                &context.epoch,
                guard(),
            )
            .unwrap()
    }
    #[test]
    fn exact_native_only_requests_reject_path_authority_aliases_and_extra_fields() {
        use serde_json::json;
        assert!(request(
            CONTEXT,
            &json!({"contextId":A,"contextRevision":1})
        ));
        assert!(request(
            CONTEXT,
            &json!({"contextId":null,"contextRevision":2})
        ));
        for operation in [ACCEPT, CLOSE] {
            assert!(request(operation, &json!({"contextId":A,"dropId":DROP})));
            assert!(!request(
                operation,
                &json!({"contextId":A,"dropId":DROP,"path":"/etc/passwd"})
            ));
            assert!(!request(operation, &json!({"contextId":A,"dropId":null})));
        }
        for value in [
            json!({}),
            json!({"contextId":A}),
            json!({"contextId":A,"contextRevision":0}),
            json!({"contextId":A,"contextRevision":1,"taskId":"chosen"}),
            json!({"contextId":"/tmp/file","contextRevision":1}),
            json!({"contextId":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA","contextRevision":1}),
        ] {
            assert!(!request(CONTEXT, &value));
        }
    }
    #[tokio::test]
    async fn original_context_fences_capture_and_accept_before_async_retirement_ack() {
        let owner = owner();
        let a = context(A);
        let b = context(B);
        owner.register(Some(a.clone()), guard()).await.unwrap();
        let group = capture(&owner, &a);
        assert!(owner.check_selection(FILE, &a.lease).is_err());
        owner.accept(DROP, &a).unwrap();
        owner.check_selection(FILE, &a.lease).unwrap();
        let replacing = owner.register(Some(b.clone()), guard());
        assert!(owner.check(&group, false).is_err());
        assert!(owner.accept(DROP, &a).is_err());
        assert!(owner
            .capture(
                "55555555-5555-4555-8555-555555555555".into(),
                vec![FILE.into()],
                &b.lease,
                &b.epoch,
                guard()
            )
            .is_err());
        let mut replacing = Box::pin(replacing);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut replacing)
                .await
                .is_err()
        );
        group.finish_raw();
        replacing.await.unwrap();
        assert!(owner.register(Some(a), guard()).await.is_err());
        assert_eq!(owner.0.lock().unwrap().active.as_ref(), Some(&b));
    }
    #[tokio::test]
    async fn delayed_context_completion_cannot_reopen_nonce_or_cross_document() {
        let owner = owner();
        let a = context(A);
        let b = context(B);
        owner.register(Some(a.clone()), guard()).await.unwrap();
        let group = capture(&owner, &a);
        let old = owner.register(Some(b.clone()), guard());
        let newer = owner.register(None, guard());
        group.finish_raw();
        assert!(old.await.is_err());
        newer.await.unwrap();
        assert!(owner.0.lock().unwrap().active.is_none());
        assert!(owner.register(Some(b), guard()).await.is_err());
        let mut foreign = a.clone();
        foreign.lease = "ui_foreign_document".into();
        assert!(owner.close(DROP, &foreign).await.is_err());
        owner.close(DROP, &a).await.unwrap(); // exact retired receipt is idempotent
    }
    #[tokio::test]
    async fn delayed_request_arrival_cannot_replace_a_newer_context_or_null_retirement() {
        let owner = owner();
        let a = context(A);
        let b = context(B);
        owner
            .register_numbered(
                Some(b.clone()),
                guard(),
                b.epoch.clone(),
                b.lease.clone(),
                2,
            )
            .await
            .unwrap();
        assert!(owner
            .register_numbered(
                Some(a.clone()),
                guard(),
                a.epoch.clone(),
                a.lease.clone(),
                1
            )
            .await
            .is_err());
        assert_eq!(owner.0.lock().unwrap().active.as_ref(), Some(&b));
        owner
            .register_numbered(None, guard(), b.epoch.clone(), b.lease.clone(), 3)
            .await
            .unwrap();
        assert!(owner
            .register_numbered(Some(a.clone()), guard(), a.epoch, a.lease, 2)
            .await
            .is_err());
        assert!(owner.0.lock().unwrap().active.is_none());
    }
    #[tokio::test]
    async fn retirement_failure_retains_cancelled_group_and_joins_retry() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let raw = attempts.clone();
        let owner = DropOwner::default();
        owner
            .configure(Arc::new(move |_| {
                let raw = raw.clone();
                Box::pin(async move {
                    if raw.fetch_add(1, Ordering::SeqCst) == 0 {
                        Err(EngineError::new("DISCONNECTED"))
                    } else {
                        Ok(())
                    }
                })
            }))
            .unwrap();
        let a = context(A);
        owner.register(Some(a.clone()), guard()).await.unwrap();
        let group = capture(&owner, &a);
        group.finish_raw();
        assert!(owner.close(DROP, &a).await.is_err());
        assert_eq!(owner.0.lock().unwrap().groups.len(), 1);
        assert!(owner.check(&group, false).is_err());
        owner.close(DROP, &a).await.unwrap();
        owner.close(DROP, &a).await.unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert!(owner.0.lock().unwrap().groups.is_empty());
    }
    #[tokio::test]
    async fn lost_invoke_receiver_still_retires_raw_work_and_rejects_old_epoch() {
        let owner = owner();
        let a = context(A);
        owner.register(Some(a.clone()), guard()).await.unwrap();
        let group = capture(&owner, &a);
        owner.expire(group.clone());
        let newer = owner.register(None, guard());
        drop(newer);
        assert!(owner.check(&group, false).is_err());
        group.finish_raw();
        owner.shutdown().await.unwrap();
        assert!(!group.timer_active.load(Ordering::SeqCst));
        assert!(!owner.available());
        assert!(owner.register(Some(a), guard()).await.is_err());
    }
    #[tokio::test]
    async fn real_unaccepted_deadline_retires_offer_but_preserves_an_accepted_sibling() {
        let owner = owner();
        let a = context(A);
        owner.register(Some(a.clone()), guard()).await.unwrap();
        let ignored = capture(&owner, &a);
        ignored.finish_raw();
        owner.expire(ignored.clone());
        let accepted = owner
            .capture(
                "55555555-5555-4555-8555-555555555555".into(),
                vec!["66666666-6666-4666-8666-666666666666".into()],
                &a.lease,
                &a.epoch,
                guard(),
            )
            .unwrap();
        accepted.finish_raw();
        owner.expire(accepted.clone());
        owner.accept(&accepted.id, &a).unwrap();
        tokio::time::sleep(OFFER_TTL + Duration::from_millis(100)).await;
        assert!(ignored.retired.load(Ordering::SeqCst));
        assert!(owner.check(&ignored, false).is_err());
        owner.check(&accepted, true).unwrap();
        assert_eq!(owner.0.lock().unwrap().groups.len(), 1);
        owner.shutdown().await.unwrap();
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn actual_held_files_require_accept_and_close_joins_raw_capture_and_source_retirement() {
        use serde_json::json;
        use twentyonex_engine::production_attachment_selection::SelectionAuthority;
        let base = std::env::temp_dir().join(format!(
            "21x-drop-fds-{}",
            super::super::native_attachment_selection::selection_id().unwrap()
        ));
        std::fs::create_dir(&base).unwrap();
        let selected = base.join("selected.txt");
        let other = base.join("other.txt");
        std::fs::write(&selected, "abcdef").unwrap();
        std::fs::write(&other, "unrelated").unwrap();
        let files = SelectionAuthority::default();
        let owner = DropOwner::default();
        let source_ack = Arc::new(tokio::sync::Semaphore::new(0));
        let attempted = Arc::new(AtomicBool::new(false));
        let (raw_files, raw_ack, raw_attempted) =
            (files.clone(), source_ack.clone(), attempted.clone());
        owner
            .configure(Arc::new(move |group| {
                let (files, ack, attempted) =
                    (raw_files.clone(), raw_ack.clone(), raw_attempted.clone());
                Box::pin(async move {
                    attempted.store(true, Ordering::SeqCst);
                    let _ack = ack.acquire().await.unwrap();
                    for id in &group.selection_ids {
                        files.invoke(
                            "host.attachment.selection.retire",
                            &json!({"leaseId":group.context.lease,"selectionId":id}),
                            || Ok(()),
                        )?;
                    }
                    Ok(())
                })
            }))
            .unwrap();
        let a = context(A);
        owner.register(Some(a.clone()), guard()).await.unwrap();
        let group = capture(&owner, &a);
        files
            .select_scoped(
                selected.clone(),
                FILE,
                &a.lease,
                &base.join("protected-profile"),
                || owner.check(&group, false),
            )
            .unwrap();
        let unrelated = "55555555-5555-4555-8555-555555555555";
        files
            .select_scoped(
                other,
                unrelated,
                &a.lease,
                &base.join("protected-profile"),
                || Ok(()),
            )
            .unwrap();
        let read = json!({"leaseId":a.lease,"selectionId":FILE,"offset":0,"length":3});
        assert!(files
            .invoke("host.attachment.selection.read", &read, || owner
                .check_selection(FILE, &a.lease))
            .is_err());
        owner.accept(DROP, &a).unwrap();
        assert_eq!(
            files
                .invoke("host.attachment.selection.read", &read, || owner
                    .check_selection(FILE, &a.lease))
                .unwrap(),
            json!({"data":"YWJj"})
        );
        let mut closing = owner.close(DROP, &a);
        assert!(owner.check_selection(FILE, &a.lease).is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut closing)
                .await
                .is_err()
        );
        assert!(
            !attempted.load(Ordering::SeqCst),
            "Source cleanup cannot acknowledge before raw capture settles"
        );
        group.finish_raw();
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut closing)
                .await
                .is_err()
        );
        assert!(attempted.load(Ordering::SeqCst));
        assert!(std::fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(Result::ok)
            .any(|fd| std::fs::read_link(fd.path()).is_ok_and(|path| path == selected)));
        source_ack.add_permits(1);
        closing.await.unwrap();
        assert!(!std::fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(Result::ok)
            .any(|fd| std::fs::read_link(fd.path()).is_ok_and(|path| path == selected)));
        assert_eq!(
            files
                .invoke(
                    "host.attachment.selection.read",
                    &json!({"leaseId":a.lease,"selectionId":unrelated,"offset":0,"length":3}),
                    || owner.check_selection(unrelated, &a.lease)
                )
                .unwrap(),
            json!({"data":"dW5y"})
        );
        files.close().unwrap();
        std::fs::remove_dir_all(base).unwrap();
    }
}
