//! Real main-window delivery. Leases identify a document, not a renderer claim
//! or an acknowledgement that a store has applied a command.
use super::{authorize, available_engine, native_services::NativeWorkOwner};
use raw_window_handle::HasWindowHandle;
use serde_json::{json, Value};
use std::{
    collections::{hash_map::RandomState, VecDeque},
    hash::{BuildHasher, Hash, Hasher},
    sync::{Arc, Mutex},
};
use tauri::{Emitter, EventTarget, Manager, WebviewWindow};
use twentyonex_engine::{
    production::HostFuture, production_ui_contracts as contracts, EngineError,
};

pub const COMMAND_EVENT: &str = "desktop:ui-command";
pub const INSTALLER_PROGRESS_EVENT: &str = "desktop:agent-installation-progress";
const UNAVAILABLE: &str = "The current desktop document is unavailable.";

#[derive(Default)]
struct DocumentLease {
    closed: bool,
    attachment: u64,
    generation: u64,
    physical: Option<String>,
    ready: bool,
    lease: Option<(String, String)>, // opaque token, engine epoch
    loads: VecDeque<u64>,
    ambiguous_load: bool,
    retired: bool,
}
impl DocumentLease {
    fn advance(&mut self) -> Result<(), EngineError> {
        self.lease = None;
        self.ready = false;
        self.generation = self.generation.checked_add(1).ok_or_else(|| {
            self.closed = true;
            EngineError::new("DISCONNECTED")
        })?;
        Ok(())
    }
    fn reserve(&mut self) -> Result<u64, EngineError> {
        if self.closed {
            return Err(EngineError::new("DISCONNECTED"));
        }
        self.advance()?;
        self.attachment = self.attachment.checked_add(1).ok_or_else(|| {
            self.closed = true;
            EngineError::new("DISCONNECTED")
        })?;
        self.physical = None;
        self.retired = false;
        self.loads.clear();
        self.ambiguous_load = false;
        Ok(self.attachment)
    }
    fn attach(&mut self, ticket: u64, physical: &str) -> bool {
        if self.closed || self.retired || ticket != self.attachment {
            return false;
        }
        match &self.physical {
            Some(current) => current == physical,
            None => {
                self.physical = Some(physical.to_owned());
                true
            }
        }
    }
    fn navigation(&mut self, ticket: u64) -> Result<(), EngineError> {
        if !self.closed && !self.retired && ticket == self.attachment {
            self.advance()?;
        }
        Ok(())
    }
    fn started(&mut self, ticket: u64, physical: &str) -> Result<(), EngineError> {
        if !self.attach(ticket, physical) {
            return Ok(());
        }
        self.advance()?;
        // Wry does not expose navigation IDs. Do not infer a successful new
        // document from an older same-URL completion when loads overlap.
        if self.loads.is_empty() {
            self.ambiguous_load = false;
        } else {
            self.ambiguous_load = true;
        }
        if self.loads.len() >= 16 {
            self.closed = true;
            return Err(EngineError::new("BACKPRESSURE"));
        }
        self.loads.push_back(self.generation);
        Ok(())
    }
    fn finished(&mut self, ticket: u64, physical: &str) {
        if !self.attach(ticket, physical) {
            return;
        }
        if let Some(started) = self.loads.pop_front() {
            self.ready =
                !self.ambiguous_load && started == self.generation && self.loads.is_empty();
        }
    }
    fn destroy(&mut self, ticket: u64, physical: &str) -> Result<(), EngineError> {
        if ticket == self.attachment && self.physical.as_deref() == Some(physical) {
            self.advance()?;
            self.physical = None;
            self.retired = true;
            self.loads.clear();
        }
        Ok(())
    }
    fn usable(&self, physical: &str, visible_and_trusted: bool) -> bool {
        !self.closed
            && !self.retired
            && self.ready
            && visible_and_trusted
            && self.physical.as_deref() == Some(physical)
    }
    fn activate(&mut self, physical: &str, epoch: &str, usable: bool) -> Option<String> {
        if !self.usable(physical, usable) {
            return None;
        }
        if self
            .lease
            .as_ref()
            .is_none_or(|(_, current)| current != epoch)
        {
            // RandomState carries private OS-seeded keys. These are opaque
            // document identities; no paths or general host grants are encoded.
            let mut a = RandomState::new().build_hasher();
            let mut b = RandomState::new().build_hasher();
            (self.attachment, self.generation, epoch).hash(&mut a);
            (epoch, self.generation, self.attachment).hash(&mut b);
            self.lease = Some((
                format!("ui_{:016x}{:016x}", a.finish(), b.finish()),
                epoch.to_owned(),
            ));
        }
        self.lease.as_ref().map(|(lease, _)| lease.clone())
    }
    fn current(
        &self,
        physical: &str,
        epoch: &str,
        token: Option<&str>,
        usable: bool,
    ) -> Option<String> {
        if !self.usable(physical, usable) {
            return None;
        }
        self.lease
            .as_ref()
            .filter(|(lease, current)| current == epoch && token.is_none_or(|token| token == lease))
            .map(|(lease, _)| lease.clone())
    }
    fn close(&mut self) {
        self.closed = true;
        self.ready = false;
        self.lease = None;
    }
}

