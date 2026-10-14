//! Linux Save dialog + descriptor-owned no-overwrite download. Selected paths
//! never cross the service wire; all accepted GUI/copy work remains drainable.
use super::{native_services::NativeWorkOwner, production_ui::NativeUiOwner};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::Manager;
use twentyonex_engine::{
    production::{HostFuture, ProductionAttachmentDownloadHost},
    production_attachment_files::{
        copy_new_attachment, NativeAttachmentFileOwner, NativeAttachmentReceipt,
    },
    EngineError,
};
type Scope = Arc<dyn Fn() -> Result<(), EngineError> + Send + Sync>;
struct Active(Arc<AtomicBool>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
struct DialogRequest {
    scope: Scope,
    active: Arc<AtomicBool>,
    reply: std::sync::mpsc::Sender<Result<Option<PathBuf>, EngineError>>,
    _lifetime: std::sync::mpsc::Sender<()>,
}
impl Drop for DialogRequest {
    fn drop(&mut self) {}
}
impl DialogRequest {
    fn finish(&self, result: Result<Option<PathBuf>, EngineError>) {
        let _ = self.reply.send(result);
    }
}
async fn retained_download(
    work: NativeWorkOwner,
    owner: Arc<NativeAttachmentFileOwner>,
    receipt: NativeAttachmentReceipt,
    current: Scope,
    copy_current: Scope,
    schedule: impl FnOnce(DialogRequest) -> Result<(), EngineError> + Send + 'static,
) -> Result<(), EngineError> {
    let active = Arc::new(AtomicBool::new(true));
    let _active = Active(active.clone());
    let owned_active = active.clone();
    let scope: Scope = Arc::new(move || {
        if !active.load(Ordering::SeqCst) {
            return Err(EngineError::new("CANCELLED"));
        }
        current()
    });
    work.run(move || {
        scope()?;
        // Capture the readable version before the user waits in the dialog.
        let source = owner.validate(&receipt)?.open_pinned_reader()?;
        let (reply, response) = std::sync::mpsc::channel();
        let (lifetime, retired) = std::sync::mpsc::channel::<()>();
        let scheduled = schedule(DialogRequest {
            scope: scope.clone(),
            active: owned_active,
            reply,
            _lifetime: lifetime,
        });
        let selected = response.recv();
        // Response/Cancel is not GTK closure retirement. Join all actual signal
        // and timer captures before source/copy ownership may settle.
        while retired.recv().is_ok() {}
        if scheduled.is_err() {
            return Err(EngineError::new("DISCONNECTED"));
        }
        let selected = selected.map_err(|_| EngineError::new("DISCONNECTED"))??;
        match selected {
            None => Ok(()), // actual user cancellation has void-success semantics
            Some(destination) => {
                // Source authorization can drift while GTK waits. This runs only
                // on the retained blocking worker, never in a GUI callback.
                let before_effect = || {
                    scope()?;
                    copy_current()?;
                    scope()
                };
                before_effect()?;
                copy_new_attachment(source, destination, before_effect)
            }
        }
    })
    .await
}

pub fn host(
    app: &tauri::AppHandle,
    work: NativeWorkOwner,
    ui: NativeUiOwner,
    attachment_root: PathBuf,
) -> Result<Option<ProductionAttachmentDownloadHost>, EngineError> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, work, ui, attachment_root);
        return Ok(None);
    }
    #[cfg(target_os = "linux")]
    {
        // Open host created this protected bootstrap root already. Never replace
        // or recreate it during download setup or from a service request.
        let owner = NativeAttachmentFileOwner::open(attachment_root)?;
        let slot = Arc::new(Mutex::new(Some(Arc::new(owner))));
        let captured = slot.clone();
        let app = app.clone();
        let drain = work.clone();
        Ok(Some(ProductionAttachmentDownloadHost {
            invoke: Arc::new(
                move |receipt: Value,
                      lease: String,
                      epoch: String,
                      authorization_id: String|
                      -> HostFuture<()> {
                    let (app, work, ui, slot) =
                        (app.clone(), work.clone(), ui.clone(), captured.clone());
                    Box::pin(async move {
                        let window = app
                            .get_webview_window("main")
                            .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
                        ui.assert_publish(&window, &epoch, &lease)?;
                        let engine = super::available_engine(&app, Some(&epoch))?;
                        let copy_epoch = epoch.clone();
                        let receipt = NativeAttachmentReceipt::from_value(&receipt)
                            .map_err(|_| EngineError::new("INVALID_ARGUMENTS"))?;
                        let name = receipt.filename().to_owned();
                        let owner = slot
                            .lock()
                            .map_err(|_| EngineError::new("DISCONNECTED"))?
                            .as_ref()
                            .cloned()
                            .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
                        let (guard_work, guard_window) = (work.clone(), window.clone());
                        let current: Scope = Arc::new(move || {
                            guard_work.assert_open()?;
                            ui.assert_publish(&guard_window, &epoch, &lease)
                        });
                        let copy_ui = current.clone();
                        let copy_current: Scope = Arc::new(move || {
                            copy_ui()?;
                            tauri::async_runtime::block_on(
                                engine.check_attachment_download(&copy_epoch, &authorization_id),
                            )?;
                            copy_ui()
                        });
                        let public = retained_download(
                            work,
                            owner,
                            receipt,
                            current,
                            copy_current,
                            move |request| {
                                app.run_on_main_thread(move || {
                                    gtk_save::begin(window, name, request)
                                })
                                .map_err(|_| EngineError::new("DISCONNECTED"))
                            },
                        );
                        match tokio::time::timeout(std::time::Duration::from_secs(120), public)
                            .await
                        {
                            Ok(result) => result,
                            Err(_) => Err(EngineError::new("TIMEOUT")),
                        }
                    })
                },
            ),
            close: Arc::new(move || {
                let (work, slot) = (drain.clone(), slot.clone());
                Box::pin(async move {
                    work.drain().await?;
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
mod gtk_save {
    use super::*;
    use gtk::prelude::*;
    use std::{
        cell::RefCell,
        panic::{catch_unwind, AssertUnwindSafe},
        rc::Rc,
    };
    struct State {
        request: DialogRequest,
        finished: bool,
        handlers: Vec<gtk::glib::SignalHandlerId>,
    }
    fn current(state: &Rc<RefCell<State>>) -> Result<(), EngineError> {
        let scope = state.borrow().request.scope.clone();
        scope()
    }
    fn finish(
        dialog: &gtk::FileChooserDialog,
        state: &Rc<RefCell<State>>,
        answer: Result<Option<PathBuf>, EngineError>,
        destroy: bool,
    ) {
        let (handlers, reply) = {
            let mut state = state.borrow_mut();
            if state.finished {
                return;
            }
            state.finished = true;
            (
                std::mem::take(&mut state.handlers),
                state.request.reply.clone(),
            )
        };
        for handler in handlers {
            dialog.disconnect(handler);
        }
        if destroy {
            unsafe {
                dialog.destroy();
            }
        }
        let _ = reply.send(answer);
        // The timer retains State until its own next real callback retires.
        // Raw bridge never interprets this early reply as closure drainage.
    }
    pub(super) fn begin(window: tauri::WebviewWindow, name: String, request: DialogRequest) {
        let reply = request.reply.clone();
        let active = request.active.clone();
        let outcome = catch_unwind(AssertUnwindSafe(move || {
            if let Err(error) = (request.scope)() {
                request.finish(Err(error));
                return;
            }
            if !gtk::is_initialized_main_thread() {
                request.finish(Err(EngineError::new("UNKNOWN_OPERATION")));
                return;
            }
            let parent = match window.gtk_window() {
                Ok(parent) => parent,
                Err(_) => {
                    request.finish(Err(EngineError::new("DISCONNECTED")));
                    return;
                }
            };
            let dialog = gtk::FileChooserDialog::with_buttons(
                Some("Save attachment — choose a new filename; existing files cannot be replaced"),
                Some(&parent),
                gtk::FileChooserAction::Save,
                &[
                    ("Cancel", gtk::ResponseType::Cancel),
                    ("Save new file", gtk::ResponseType::Accept),
                ],
            );
            dialog.set_modal(true);
            dialog.set_destroy_with_parent(true);
            dialog.set_local_only(true);
            dialog.set_do_overwrite_confirmation(false);
            dialog.set_create_folders(false);
            dialog.set_current_name(&name);
            let notice = gtk::Label::new(Some(
                "Choose a new filename. Existing files cannot be replaced here.",
            ));
            notice.set_line_wrap(true);
            dialog.set_extra_widget(&notice);
            let state = Rc::new(RefCell::new(State {
                request,
                finished: false,
                handlers: Vec::new(),
            }));
            // Install retirement polling before event handlers. Shutdown/private
            // drain cannot wait on host.close to cancel an already-owned dialog.
            let (timer_dialog, timer_state) = (dialog.clone(), state.clone());
            gtk::glib::timeout_add_local(std::time::Duration::from_millis(200), move || {
                let result = catch_unwind(AssertUnwindSafe(|| {
                    if timer_state.borrow().finished {
                        return gtk::glib::ControlFlow::Break;
                    }
                    let current = current(&timer_state);
                    if let Err(error) = current {
                        finish(&timer_dialog, &timer_state, Err(error), true);
                        return gtk::glib::ControlFlow::Break;
                    }
                    gtk::glib::ControlFlow::Continue
                }));
                match result {
                    Ok(flow) => flow,
                    Err(_) => {
                        timer_state
                            .borrow()
                            .request
                            .active
                            .store(false, Ordering::SeqCst);
                        finish(
                            &timer_dialog,
                            &timer_state,
                            Err(EngineError::new("INTERNAL_ERROR")),
                            true,
                        );
                        gtk::glib::ControlFlow::Break
                    }
                }
            });
            let response_state = state.clone();
            let response = dialog.connect_response(move |dialog, response| {
                let result = catch_unwind(AssertUnwindSafe(|| {
                    if response_state.borrow().finished {
                        return;
                    }
                    if let Err(error) = current(&response_state) {
                        finish(dialog, &response_state, Err(error), true);
                        return;
                    }
                    if response != gtk::ResponseType::Accept {
                        finish(dialog, &response_state, Ok(None), true);
                        return;
                    }
                    let destination = match dialog.filename() {
                        Some(path) => path,
                        None => {
                            finish(
                                dialog,
                                &response_state,
                                Err(EngineError::new("INVALID_ARGUMENTS")),
                                true,
                            );
                            return;
                        }
                    };
                    // Filesystem checks/copy stay in the retained blocking
                    // worker. Atomic publication refuses every existing kind.
                    if let Err(error) = current(&response_state) {
                        finish(dialog, &response_state, Err(error), true);
                        return;
                    }
                    finish(dialog, &response_state, Ok(Some(destination)), true);
                }));
                if result.is_err() {
                    response_state
                        .borrow()
                        .request
                        .active
                        .store(false, Ordering::SeqCst);
                }
            });
            state.borrow_mut().handlers.push(response);
            let destroyed_state = state.clone();
            let destroyed = dialog.connect_destroy(move |dialog| {
                let result = catch_unwind(AssertUnwindSafe(|| {
                    finish(dialog, &destroyed_state, Ok(None), false)
                }));
                if result.is_err() {
                    destroyed_state
                        .borrow()
                        .request
                        .active
                        .store(false, Ordering::SeqCst);
                }
            });
            state.borrow_mut().handlers.push(destroyed);
            if let Err(error) = current(&state) {
                finish(&dialog, &state, Err(error), true);
                return;
            }
            dialog.show_all();
        }));
        if outcome.is_err() {
            active.store(false, Ordering::SeqCst);
            let _ = reply.send(Err(EngineError::new("INTERNAL_ERROR")));
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{fs, os::unix::fs::MetadataExt, path::Path};
    struct Fixture {
        base: PathBuf,
        path: PathBuf,
        owner: Arc<NativeAttachmentFileOwner>,
        receipt: NativeAttachmentReceipt,
    }
    impl Fixture {
        fn new() -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let base = std::env::temp_dir().join(format!(
                "21x-native-download-{}-{stamp}",
                std::process::id()
            ));
            fs::create_dir(&base).unwrap();
            let base = fs::canonicalize(base).unwrap();
            let root = base.join("attachments");
            let task = root.join("task_1");
            fs::create_dir_all(&task).unwrap();
            let id = "61f07006-c85b-438e-83a7-497c77b0dcae";
            let path = task.join(format!("{id}-public.bin"));
            fs::write(&path, b"actual binary\0bytes").unwrap();
            let identity = |path: &Path| {
                let m = fs::symlink_metadata(path).unwrap();
                json!({"path":path.to_str().unwrap(),"dev":m.dev().to_string(),"ino":m.ino().to_string(),"kind":if m.is_dir(){"directory"}else{"file"},"size":m.size().to_string(),"nlink":m.nlink().to_string()})
            };
            let receipt=NativeAttachmentReceipt::from_value(&json!({"version":1,"taskId":"task_1","attachmentId":id,"filename":"public.bin","attachmentRoot":root.to_str().unwrap(),"path":path.to_str().unwrap(),"root":identity(&root),"ancestors":[identity(&task)],"target":identity(&path)})).unwrap();
            let owner = Arc::new(NativeAttachmentFileOwner::open(root).unwrap());
            Self {
                base,
                path,
                owner,
                receipt,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }
    #[tokio::test]
    async fn user_cancel_is_void_success_only_after_actual_dialog_capture_retirement() {
        let f = Fixture::new();
        let work = NativeWorkOwner::default();
        let raw = work.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        let (owner, receipt) = (f.owner.clone(), f.receipt.clone());
        let public = tokio::spawn(async move {
            retained_download(
                raw,
                owner,
                receipt,
                Arc::new(|| Ok(())),
                Arc::new(|| Ok(())),
                move |request| {
                    let _ = send.send(request);
                    Ok(())
                },
            )
            .await
        });
        let dialog = receive.await.unwrap();
        dialog.finish(Ok(None));
        tokio::task::yield_now().await;
        assert!(!public.is_finished());
        assert_eq!(work.active().unwrap(), 1);
        drop(dialog);
        public.await.unwrap().unwrap();
        work.drain().await.unwrap();
        assert_eq!(work.active().unwrap(), 0);
        assert_eq!(fs::read(&f.path).unwrap(), b"actual binary\0bytes");
        assert_eq!(fs::read_dir(&f.base).unwrap().count(), 1);
    }
    #[tokio::test]
    async fn dropped_public_download_prevents_copy_but_retains_accepted_dialog_and_fd_work() {
        let f = Fixture::new();
        let destination = f.base.join("saved.bin");
        let selected = destination.clone();
        let work = NativeWorkOwner::default();
        let raw = work.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        let (owner, receipt) = (f.owner.clone(), f.receipt.clone());
        let public = tokio::spawn(async move {
            retained_download(
                raw,
                owner,
                receipt,
                Arc::new(|| Ok(())),
                Arc::new(|| Ok(())),
                move |request| {
                    let _ = send.send(request);
                    Ok(())
                },
            )
            .await
        });
        let dialog = receive.await.unwrap();
        public.abort();
        let _ = public.await;
        assert_eq!((dialog.scope)().unwrap_err().code, "CANCELLED");
        dialog.finish(Ok(Some(selected)));
        let drain_owner = work.clone();
        let drain = tokio::spawn(async move { drain_owner.drain().await });
        tokio::task::yield_now().await;
        assert!(!drain.is_finished());
        assert_eq!(work.active().unwrap(), 1);
        drop(dialog);
        drain.await.unwrap().unwrap();
        assert_eq!(work.active().unwrap(), 0);
        assert!(!destination.exists());
    }
    #[tokio::test]
    async fn source_version_before_dialog_and_current_document_guard_survive_callback_delays() {
        let f = Fixture::new();
        let destination = f.base.join("saved.bin");
        let selected = destination.clone();
        let work = NativeWorkOwner::default();
        let raw = work.clone();
        let live = Arc::new(AtomicBool::new(true));
        let current = live.clone();
        let scope: Scope = Arc::new(move || {
            if current.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(EngineError::new("STALE_EPOCH"))
            }
        });
        let (send, receive) = tokio::sync::oneshot::channel();
        let (owner, receipt) = (f.owner.clone(), f.receipt.clone());
        let public = tokio::spawn(async move {
            retained_download(
                raw,
                owner,
                receipt,
                scope,
                Arc::new(|| Ok(())),
                move |request| {
                    let _ = send.send(request);
                    Ok(())
                },
            )
            .await
        });
        let dialog = receive.await.unwrap();
        live.store(false, Ordering::SeqCst);
        dialog.finish(Ok(Some(selected)));
        drop(dialog);
        assert_eq!(public.await.unwrap().unwrap_err().code, "STALE_EPOCH");
        assert!(!destination.exists());
        work.drain().await.unwrap();
    }
    #[tokio::test]
    async fn original_source_authorization_revoked_during_dialog_refuses_copy_after_raw_retirement()
    {
        let f = Fixture::new();
        let destination = f.base.join("forbidden.bin");
        let selected = destination.clone();
        let work = NativeWorkOwner::default();
        let raw = work.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        let allowed = Arc::new(AtomicBool::new(true));
        let current = allowed.clone();
        let checks = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let counted = checks.clone();
        let copy_current: Scope = Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            if current.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(EngineError::new("UNAUTHORIZED"))
            }
        });
        let (owner, receipt) = (f.owner.clone(), f.receipt.clone());
        let public = tokio::spawn(async move {
            retained_download(
                raw,
                owner,
                receipt,
                Arc::new(|| Ok(())),
                copy_current,
                move |request| {
                    let _ = send.send(request);
                    Ok(())
                },
            )
            .await
        });
        let dialog = receive.await.unwrap();
        assert_eq!(checks.load(Ordering::SeqCst), 0); // GTK never makes the blocking source RPC
        allowed.store(false, Ordering::SeqCst);
        dialog.finish(Ok(Some(selected)));
        tokio::task::yield_now().await;
        assert!(!public.is_finished());
        assert_eq!(work.active().unwrap(), 1);
        assert!(!destination.exists());
        drop(dialog);
        assert_eq!(public.await.unwrap().unwrap_err().code, "UNAUTHORIZED");
        assert_eq!(checks.load(Ordering::SeqCst), 1);
        assert!(!destination.exists());
        work.drain().await.unwrap();
        assert_eq!(work.active().unwrap(), 0);
        assert_eq!(fs::read(&f.path).unwrap(), b"actual binary\0bytes");
    }
    #[tokio::test]
    async fn source_mutation_during_save_dialog_is_refused_even_when_selected_destination_is_new() {
        let f = Fixture::new();
        let destination = f.base.join("saved.bin");
        let selected = destination.clone();
        let work = NativeWorkOwner::default();
        let raw = work.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        let (owner, receipt) = (f.owner.clone(), f.receipt.clone());
        let public = tokio::spawn(async move {
            retained_download(
                raw,
                owner,
                receipt,
                Arc::new(|| Ok(())),
                Arc::new(|| Ok(())),
                move |request| {
                    let _ = send.send(request);
                    Ok(())
                },
            )
            .await
        });
        let dialog = receive.await.unwrap();
        fs::write(&f.path, b"changed source version").unwrap();
        dialog.finish(Ok(Some(selected)));
        drop(dialog);
        assert!(public.await.unwrap().is_err());
        assert!(!destination.exists());
        work.drain().await.unwrap();
    }
    #[tokio::test]
    async fn deadline_revokes_dialog_and_shutdown_cannot_ack_before_its_callback_retires() {
        let f = Fixture::new();
        let work = NativeWorkOwner::default();
        let raw = work.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        let (owner, receipt) = (f.owner.clone(), f.receipt.clone());
        let public = tokio::spawn(async move {
            tokio::time::timeout(
                std::time::Duration::from_millis(20),
                retained_download(
                    raw,
                    owner,
                    receipt,
                    Arc::new(|| Ok(())),
                    Arc::new(|| Ok(())),
                    move |request| {
                        let _ = send.send(request);
                        Ok(())
                    },
                ),
            )
            .await
        });
        let dialog = receive.await.unwrap();
        assert!(public.await.unwrap().is_err());
        assert_eq!((dialog.scope)().unwrap_err().code, "CANCELLED");
        let drain_owner = work.clone();
        let drain = tokio::spawn(async move { drain_owner.drain().await });
        dialog.finish(Err(EngineError::new("CANCELLED")));
        tokio::task::yield_now().await;
        assert!(!drain.is_finished());
        drop(dialog);
        drain.await.unwrap().unwrap();
        assert_eq!(work.active().unwrap(), 0);
    }
    #[tokio::test]
    async fn failed_schedule_does_not_acknowledge_a_dialog_already_owned_by_native_gui() {
        let f = Fixture::new();
        let work = NativeWorkOwner::default();
        let raw = work.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        let (owner, receipt) = (f.owner.clone(), f.receipt.clone());
        let public = tokio::spawn(async move {
            retained_download(
                raw,
                owner,
                receipt,
                Arc::new(|| Ok(())),
                Arc::new(|| Ok(())),
                move |request| {
                    let _ = send.send(request);
                    Err(EngineError::new("DISCONNECTED"))
                },
            )
            .await
        });
        let dialog = receive.await.unwrap();
        dialog.finish(Ok(None));
        tokio::task::yield_now().await;
        assert!(!public.is_finished());
        drop(dialog);
        assert_eq!(public.await.unwrap().unwrap_err().code, "DISCONNECTED");
        work.drain().await.unwrap();
    }
}
