//! Native chooser/FD leases. Paths are display data; Source imports only
//! private one-shot grants under its captured task/project authority.
use super::{
    native_attachment_drop::DropOwner, native_services::NativeWorkOwner,
    production_ui::NativeUiOwner,
};
#[cfg(target_os = "linux")]
use serde_json::{json, Value};
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
#[cfg(target_os = "linux")]
use tauri::Manager;
use twentyonex_engine::production::ProductionAttachmentSelectionHost;
#[cfg(target_os = "linux")]
use twentyonex_engine::{
    production::HostFuture, production_attachment_selection::SelectionAuthority, EngineError,
};
#[cfg(target_os = "linux")]
type Scope = Arc<dyn Fn() -> Result<(), EngineError> + Send + Sync>;
#[cfg(target_os = "linux")]
struct Active(Arc<AtomicBool>);
#[cfg(target_os = "linux")]
impl Drop for Active {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
#[cfg(target_os = "linux")]
struct DialogRequest {
    scope: Scope,
    active: Arc<AtomicBool>,
    reply: std::sync::mpsc::Sender<Result<Option<Vec<PathBuf>>, EngineError>>,
    _lifetime: std::sync::mpsc::Sender<()>,
}
#[cfg(target_os = "linux")]
impl DialogRequest {
    fn finish(&self, result: Result<Option<Vec<PathBuf>>, EngineError>) {
        let _ = self.reply.send(result);
    }
}
#[cfg(target_os = "linux")]
pub(super) fn selection_id() -> Result<String, EngineError> {
    use std::io::Read;
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}
pub fn host(
    app: &tauri::AppHandle,
    work: NativeWorkOwner,
    ui: NativeUiOwner,
    profile: PathBuf,
    drops: DropOwner,
) -> Option<ProductionAttachmentSelectionHost> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, work, ui, profile, drops);
        None
    }
    #[cfg(target_os = "linux")]
    {
        let owner = SelectionAuthority::default();
        configure_drop(
            app,
            work.clone(),
            ui.clone(),
            profile.clone(),
            owner.clone(),
            &drops,
        )
        .ok()?;
        let close_owner = owner.clone();
        let close_work = work.clone();
        let close_drops = drops.clone();
        let app = app.clone();
        Some(ProductionAttachmentSelectionHost {
            invoke: Arc::new(
                move |operation: String, payload: Value, epoch: String| -> HostFuture<Value> {
                    let (app, work, ui, profile, owner, drops) = (
                        app.clone(),
                        work.clone(),
                        ui.clone(),
                        profile.clone(),
                        owner.clone(),
                        drops.clone(),
                    );
                    Box::pin(async move {
                        // Retirement drains the entry even after physical document loss.
                        if operation == "host.attachment.selection.retire" {
                            return work
                                .run_cleanup(move || owner.invoke(&operation, &payload, || Ok(())))
                                .await;
                        }
                        let window = app
                            .get_webview_window("main")
                            .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
                        let lease = payload["leaseId"]
                            .as_str()
                            .ok_or_else(|| EngineError::new("INVALID_ARGUMENTS"))?
                            .to_owned();
                        work.assert_open()?;
                        ui.assert_publish(&window, &epoch, &lease)?;
                        let engine = super::available_engine(&app, Some(&epoch))?;
                        let (guard_window, guard_work, guard_epoch, guard_lease) =
                            (window.clone(), work.clone(), epoch.clone(), lease.clone());
                        let selected = payload["selectionId"].as_str().map(str::to_owned);
                        let current: Scope = Arc::new(move || {
                            guard_work.assert_open()?;
                            ui.assert_publish(&guard_window, &guard_epoch, &guard_lease)?;
                            if let Some(id) = &selected {
                                drops.check_selection(id, &guard_lease)?;
                            }
                            Ok(())
                        });
                        if operation != "native.attachment.pick" {
                            return work
                                .run(move || owner.invoke(&operation, &payload, || current()))
                                .await;
                        }
                        let active = Arc::new(AtomicBool::new(true));
                        let _active = Active(active.clone());
                        let raw_active = active.clone();
                        let guarded: Scope = Arc::new(move || {
                            if !active.load(Ordering::SeqCst) {
                                return Err(EngineError::new("CANCELLED"));
                            }
                            current()
                        });
                        let public=work.run(move||{
                        guarded()?;
                        let(reply,response)=std::sync::mpsc::channel();let(lifetime,retired)=std::sync::mpsc::channel::<()>();
                        let request=DialogRequest{scope:guarded.clone(),active:raw_active,reply,_lifetime:lifetime};
                        let scheduled=app.run_on_main_thread(move||gtk_pick::begin(window,request));
                        let paths=response.recv();while retired.recv().is_ok(){}
                        if scheduled.is_err(){return Err(EngineError::new("DISCONNECTED"));}
                        let paths=paths.map_err(|_|EngineError::new("DISCONNECTED"))??.unwrap_or_default();guarded()?;
                        if paths.is_empty(){return Ok(json!({"defined":true,"value":[]}));}
                        let mut selections=Vec::new();
                        let result=(||{
                            for path in paths { guarded()?;let id=selection_id()?;let receipt=owner.select_scoped(path,&id,&lease,&profile,||guarded())?;selections.push(receipt); }
                            guarded()?;
                            tauri::async_runtime::block_on(engine.offer_attachment_selections(&epoch,json!({"leaseId":lease,"selections":selections})))?;
                            guarded()?;
                            Ok(json!({"defined":true,"value":selections.iter().map(|v|v["path"].clone()).collect::<Vec<_>>()}))
                        })();
                        if result.is_err(){for selection in selections {let _=owner.invoke("host.attachment.selection.retire",&json!({"leaseId":lease,"selectionId":selection["selectionId"]}),||Ok(()));}}
                        result
                    });
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
                let (owner, work, drops) =
                    (close_owner.clone(), close_work.clone(), close_drops.clone());
                Box::pin(async move {
                    drops.shutdown().await?;
                    owner.stop()?;
                    work.drain().await?;
                    owner.close()
                })
            }),
        })
    }
}
#[cfg(target_os = "linux")]
fn configure_drop(
    app: &tauri::AppHandle,
    work: NativeWorkOwner,
    ui: NativeUiOwner,
    profile: PathBuf,
    owner: SelectionAuthority,
    drops: &DropOwner,
) -> Result<(), EngineError> {
    use super::native_attachment_drop::{Guard, RawReceipt};
    let (close_app, close_work, close_owner) = (app.clone(), work.clone(), owner.clone());
    drops.configure(Arc::new(move |group| {
        let (app, work, owner) = (close_app.clone(), close_work.clone(), close_owner.clone());
        Box::pin(async move {
            // Raw capture has settled before this callback. Source revocation
            // joins any admitted import before native descriptors are released.
            if group.offered.load(Ordering::SeqCst) {
                let engine = app
                    .state::<super::ProductionState>()
                    .engine
                    .clone()
                    .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
                engine
                    .revoke_attachment_selections(
                        &group.context.epoch,
                        json!({"leaseId":group.context.lease,"selectionIds":group.selection_ids}),
                    )
                    .await?;
            }
            work.run_cleanup(move || {
                for id in &group.selection_ids {
                    owner.invoke(
                        "host.attachment.selection.retire",
                        &json!({"leaseId":group.context.lease,"selectionId":id}),
                        || Ok(()),
                    )?;
                }
                Ok(())
            })
            .await
        })
    }))?;
    let app = app.clone();
    drops.configure_capture(Arc::new(move |drops, paths, epoch, lease, document: Guard| {
        // Validate the entire native batch before acquiring any file descriptor.
        let path_values: Vec<_> = paths.iter().map(|p| p.to_str().map(|s| json!(s))).collect();
        if paths.is_empty() || paths.len() > 16 || path_values.iter().any(|p| p.as_ref().is_none_or(|p| !twentyonex_engine::production_attachment_selection::path(p)))
            || paths.iter().collect::<std::collections::HashSet<_>>().len() != paths.len() { return; }
        let Ok(id) = selection_id() else { return; };
        let Ok(ids) = paths.iter().map(|_| selection_id()).collect::<Result<Vec<_>,_>>() else { return; };
        let Ok(group) = drops.capture(id, ids, &lease, &epoch, document) else { return; };
        let (app, work, ui, profile, owner) = (app.clone(), work.clone(), ui.clone(), profile.clone(), owner.clone());
        // Own the raw receipt before scheduling. Close cannot race the interval
        // before the blocking driver's first poll and acknowledge early.
        let receipt = RawReceipt(group.clone());
        drops.expire(group.clone());
        tauri::async_runtime::spawn(async move {
            let (raw_group, checking) = (group.clone(), drops.clone());
            let result = work.run(move || {
                let _receipt = receipt;
                let current = || {
                    checking.check(&raw_group, false)?;
                    let window = app.get_webview_window("main").ok_or_else(|| EngineError::new("DISCONNECTED"))?;
                    ui.assert_publish(&window, &epoch, &lease)
                };
                current()?;
                let engine = super::available_engine(&app, Some(&epoch))?;
                let mut selections = Vec::new();
                for (path, id) in paths.into_iter().zip(&raw_group.selection_ids) {
                    selections.push(owner.select_scoped(path, id, &lease, &profile, current)?);
                }
                current()?;
                raw_group.offered.store(true, Ordering::SeqCst);
                tauri::async_runtime::block_on(engine.offer_attachment_selections(&epoch, json!({"leaseId":lease,"selections":selections})))?;
                current()?;
                ui.attachment_drop(&app, &epoch, &lease, json!({"dropId":raw_group.id,"contextId":raw_group.context.id,"paths":selections.iter().map(|s| s["path"].clone()).collect::<Vec<_>>()}))
            }).await;
            if result.is_err() { let _ = drops.close_group(group).await; }
        });
    }))
}
#[cfg(target_os = "linux")]
mod gtk_pick {
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
        answer: Result<Option<Vec<PathBuf>>, EngineError>,
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
    pub(super) fn begin(window: tauri::WebviewWindow, request: DialogRequest) {
        begin_with_parent(
            move || {
                window
                    .gtk_window()
                    .map(|parent| parent.upcast::<gtk::Window>())
                    .map_err(|_| EngineError::new("DISCONNECTED"))
            },
            request,
        )
    }
    pub(super) fn begin_with_parent(
        parent: impl FnOnce() -> Result<gtk::Window, EngineError>,
        request: DialogRequest,
    ) {
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
            let parent = match parent() {
                Ok(parent) => parent,
                Err(_) => {
                    request.finish(Err(EngineError::new("DISCONNECTED")));
                    return;
                }
            };
            let dialog = gtk::FileChooserDialog::with_buttons(
                Some("Select files to attach"),
                Some(&parent),
                gtk::FileChooserAction::Open,
                &[
                    ("Cancel", gtk::ResponseType::Cancel),
                    ("Select files", gtk::ResponseType::Accept),
                ],
            );
            dialog.set_modal(true);
            dialog.set_destroy_with_parent(true);
            dialog.set_local_only(true);
            dialog.set_select_multiple(true);
            dialog.set_create_folders(false);
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
                    let destination = dialog.filenames();
                    if destination.is_empty() || destination.len() > 16 {
                        finish(
                            dialog,
                            &response_state,
                            Err(EngineError::new("INVALID_ARGUMENTS")),
                            true,
                        );
                        return;
                    }
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
mod gtk_tests {
    use super::*;
    use gtk::prelude::*;
    fn pump_until(mut ready: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            while gtk::glib::MainContext::default().pending() {
                gtk::glib::MainContext::default().iteration(false);
            }
            if ready() {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "GTK selection proof deadline"
            );
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }
    #[test]
    #[ignore = "requires an explicitly isolated Xvfb GTK session; execute with --ignored --test-threads=1"]
    fn real_gtk_picker_selection_cancel_and_revocation_join_owned_closures() {
        gtk::init().expect("isolated GTK display required");
        let base = std::env::temp_dir().join(format!("21x-gtk-pick-{}", selection_id().unwrap()));
        std::fs::create_dir(&base).unwrap();
        let path = base.join("selected.txt");
        std::fs::write(&path, b"abc").unwrap();
        let profile = base.join("profile");
        std::fs::create_dir(&profile).unwrap();
        let parent = gtk::Window::new(gtk::WindowType::Toplevel);
        parent.show_all();
        for mode in ["selected", "cancelled", "revoked"] {
            let current = Arc::new(AtomicBool::new(true));
            let active = Arc::new(AtomicBool::new(true));
            let guard = current.clone();
            let (reply, response) = std::sync::mpsc::channel();
            let (lifetime, retired) = std::sync::mpsc::channel::<()>();
            let captured = parent.clone();
            gtk_pick::begin_with_parent(
                move || Ok(captured),
                DialogRequest {
                    scope: Arc::new(move || {
                        if guard.load(Ordering::SeqCst) {
                            Ok(())
                        } else {
                            Err(EngineError::new("DISCONNECTED"))
                        }
                    }),
                    active,
                    reply,
                    _lifetime: lifetime,
                },
            );
            let dialog = gtk::Window::list_toplevels()
                .into_iter()
                .find_map(|w| w.downcast::<gtk::FileChooserDialog>().ok())
                .expect("actual native Open chooser");
            assert!(dialog.is_modal());
            assert!(dialog.selects_multiple());
            assert_eq!(dialog.transient_for(), Some(parent.clone()));
            if mode == "selected" {
                assert!(dialog.set_filename(&path));
                pump_until(|| dialog.filenames() == vec![path.clone()]);
                dialog.response(gtk::ResponseType::Accept);
            } else if mode == "cancelled" {
                dialog.response(gtk::ResponseType::Cancel);
            } else {
                current.store(false, Ordering::SeqCst);
            }
            let mut answer = None;
            pump_until(|| match response.try_recv() {
                Ok(value) => {
                    answer = Some(value);
                    true
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => false,
                Err(error) => panic!("response missing: {error}"),
            });
            pump_until(|| match retired.try_recv() {
                Err(std::sync::mpsc::TryRecvError::Disconnected) => true,
                Err(std::sync::mpsc::TryRecvError::Empty) => false,
                Ok(()) => panic!("unexpected retirement payload"),
            });
            match (mode, answer.unwrap()) {
                ("selected", Ok(Some(paths))) => {
                    assert_eq!(paths, vec![path.clone()]);
                    let owner = SelectionAuthority::default();
                    let id = selection_id().unwrap();
                    let lease = "ui_gtk_selection_fixture";
                    let receipt = owner
                        .select(paths[0].clone(), &id, lease, &profile)
                        .unwrap();
                    assert_eq!(receipt["size"], 3);
                    assert_eq!(
                        owner
                            .invoke(
                                "host.attachment.selection.read",
                                &json!({"selectionId":id,"leaseId":lease,"offset":0,"length":3}),
                                || Ok(())
                            )
                            .unwrap(),
                        json!({"data":"YWJj"})
                    );
                    assert_eq!(
                        owner
                            .invoke(
                                "host.attachment.selection.finish",
                                &json!({"selectionId":id,"leaseId":lease}),
                                || Ok(())
                            )
                            .unwrap(),
                        json!({"verified":true})
                    );
                    owner
                        .invoke(
                            "host.attachment.selection.retire",
                            &json!({"selectionId":id,"leaseId":lease}),
                            || Ok(()),
                        )
                        .unwrap();
                    owner.close().unwrap();
                }
                ("cancelled", Ok(None)) => {}
                ("revoked", Err(error)) => assert_eq!(error.code, "DISCONNECTED"),
                (_, value) => panic!("unexpected {mode} result: {value:?}"),
            }
        }
        unsafe {
            parent.destroy();
        }
        std::fs::remove_dir_all(base).unwrap();
    }
}