#[derive(Clone)]
struct PhysicalWindow {
    window: WebviewWindow,
    key: String,
    ticket: u64,
}
#[derive(Default)]
struct UiState {
    document: DocumentLease,
    window: Option<PhysicalWindow>,
}
impl UiState {
    fn matches(&self, captured: &PhysicalWindow) -> bool {
        self.document.attachment == captured.ticket
            && self.window.as_ref().is_some_and(|window| {
                window.ticket == captured.ticket && window.key == captured.key
            })
    }
}
/// In-memory fence for a callback already dispatched to the captured WebView.
/// Querying Tauri getters from inside with_webview re-enters its dispatch lock.
#[cfg(target_os = "linux")]
pub(super) struct NativeWindowAction {
    ticket: u64,
    generation: u64,
    key: String,
}
#[derive(Clone, Default)]
pub struct NativeUiOwner(Arc<Mutex<UiState>>);

fn physical_key(window: &WebviewWindow) -> Result<String, EngineError> {
    // WebviewWindow::eq compares labels only. Capture the actual native handle
    // plus our attachment ticket so a destroyed/reused label cannot inherit it.
    window
        .window_handle()
        .map(|handle| format!("{:?}", handle.as_raw()))
        .map_err(|_| EngineError::new("DISCONNECTED"))
}
impl NativeUiOwner {
    /// App-owned native actions need the actual current physical window even
    /// when the Source service has failed; they do not mint a document lease.
    pub fn assert_window(&self, window: &WebviewWindow) -> Result<(), EngineError> {
        authorize(window)?;
        let key = physical_key(window)?;
        let captured = {
            let state = self
                .0
                .lock()
                .map_err(|_| EngineError::new("DISCONNECTED"))?;
            if state.document.closed {
                return Err(EngineError::new("DISCONNECTED"));
            }
            state
                .window
                .clone()
                .ok_or_else(|| EngineError::new("DISCONNECTED"))?
        };
        if captured.key != key {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        let actual = window
            .app_handle()
            .get_webview_window("main")
            .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
        authorize(&actual)?;
        if physical_key(&actual)? != key {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        let state = self
            .0
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        if state.document.closed || !state.matches(&captured) {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        Ok(())
    }
    #[cfg(target_os = "linux")]
    pub(super) fn capture_window_action(
        &self,
        window: &WebviewWindow,
    ) -> Result<NativeWindowAction, EngineError> {
        self.assert_window(window)?;
        let key = physical_key(window)?;
        let state = self
            .0
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        let captured = state
            .window
            .as_ref()
            .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
        if captured.key != key
            || !state.matches(captured)
            || state.document.closed
            || state.document.retired
        {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        Ok(NativeWindowAction {
            ticket: captured.ticket,
            generation: state.document.generation,
            key,
        })
    }
    #[cfg(target_os = "linux")]
    pub(super) fn assert_window_action(
        &self,
        action: &NativeWindowAction,
    ) -> Result<(), EngineError> {
        let state = self
            .0
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        if state.document.closed
            || state.document.retired
            || state.document.attachment != action.ticket
            || state.document.generation != action.generation
            || state.document.physical.as_deref() != Some(action.key.as_str())
            || !state.window.as_ref().is_some_and(|window| {
                state.matches(window) && window.key == action.key && window.ticket == action.ticket
            })
        {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        Ok(())
    }
    pub fn reserve_window(&self) -> Result<u64, EngineError> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        let ticket = state.document.reserve()?;
        state.window = None;
        Ok(ticket)
    }
    pub fn attach_window(&self, ticket: u64, window: &WebviewWindow) -> Result<(), EngineError> {
        authorize(window)?;
        let key = physical_key(window)?;
        let mut state = self
            .0
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        if !state.document.attach(ticket, &key) {
            return Err(EngineError::new("DISCONNECTED"));
        }
        state.window = Some(PhysicalWindow {
            window: window.clone(),
            key,
            ticket,
        });
        Ok(())
    }
    #[cfg(test)]
    pub(super) fn completed_document_for_test(&self, window: &WebviewWindow) -> bool {
        let Ok(key) = physical_key(window) else {
            return false;
        };
        let Ok(state) = self.0.lock() else {
            return false;
        };
        state.document.usable(&key, true)
            && state
                .window
                .as_ref()
                .is_some_and(|captured| state.matches(captured))
    }
    /// App-owned reload invalidates before dispatch, including the interval
    /// before the next page-load event.
    pub fn navigation_current(&self, window: &WebviewWindow) -> Result<(), EngineError> {
        self.assert_window(window)?;
        let key = physical_key(window)?;
        let mut state = self
            .0
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        let captured = state
            .window
            .clone()
            .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
        if captured.key != key || !state.matches(&captured) {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        state.document.navigation(captured.ticket)
    }
    pub fn navigation(&self, ticket: u64) -> Result<(), EngineError> {
        self.0
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?
            .document
            .navigation(ticket)
    }
    pub fn page_finished(&self, ticket: u64, window: &WebviewWindow) -> Result<(), EngineError> {
        self.attach_window(ticket, window)?;
        let key = physical_key(window)?;
        self.0
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?
            .document
            .finished(ticket, &key);
        Ok(())
    }
    pub fn page_started(&self, ticket: u64, window: &WebviewWindow) -> Result<(), EngineError> {
        self.attach_window(ticket, window)?;
        let key = physical_key(window)?;
        self.0
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?
            .document
            .started(ticket, &key)
    }
    pub fn destroyed(&self, ticket: u64, key: &str) -> Result<(), EngineError> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        state.document.destroy(ticket, key)?;
        if state
            .window
            .as_ref()
            .is_some_and(|window| window.ticket == ticket && window.key == key)
        {
            state.window = None;
        }
        Ok(())
    }
    pub fn watch_destroy(&self, ticket: u64, window: &WebviewWindow) -> Result<(), EngineError> {
        let owner = self.clone();
        let key = physical_key(window)?;
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let _ = owner.destroyed(ticket, &key);
            }
        });
        Ok(())
    }
    pub fn close(&self) -> Result<(), EngineError> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        state.document.close();
        state.window = None;
        Ok(())
    }
    fn captured(&self, app: &tauri::AppHandle, epoch: &str) -> Result<PhysicalWindow, EngineError> {
        let captured = self
            .0
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?
            .window
            .clone()
            .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
        let current = app
            .get_webview_window("main")
            .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
        authorize(&captured.window)?;
        authorize(&current)?;
        if physical_key(&captured.window)? != captured.key
            || physical_key(&current)? != captured.key
            || !captured
                .window
                .is_visible()
                .map_err(|_| EngineError::new("DISCONNECTED"))?
        {
            return Err(EngineError::new("DISCONNECTED"));
        }
        available_engine(app, Some(epoch))?;
        Ok(captured)
    }
    /// Only trusted bootstrap activates a completed document. Host snapshots
    /// and command/publish calls never silently mint a replacement receipt.
    pub fn activate(&self, window: &WebviewWindow, epoch: &str) -> Option<String> {
        let captured = self.captured(window.app_handle(), epoch).ok()?;
        if physical_key(window).ok()? != captured.key {
            return None;
        }
        let mut state = self.0.lock().ok()?;
        if !state.matches(&captured) {
            return None;
        }
        state.document.activate(&captured.key, epoch, true)
    }
    pub fn assert_publish(
        &self,
        window: &WebviewWindow,
        epoch: &str,
        lease: &str,
    ) -> Result<(), EngineError> {
        if !contracts::lease_id(&json!(lease)) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        let captured = self.captured(window.app_handle(), epoch)?;
        if physical_key(window)? != captured.key {
            return Err(EngineError::new("UNAUTHORIZED"));
        }
        let state = self
            .0
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        if !state.matches(&captured)
            || state
                .document
                .current(&captured.key, epoch, Some(lease), true)
                .is_none()
        {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        Ok(())
    }
    fn snapshot(&self, app: &tauri::AppHandle, epoch: &str) -> Result<Value, EngineError> {
        let Ok(captured) = self.captured(app, epoch) else {
            return Ok(json!({"available":false}));
        };
        let state = self
            .0
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        if !state.matches(&captured) {
            return Ok(json!({"available":false}));
        }
        Ok(
            match state.document.current(&captured.key, epoch, None, true) {
                Some(lease) => json!({"available":true,"leaseId":lease}),
                None => json!({"available":false}),
            },
        )
    }
    fn send(
        &self,
        app: &tauri::AppHandle,
        command: Value,
        lease: &str,
        epoch: &str,
    ) -> Result<Value, EngineError> {
        if !contracts::command(&command) || !contracts::lease_id(&json!(lease)) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        let Ok(captured) = self.captured(app, epoch) else {
            return Ok(json!({"ok":false,"detail":UNAVAILABLE}));
        };
        // Hold the document fence through acceptance. Navigation/destruction
        // cannot rotate this owned generation in the middle of this emit.
        let state = self
            .0
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        if !state.matches(&captured)
            || state
                .document
                .current(&captured.key, epoch, Some(lease), true)
                .is_none()
        {
            return Ok(json!({"ok":false,"detail":UNAVAILABLE}));
        }
        captured
            .window
            .emit_to(
                EventTarget::WebviewWindow {
                    label: "main".into(),
                },
                COMMAND_EVENT,
                json!({"engineEpoch":epoch,"leaseId":lease,"command":command}),
            )
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        Ok(json!({"ok":true,"leaseId":lease}))
    }
    fn installer_progress(
        &self,
        app: &tauri::AppHandle,
        progress: Value,
        lease: &str,
        epoch: &str,
    ) -> Result<Value, EngineError> {
        if !twentyonex_engine::production::contracts::agent_installer::progress(&progress)
            || !contracts::lease_id(&json!(lease))
        {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        let Ok(captured) = self.captured(app, epoch) else {
            return Ok(json!({"ok":false,"detail":UNAVAILABLE}));
        };
        // This is the same captured physical document as the installation
        // request. A replacement main label never inherits its progress.
        let state = self
            .0
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        if !state.matches(&captured)
            || state
                .document
                .current(&captured.key, epoch, Some(lease), true)
                .is_none()
        {
            return Ok(json!({"ok":false,"detail":UNAVAILABLE}));
        }
        captured
            .window
            .emit_to(
                EventTarget::WebviewWindow {
                    label: "main".into(),
                },
                INSTALLER_PROGRESS_EVENT,
                json!({"engineEpoch":epoch,"leaseId":lease,"progress":progress}),
            )
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        Ok(json!({"ok":true,"leaseId":lease}))
    }
    pub fn installer_progress_callback(
        &self,
        app: tauri::AppHandle,
        work: NativeWorkOwner,
    ) -> Arc<dyn Fn(Value, String, String) -> HostFuture<Value> + Send + Sync> {
        let owner = self.clone();
        Arc::new(move |progress, lease, epoch| {
            let (owner, app, work) = (owner.clone(), app.clone(), work.clone());
            Box::pin(async move {
                owned_result(work, move || {
                    owner.installer_progress(&app, progress, &lease, &epoch)
                })
                .await
            })
        })
    }
    pub fn snapshot_callback(
        &self,
        app: tauri::AppHandle,
        work: NativeWorkOwner,
    ) -> Arc<dyn Fn(String) -> HostFuture<Value> + Send + Sync> {
        let owner = self.clone();
        Arc::new(move |epoch| {
            let (owner, app, work) = (owner.clone(), app.clone(), work.clone());
            Box::pin(async move { owned_result(work, move || owner.snapshot(&app, &epoch)).await })
        })
    }
    pub fn command_callback(
        &self,
        app: tauri::AppHandle,
        work: NativeWorkOwner,
    ) -> Arc<dyn Fn(Value, String, String) -> HostFuture<Value> + Send + Sync> {
        let owner = self.clone();
        Arc::new(move |command, lease, epoch| {
            let (owner, app, work) = (owner.clone(), app.clone(), work.clone());
            Box::pin(async move {
                owned_result(work, move || owner.send(&app, command, &lease, &epoch)).await
            })
        })
    }
}

async fn owned_result(
    work: NativeWorkOwner,
    effect: impl FnOnce() -> Result<Value, EngineError> + Send + 'static,
) -> Result<Value, EngineError> {
    let result = Arc::new(Mutex::new(None));
    let captured = result.clone();
    work.run(move || {
        let value = effect()?;
        *captured
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))? = Some(value);
        Ok(())
    })
    .await?;
    let value = result
        .lock()
        .map_err(|_| EngineError::new("DISCONNECTED"))?
        .take()
        .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ready() -> (DocumentLease, u64) {
        let mut document = DocumentLease::default();
        let ticket = document.reserve().unwrap();
        document.started(ticket, "physical-A").unwrap();
        document.finished(ticket, "physical-A");
        (document, ticket)
    }
    #[test]
    fn bootstrap_only_activation_is_stable_and_reload_revokes_old_document() {
        let (mut document, ticket) = ready();
        assert!(document
            .current("physical-A", "epoch", None, true)
            .is_none());
        let old = document.activate("physical-A", "epoch", true).unwrap();
        assert!(contracts::lease_id(&json!(old)));
        assert_eq!(
            document.activate("physical-A", "epoch", true),
            Some(old.clone())
        );
        document.navigation(ticket).unwrap();
        assert!(document
            .current("physical-A", "epoch", Some(&old), true)
            .is_none());
        assert!(document.activate("physical-A", "epoch", true).is_none());
        document.started(ticket, "physical-A").unwrap();
        document.finished(ticket, "physical-A");
        let next = document.activate("physical-A", "epoch", true).unwrap();
        assert_ne!(old, next);
        assert!(document
            .current("physical-A", "epoch", Some(&old), true)
            .is_none());
        assert_eq!(
            document.current("physical-A", "epoch", Some(&next), true),
            Some(next)
        );
    }
    #[test]
    fn hidden_untrusted_physical_replacement_and_new_epoch_never_inherit_authority() {
        let (mut document, _) = ready();
        let old = document.activate("physical-A", "epoch", true).unwrap();
        assert!(document
            .current("physical-A", "epoch", Some(&old), false)
            .is_none());
        assert!(document
            .current("physical-B", "epoch", Some(&old), true)
            .is_none());
        assert!(document
            .current("physical-A", "new-epoch", Some(&old), true)
            .is_none());
        let next = document.activate("physical-A", "new-epoch", true).unwrap();
        assert_ne!(old, next);
        assert!(document
            .current("physical-A", "epoch", Some(&old), true)
            .is_none());
        document.close();
        assert!(document
            .current("physical-A", "new-epoch", Some(&next), true)
            .is_none());
        assert!(document.reserve().is_err());
    }
    #[test]
    fn late_destroy_and_page_events_cannot_retire_or_activate_reused_main_label() {
        let (mut document, old_ticket) = ready();
        let old = document.activate("physical-A", "epoch", true).unwrap();
        document.destroy(old_ticket, "physical-A").unwrap();
        document.finished(old_ticket, "physical-A");
        document.started(old_ticket, "physical-A").unwrap();
        assert!(document.activate("physical-A", "epoch", true).is_none());
        let ticket = document.reserve().unwrap();
        // Even an OS handle reuse has a separate native attachment ticket.
        document.started(ticket, "physical-A").unwrap();
        document.finished(ticket, "physical-A");
        let next = document.activate("physical-A", "epoch", true).unwrap();
        document.navigation(old_ticket).unwrap();
        document.destroy(old_ticket, "physical-A").unwrap();
        document.finished(old_ticket, "physical-B");
        assert_eq!(
            document.current("physical-A", "epoch", Some(&next), true),
            Some(next)
        );
        assert!(document
            .current("physical-A", "epoch", Some(&old), true)
            .is_none());
        assert!(!document.attach(ticket, "physical-B"));
    }
    #[test]
    fn same_url_overlapping_completions_are_unavailable_until_an_unambiguous_load() {
        let (mut document, ticket) = ready();
        let old = document.activate("physical-A", "epoch", true).unwrap();
        document.navigation(ticket).unwrap();
        document.started(ticket, "physical-A").unwrap();
        // New navigation accepted before the old load has completed.
        document.navigation(ticket).unwrap();
        document.finished(ticket, "physical-A");
        assert!(document.activate("physical-A", "epoch", true).is_none());
        document.started(ticket, "physical-A").unwrap();
        document.started(ticket, "physical-A").unwrap();
        document.finished(ticket, "physical-A");
        document.finished(ticket, "physical-A");
        assert!(document.activate("physical-A", "epoch", true).is_none());
        document.started(ticket, "physical-A").unwrap();
        document.finished(ticket, "physical-A");
        let next = document.activate("physical-A", "epoch", true).unwrap();
        assert_ne!(old, next);
    }
    #[test]
    fn no_completion_without_start_and_generation_exhaustion_grants_nothing() {
        let mut document = DocumentLease::default();
        let ticket = document.reserve().unwrap();
        document.finished(ticket, "physical-A");
        assert!(document.activate("physical-A", "epoch", true).is_none());
        document.generation = u64::MAX;
        assert!(document.started(ticket, "physical-A").is_err());
        assert!(document.activate("physical-A", "epoch", true).is_none());
        assert!(document.reserve().is_err());
    }
    #[tokio::test]
    async fn public_callback_abort_cannot_release_raw_emit_receipt_or_shutdown() {
        let work = NativeWorkOwner::default();
        let (entered, started) = tokio::sync::oneshot::channel();
        let (release, held) = std::sync::mpsc::channel();
        let owned = work.clone();
        let public = tokio::spawn(async move {
            owned_result(owned, move || {
                let _ = entered.send(());
                held.recv().unwrap();
                Ok(json!({"ok":true,"leaseId":"ui_fixture"}))
            })
            .await
        });
        started.await.unwrap();
        public.abort();
        assert_eq!(work.active().unwrap(), 1);
        let drain_owner = work.clone();
        let drain = tokio::spawn(async move { drain_owner.drain().await });
        tokio::task::yield_now().await;
        assert!(!drain.is_finished());
        release.send(()).unwrap();
        drain.await.unwrap().unwrap();
        assert_eq!(work.active().unwrap(), 0);
    }
    #[tokio::test]
    async fn installer_progress_cancelled_waiter_retains_raw_work_and_rechecks_reload_before_emit()
    {
        use std::sync::atomic::{AtomicU64, Ordering};
        let (mut document, ticket) = ready();
        let lease = document.activate("physical-A", "epoch", true).unwrap();
        let document = Arc::new(Mutex::new(document));
        let captured = document.clone();
        let emitted = Arc::new(AtomicU64::new(0));
        let emissions = emitted.clone();
        let work = NativeWorkOwner::default();
        let owned = work.clone();
        let (entered, started) = tokio::sync::oneshot::channel();
        let (release, held) = std::sync::mpsc::channel();
        let progress = json!({"agentName":"codex","stage":"installing","output":"Installing the selected CLI.","percent":50});
        assert!(twentyonex_engine::production::contracts::agent_installer::progress(&progress));
        let public = tokio::spawn(async move {
            owned_result(owned, move || {
                let _ = entered.send(());
                held.recv().unwrap();
                let document = captured.lock().unwrap();
                if document
                    .current("physical-A", "epoch", Some(&lease), true)
                    .is_none()
                {
                    return Ok(json!({"ok":false,"detail":UNAVAILABLE}));
                }
                // Controlled external boundary: physical delivery is tested by
                // the native host fixture; this tests its retained lease fence.
                emissions.fetch_add(1, Ordering::SeqCst);
                Ok(json!({"ok":true,"leaseId":lease}))
            })
            .await
        });
        started.await.unwrap();
        public.abort();
        assert_eq!(work.active().unwrap(), 1);
        document.lock().unwrap().navigation(ticket).unwrap();
        let drain_owner = work.clone();
        let drain = tokio::spawn(async move { drain_owner.drain().await });
        tokio::task::yield_now().await;
        assert!(!drain.is_finished());
        release.send(()).unwrap();
        drain.await.unwrap().unwrap();
        assert_eq!(work.active().unwrap(), 0);
        assert_eq!(emitted.load(Ordering::SeqCst), 0);
        assert_ne!(INSTALLER_PROGRESS_EVENT, COMMAND_EVENT);
        assert_ne!(INSTALLER_PROGRESS_EVENT, "desktop:event");
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn attachment_raw_open_receipt_holds_descriptors_and_drain_after_public_abort_and_reload()
    {
        use std::{
            fs,
            os::unix::fs::MetadataExt,
            path::Path,
            sync::atomic::{AtomicU64, Ordering},
        };
        use twentyonex_engine::production_attachment_files::{
            NativeAttachmentFileOwner, NativeAttachmentReceipt,
        };
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "21x-native-attachment-drain-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir(&base).unwrap();
        let base = fs::canonicalize(base).unwrap();
        let root = base.join("attachments");
        let task = root.join("task_1");
        fs::create_dir_all(&task).unwrap();
        let id = "61f07006-c85b-438e-83a7-497c77b0dcae";
        let path = task.join(format!("{id}-public.txt"));
        fs::write(&path, b"public").unwrap();
        let identity = |path: &Path| {
            let m = fs::symlink_metadata(path).unwrap();
            json!({"path":path.to_str().unwrap(),"dev":m.dev().to_string(),"ino":m.ino().to_string(),"kind":if m.is_dir(){"directory"}else{"file"},"size":m.size().to_string(),"nlink":m.nlink().to_string()})
        };
        let receipt=NativeAttachmentReceipt::from_value(&json!({"version":1,"taskId":"task_1","attachmentId":id,"filename":"public.txt","attachmentRoot":root.to_str().unwrap(),"path":path.to_str().unwrap(),"root":identity(&root),"ancestors":[identity(&task)],"target":identity(&path)})).unwrap();
        let owner = NativeAttachmentFileOwner::open(root).unwrap();
        let guard = owner.validate(&receipt).unwrap();
        drop(owner);
        let (mut document, ticket) = ready();
        let lease = document.activate("physical-A", "epoch", true).unwrap();
        let document = Arc::new(Mutex::new(document));
        let captured = document.clone();
        let work = NativeWorkOwner::default();
        let raw = work.clone();
        let effects = Arc::new(AtomicU64::new(0));
        let accepted = effects.clone();
        let (entered, started) = tokio::sync::oneshot::channel();
        let (release, held) = std::sync::mpsc::channel();
        let public = tokio::spawn(async move {
            raw.run(move || {
                let _ = entered.send(());
                held.recv().unwrap();
                guard.recheck()?;
                let document = captured.lock().unwrap();
                if document
                    .current("physical-A", "epoch", Some(&lease), true)
                    .is_none()
                {
                    return Err(EngineError::new("STALE_EPOCH"));
                }
                // Controlled OS boundary: revoked documents never reach it.
                accepted.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await
        });
        started.await.unwrap();
        public.abort();
        assert_eq!(work.active().unwrap(), 1);
        document.lock().unwrap().navigation(ticket).unwrap();
        let drain_owner = work.clone();
        let drain = tokio::spawn(async move { drain_owner.drain().await });
        tokio::task::yield_now().await;
        assert!(!drain.is_finished());
        release.send(()).unwrap();
        drain.await.unwrap().unwrap();
        assert_eq!(work.active().unwrap(), 0);
        assert_eq!(effects.load(Ordering::SeqCst), 0);
        assert_eq!(fs::read(&path).unwrap(), b"public");
        fs::remove_dir_all(base).unwrap();
    }
    #[tokio::test]
    async fn callback_rechecks_document_after_queued_raw_work_and_never_claims_applied() {
        let (mut document, ticket) = ready();
        let lease = document.activate("physical-A", "epoch", true).unwrap();
        let document = Arc::new(Mutex::new(document));
        let captured = document.clone();
        let work = NativeWorkOwner::default();
        let (entered, started) = tokio::sync::oneshot::channel();
        let (release, held) = std::sync::mpsc::channel();
        let result = tokio::spawn(async move {
            owned_result(work, move || {
                let _ = entered.send(());
                held.recv().unwrap();
                let current =
                    captured
                        .lock()
                        .unwrap()
                        .current("physical-A", "epoch", Some(&lease), true);
                Ok(if current.is_some() {
                    json!({"ok":true,"leaseId":lease})
                } else {
                    json!({"ok":false,"detail":UNAVAILABLE})
                })
            })
            .await
        });
        started.await.unwrap();
        document.lock().unwrap().navigation(ticket).unwrap();
        release.send(()).unwrap();
        let response = result.await.unwrap().unwrap();
        assert_eq!(response, json!({"ok":false,"detail":UNAVAILABLE}));
        assert!(contracts::command_result(&response));
        assert!(!contracts::command_result(
            &json!({"ok":true,"leaseId":"ui_fixture","applied":true})
        ));
    }
}
