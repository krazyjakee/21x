//! Linux URI-list handoff. The source FD is metadata-only; external paste and
//! subsequent file lifetime are outside this handoff's authority guarantee.
use super::{native_services::NativeWorkOwner, production_ui::NativeUiOwner};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::Manager;
use twentyonex_engine::{
    production::{HostFuture, ProductionArtifactClipboardHost},
    production_files::{NativeWorkspaceFileOwner, NativeWorkspaceReceipt},
    EngineError,
};

type Scope = Arc<dyn Fn() -> Result<(), EngineError> + Send + Sync>;
const MAX_BYTES: u64 = 64 * 1024 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(1);
fn clear_if_current<T: PartialEq>(expected: &T, current: Option<&T>, clear: impl FnOnce()) -> bool {
    if current == Some(expected) {
        clear();
        true
    } else {
        false
    }
}
fn uri_list(path: &Path) -> Result<Vec<u8>, EngineError> {
    let text = path
        .to_str()
        .filter(|s| s.starts_with('/') && s.len() <= 4096 && !s.contains('\0'))
        .ok_or_else(|| EngineError::new("INVALID_ARGUMENTS"))?;
    let mut result = String::from("file://");
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.' | b'~') {
            result.push(byte as char);
        } else {
            result.push('%');
            result.push(HEX[(byte >> 4) as usize] as char);
            result.push(HEX[(byte & 15) as usize] as char);
        }
    }
    result.push_str("\r\n");
    Ok(result.into_bytes())
}
struct Active(Arc<AtomicBool>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
struct PublicationRequest {
    scope: Scope,
    bytes: Vec<u8>,
    reply: std::sync::mpsc::Sender<Result<bool, EngineError>>,
    _lifetime: std::sync::mpsc::Sender<()>,
}
impl Drop for PublicationRequest {
    fn drop(&mut self) {}
}
async fn retained_copy(
    work: NativeWorkOwner,
    owner: Arc<NativeWorkspaceFileOwner>,
    receipt: NativeWorkspaceReceipt,
    current: Scope,
    source_current: Scope,
    schedule: impl FnOnce(PublicationRequest) -> Result<(), EngineError> + Send + 'static,
) -> Result<Value, EngineError> {
    let active = Arc::new(AtomicBool::new(true));
    let _active = Active(active.clone());
    let scope: Scope = Arc::new(move || {
        if !active.load(Ordering::SeqCst) {
            return Err(EngineError::new("CANCELLED"));
        }
        current()
    });
    let output = Arc::new(Mutex::new(None));
    let stored = output.clone();
    work.run(move || {
        scope()?;
        let guard = owner.validate(&receipt)?;
        guard.assert_clipboard_file(MAX_BYTES)?;
        let bytes = uri_list(guard.path())?;
        // This authorization RPC runs only on this owned blocking worker.
        source_current()?;
        scope()?;
        guard.assert_clipboard_file(MAX_BYTES)?;
        let (reply, response) = std::sync::mpsc::channel();
        let (lifetime, retired) = std::sync::mpsc::channel::<()>();
        let scheduled = schedule(PublicationRequest {
            scope: scope.clone(),
            bytes,
            reply,
            _lifetime: lifetime,
        });
        let answer = response.recv();
        // Reply is not retirement of the actual GTK closure and its captures.
        while retired.recv().is_ok() {}
        scheduled?;
        let available = answer.map_err(|_| EngineError::new("DISCONNECTED"))??;
        scope()?;
        source_current()?;
        guard.assert_clipboard_file(MAX_BYTES)?;
        *stored
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))? =
            Some(json!({"mode":if available{"file"}else{"unavailable"}}));
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

pub fn host(
    app: &tauri::AppHandle,
    work: NativeWorkOwner,
    ui: NativeUiOwner,
    workspace_root: PathBuf,
) -> Result<Option<ProductionArtifactClipboardHost>, EngineError> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, work, ui, workspace_root);
        Ok(None)
    }
    #[cfg(target_os = "linux")]
    {
        let slot = Arc::new(Mutex::new(Some(Arc::new(NativeWorkspaceFileOwner::open(
            workspace_root,
        )?))));
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let captured = slot.clone();
        let app = app.clone();
        let close_app = app.clone();
        let drain = work.clone();
        Ok(Some(ProductionArtifactClipboardHost {
            invoke: Arc::new(
                move |receipt: Value,
                      lease: String,
                      epoch: String,
                      authorization_id: String|
                      -> HostFuture<Value> {
                    let (app, work, ui, slot) =
                        (app.clone(), work.clone(), ui.clone(), captured.clone());
                    Box::pin(async move {
                        let window = app
                            .get_webview_window("main")
                            .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
                        ui.assert_publish(&window, &epoch, &lease)?;
                        let engine = super::available_engine(&app, Some(&epoch))?;
                        let receipt = NativeWorkspaceReceipt::from_value(&receipt)
                            .map_err(|_| EngineError::new("INVALID_ARGUMENTS"))?;
                        let owner = slot
                            .lock()
                            .map_err(|_| EngineError::new("DISCONNECTED"))?
                            .as_ref()
                            .cloned()
                            .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
                        let guard_work = work.clone();
                        let source_epoch = epoch.clone();
                        let current: Scope = Arc::new(move || {
                            guard_work.assert_open()?;
                            ui.assert_publish(&window, &epoch, &lease)
                        });
                        let source_ui = current.clone();
                        let source_current: Scope = Arc::new(move || {
                            source_ui()?;
                            tauri::async_runtime::block_on(
                                engine.check_artifact_copy(&source_epoch, &authorization_id),
                            )?;
                            source_ui()
                        });
                        let public = retained_copy(
                            work,
                            owner,
                            receipt,
                            current,
                            source_current,
                            move |request| {
                                app.run_on_main_thread(move || gtk_owner::publish(id, request))
                                    .map_err(|_| EngineError::new("DISCONNECTED"))
                            },
                        );
                        tokio::time::timeout(std::time::Duration::from_secs(5), public)
                            .await
                            .map_err(|_| EngineError::new("TIMEOUT"))?
                    })
                },
            ),
            close: Arc::new(move || {
                let (work, slot, app) = (drain.clone(), slot.clone(), close_app.clone());
                Box::pin(async move {
                    work.drain().await?;
                    let (reply, response) = tokio::sync::oneshot::channel();
                    app.run_on_main_thread(move || {
                        let _ = reply.send(gtk_owner::clear(id));
                    })
                    .map_err(|_| EngineError::new("DISCONNECTED"))?;
                    let retired = response
                        .await
                        .map_err(|_| EngineError::new("DISCONNECTED"))??;
                    // Clear callback payload retirement is separately acknowledged.
                    tauri::async_runtime::spawn_blocking(move || while retired.recv().is_ok() {})
                        .await
                        .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
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

#[cfg(target_os = "linux")]
mod gtk_owner {
    use super::*;
    use gtk::gdk;
    use gtk::{
        glib::{self, translate::*},
        prelude::*,
    };
    use std::{
        cell::RefCell,
        collections::HashMap,
        panic::{catch_unwind, AssertUnwindSafe},
    };
    struct Payload {
        bytes: Vec<u8>,
        _retired: std::sync::mpsc::Sender<()>,
    }
    struct Owned {
        token: glib::Object,
        clipboard: gtk::Clipboard,
        retired: std::sync::mpsc::Receiver<()>,
    }
    thread_local! {static OWNED:RefCell<HashMap<u64,Owned>>=RefCell::new(HashMap::new());}
    fn key() -> glib::Quark {
        glib::Quark::from_str("21x-owned-artifact-uri-v1")
    }
    unsafe extern "C" fn get(
        _clipboard: *mut gtk::ffi::GtkClipboard,
        selection: *mut gtk::ffi::GtkSelectionData,
        _info: u32,
        owner: glib::ffi::gpointer,
    ) {
        // Fixed bytes only. Paste callbacks have no filesystem, RPC or caller scope.
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let token: glib::translate::Borrowed<glib::Object> =
                unsafe { from_glib_borrow(owner as *mut glib::gobject_ffi::GObject) };
            if let Some(payload) = unsafe { token.qdata::<Payload>(key()) } {
                let data = unsafe { payload.as_ref() };
                unsafe {
                    gtk::ffi::gtk_selection_data_set(
                        selection,
                        gdk::Atom::intern("text/uri-list").to_glib_none().0,
                        8,
                        data.bytes.as_ptr(),
                        data.bytes.len() as i32,
                    )
                };
            }
        }));
    }
    unsafe extern "C" fn release(
        _clipboard: *mut gtk::ffi::GtkClipboard,
        owner: glib::ffi::gpointer,
    ) {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let token: glib::translate::Borrowed<glib::Object> =
                unsafe { from_glib_borrow(owner as *mut glib::gobject_ffi::GObject) };
            drop(unsafe { token.steal_qdata::<Payload>(key()) });
        }));
    }
    fn clear_owned(owned: Owned) -> Result<std::sync::mpsc::Receiver<()>, EngineError> {
        clear_if_current(&owned.token, owned.clipboard.owner().as_ref(), || {
            owned.clipboard.clear()
        });
        // Never clear another application's selection. If GTK no longer owns our
        // token its clear callback already retired the payload; token Drop joins it.
        let Owned {
            token,
            clipboard,
            retired,
        } = owned;
        drop(clipboard);
        drop(token);
        Ok(retired)
    }
    pub(super) fn clear(id: u64) -> Result<std::sync::mpsc::Receiver<()>, EngineError> {
        let owned = OWNED.with(|owners| owners.borrow_mut().remove(&id));
        match owned {
            Some(owned) => clear_owned(owned),
            None => {
                let (sender, receiver) = std::sync::mpsc::channel();
                drop(sender);
                Ok(receiver)
            }
        }
    }
    pub(super) fn publish(id: u64, request: PublicationRequest) {
        let answer = catch_unwind(AssertUnwindSafe(|| -> Result<bool, EngineError> {
            (request.scope)()?;
            let Some(display) = gdk::Display::default() else {
                return Ok(false);
            };
            let Some(clipboard) = gtk::Clipboard::default(&display) else {
                return Ok(false);
            };
            let old = OWNED.with(|owners| owners.borrow_mut().remove(&id));
            if let Some(old) = old {
                drop(clear_owned(old)?);
            }
            let token: glib::Object = glib::Object::new();
            let (sender, retired) = std::sync::mpsc::channel();
            unsafe {
                token.set_qdata(
                    key(),
                    Payload {
                        bytes: request.bytes.clone(),
                        _retired: sender,
                    },
                );
            }
            (request.scope)()?; // exact document/lifecycle check immediately before GTK effect
            let target = gtk::ffi::GtkTargetEntry {
                target: b"text/uri-list\0".as_ptr() as *mut _,
                flags: 0,
                info: 0,
            };
            let accepted: bool = unsafe {
                from_glib(gtk::ffi::gtk_clipboard_set_with_owner(
                    clipboard.to_glib_none().0,
                    &target,
                    1,
                    Some(get),
                    Some(release),
                    token.to_glib_none().0,
                ))
            };
            if !accepted {
                drop(unsafe { token.steal_qdata::<Payload>(key()) });
                return Ok(false);
            }
            OWNED.with(|owners| {
                owners.borrow_mut().insert(
                    id,
                    Owned {
                        token,
                        clipboard,
                        retired,
                    },
                );
            });
            (request.scope)()?;
            Ok(true)
        }))
        .unwrap_or_else(|_| Err(EngineError::new("INTERNAL_ERROR")));
        let _ = request.reply.send(answer);
        // Whole request's lifetime sender drops only when this GTK closure ends.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shutdown_clears_only_the_actual_still_owned_token() {
        let calls = std::cell::Cell::new(0);
        assert!(!clear_if_current(&7, Some(&8), || calls.set(calls.get() + 1)));
        assert!(!clear_if_current(&7, None, || calls.set(calls.get() + 1)));
        assert!(clear_if_current(&7, Some(&7), || calls.set(calls.get() + 1)));
        assert_eq!(calls.get(), 1);
    }
    #[test]
    fn uri_list_is_file_protocol_only_and_percent_encodes_control_and_unicode_bytes() {
        // Defensive encoding test; the actual receipt decoder additionally
        // rejects control characters before any physical handoff is scheduled.
        assert_eq!(
            uri_list(Path::new("/workspace/task_1/a b#%é\n.txt")).unwrap(),
            b"file:///workspace/task_1/a%20b%23%25%C3%A9%0A.txt\r\n"
        );
        for path in ["relative.txt", "/bad\0path"] {
            assert!(uri_list(Path::new(path)).is_err());
        }
        assert!(uri_list(Path::new(&format!("/{}", "x".repeat(4096)))).is_err());
    }
    #[cfg(target_os = "linux")]
    mod linux {
        use super::*;
        use std::{fs, os::unix::fs::MetadataExt};
        struct Fixture {
            base: PathBuf,
            root: PathBuf,
            file: PathBuf,
        }
        impl Fixture {
            fn new() -> Self {
                let base = std::env::temp_dir().join(format!(
                    "21x-artifact-copy-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                fs::create_dir(&base).unwrap();
                let base = fs::canonicalize(base).unwrap();
                let root = base.join("workspaces");
                let task = root.join("task_1");
                fs::create_dir_all(&task).unwrap();
                let file = task.join("artifact.bin");
                fs::write(&file, [0, 255, 1]).unwrap();
                Self { base, root, file }
            }
            fn identity(path: &Path) -> Value {
                let m = fs::symlink_metadata(path).unwrap();
                json!({"path":path,"dev":m.dev().to_string(),"ino":m.ino().to_string(),"kind":if m.is_dir(){"directory"}else{"file"},"size":m.size().to_string(),"nlink":m.nlink().to_string()})
            }
            fn receipt(&self) -> NativeWorkspaceReceipt {
                NativeWorkspaceReceipt::from_value(&json!({"version":1,"taskId":"task_1","workspaceRoot":self.root,"path":self.file,"root":Self::identity(&self.root),"ancestors":[Self::identity(self.file.parent().unwrap())],"target":Self::identity(&self.file)})).unwrap()
            }
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.base);
            }
        }
        #[tokio::test]
        async fn early_reply_retains_raw_callback_and_pinned_file_until_actual_retirement() {
            let f = Fixture::new();
            let work = NativeWorkOwner::default();
            let owner = Arc::new(NativeWorkspaceFileOwner::open(f.root.clone()).unwrap());
            let (tx, rx) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(retained_copy(
                work.clone(),
                owner,
                f.receipt(),
                Arc::new(|| Ok(())),
                Arc::new(|| Ok(())),
                move |request| {
                    let _ = tx.send(request);
                    Ok(())
                },
            ));
            let request = rx.await.unwrap();
            assert!(request.bytes.starts_with(b"file:///"));
            request.reply.send(Ok(true)).unwrap();
            assert_eq!(work.active().unwrap(), 1);
            assert!(!task.is_finished());
            drop(request);
            assert_eq!(task.await.unwrap().unwrap(), json!({"mode":"file"}));
            work.drain().await.unwrap();
            assert_eq!(work.active().unwrap(), 0);
            assert_eq!(fs::read(&f.file).unwrap(), [0, 255, 1]);
        }
        #[tokio::test]
        async fn scheduling_failure_never_acknowledges_an_already_accepted_callback() {
            let f = Fixture::new();
            let work = NativeWorkOwner::default();
            let owner = Arc::new(NativeWorkspaceFileOwner::open(f.root.clone()).unwrap());
            let (tx, rx) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(retained_copy(
                work.clone(),
                owner,
                f.receipt(),
                Arc::new(|| Ok(())),
                Arc::new(|| Ok(())),
                move |request| {
                    let _ = tx.send(request);
                    Err(EngineError::new("DISCONNECTED"))
                },
            ));
            let request = rx.await.unwrap();
            request.reply.send(Ok(true)).unwrap();
            assert_eq!(work.active().unwrap(), 1);
            assert!(!task.is_finished());
            drop(request);
            assert_eq!(task.await.unwrap().unwrap_err().code, "DISCONNECTED");
            work.drain().await.unwrap();
            assert_eq!(work.active().unwrap(), 0);
        }
        #[tokio::test]
        async fn waiter_drop_revokes_future_gtk_effect_without_acknowledging_raw_callback() {
            let f = Fixture::new();
            let work = NativeWorkOwner::default();
            let owner = Arc::new(NativeWorkspaceFileOwner::open(f.root.clone()).unwrap());
            let (tx, rx) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(retained_copy(
                work.clone(),
                owner,
                f.receipt(),
                Arc::new(|| Ok(())),
                Arc::new(|| Ok(())),
                move |request| {
                    let _ = tx.send(request);
                    Ok(())
                },
            ));
            let request = rx.await.unwrap();
            task.abort();
            let _ = task.await;
            assert_eq!((request.scope)().unwrap_err().code, "CANCELLED");
            assert_eq!(work.active().unwrap(), 1);
            drop(request);
            work.drain().await.unwrap();
            assert_eq!(work.active().unwrap(), 0);
        }
        #[tokio::test]
        async fn source_revocation_prevents_scheduling_and_changed_target_refuses_handoff() {
            let f = Fixture::new();
            let work = NativeWorkOwner::default();
            let owner = Arc::new(NativeWorkspaceFileOwner::open(f.root.clone()).unwrap());
            let result = retained_copy(
                work.clone(),
                owner.clone(),
                f.receipt(),
                Arc::new(|| Ok(())),
                Arc::new(|| Err(EngineError::new("UNAUTHORIZED"))),
                |_| panic!("no GTK effect"),
            )
            .await;
            assert_eq!(result.unwrap_err().code, "UNAUTHORIZED");
            let receipt = f.receipt();
            fs::rename(&f.file, f.base.join("old")).unwrap();
            fs::write(&f.file, "foreign").unwrap();
            assert!(retained_copy(
                work.clone(),
                owner,
                receipt,
                Arc::new(|| Ok(())),
                Arc::new(|| Ok(())),
                |_| panic!("replaced target")
            )
            .await
            .is_err());
            assert_eq!(fs::read(&f.file).unwrap(), b"foreign");
            work.drain().await.unwrap();
        }
        #[tokio::test]
        async fn absent_display_returns_unavailable_only_after_callback_retirement() {
            let f = Fixture::new();
            let work = NativeWorkOwner::default();
            let owner = Arc::new(NativeWorkspaceFileOwner::open(f.root.clone()).unwrap());
            let result = retained_copy(
                work.clone(),
                owner,
                f.receipt(),
                Arc::new(|| Ok(())),
                Arc::new(|| Ok(())),
                |request| {
                    request.reply.send(Ok(false)).unwrap();
                    Ok(())
                },
            )
            .await
            .unwrap();
            assert_eq!(result, json!({"mode":"unavailable"}));
            work.drain().await.unwrap();
            assert_eq!(work.active().unwrap(), 0);
        }
        #[tokio::test]
        async fn authority_loss_after_accepted_reply_still_joins_the_raw_callback() {
            let f = Fixture::new();
            let work = NativeWorkOwner::default();
            let owner = Arc::new(NativeWorkspaceFileOwner::open(f.root.clone()).unwrap());
            let (tx, rx) = tokio::sync::oneshot::channel();
            let authorized = Arc::new(AtomicBool::new(true));
            let current_authorized = authorized.clone();
            let current: Scope = Arc::new(move || {
                if current_authorized.load(Ordering::SeqCst) {
                    Ok(())
                } else {
                    Err(EngineError::new("UNAUTHORIZED"))
                }
            });
            let task = tokio::spawn(retained_copy(
                work.clone(),
                owner,
                f.receipt(),
                current,
                Arc::new(|| Ok(())),
                move |request| {
                    let _ = tx.send(request);
                    Ok(())
                },
            ));
            let request = rx.await.unwrap();
            request.reply.send(Ok(true)).unwrap();
            authorized.store(false, Ordering::SeqCst);
            assert_eq!(work.active().unwrap(), 1);
            assert!(!task.is_finished());
            drop(request);
            assert_eq!(task.await.unwrap().unwrap_err().code, "UNAUTHORIZED");
            work.drain().await.unwrap();
            assert_eq!(work.active().unwrap(), 0);
            assert_eq!(fs::read(&f.file).unwrap(), [0, 255, 1]);
        }
        #[tokio::test]
        async fn target_replacement_after_gtk_reply_is_refused_after_actual_callback_retirement() {
            let f = Fixture::new();
            let work = NativeWorkOwner::default();
            let owner = Arc::new(NativeWorkspaceFileOwner::open(f.root.clone()).unwrap());
            let (tx, rx) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(retained_copy(
                work.clone(),
                owner,
                f.receipt(),
                Arc::new(|| Ok(())),
                Arc::new(|| Ok(())),
                move |request| {
                    let _ = tx.send(request);
                    Ok(())
                },
            ));
            let request = rx.await.unwrap();
            request.reply.send(Ok(true)).unwrap();
            fs::rename(&f.file, f.base.join("old-source")).unwrap();
            fs::write(&f.file, b"new owner").unwrap();
            assert_eq!(work.active().unwrap(), 1);
            drop(request);
            assert!(task.await.unwrap().is_err());
            work.drain().await.unwrap();
            assert_eq!(fs::read(&f.file).unwrap(), b"new owner");
            assert_eq!(fs::read(f.base.join("old-source")).unwrap(), [0, 255, 1]);
        }
    }
}
