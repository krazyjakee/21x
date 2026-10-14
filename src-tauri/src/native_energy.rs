//! Linux suspend-only portal ownership. A method handle is not backend success:
//! https://github.com/flatpak/xdg-desktop-portal/blob/1.20.4/src/inhibit.c
//! requires the matching Request.Response as well. Each acquisition has its own
//! PRIVATE connection; release never closes GIO's shared session-bus connection.
//! Disconnect cleanup chain at the same upstream tag: xdg-desktop-portal.c
//! peer_died_cb -> xdp-utils.c name-owner tracking -> xdp-request.c
//! close_requests_for_sender invokes backend Close for that unique sender.
use super::native_services::NativeWorkOwner;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering},
    Arc, Mutex, Weak,
};
use twentyonex_engine::EngineError;

pub(crate) type Scope = Arc<dyn Fn() -> Result<(), EngineError> + Send + Sync>;
static NEXT: AtomicU64 = AtomicU64::new(1);
const WAITING: u8 = 0;
const ACCEPTED: u8 = 1;
const CANCELLED: u8 = 2;
fn unique_name(value: &str) -> bool {
    let Some((major, minor)) = value.strip_prefix(':').and_then(|v| v.split_once('.')) else {
        return false;
    };
    value.len() <= 128
        && !major.is_empty()
        && !minor.is_empty()
        && major
            .bytes()
            .chain(minor.bytes())
            .all(|b| b.is_ascii_digit())
}
fn expected_handle(sender: &str, token: &str) -> Option<String> {
    let suffix = token.strip_prefix("twentyonex_")?;
    if !unique_name(sender)
        || suffix.len() != 32
        || !suffix
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return None;
    }
    Some(format!(
        "/org/freedesktop/portal/desktop/request/{}/{}",
        sender[1..].replace('.', "_"),
        token
    ))
}
struct CallLifetime {
    state: Arc<AtomicU8>,
    committed: bool,
}
impl Drop for CallLifetime {
    fn drop(&mut self) {
        if !self.committed {
            self.state.store(CANCELLED, Ordering::SeqCst);
        }
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
    let result = response.recv();
    while retired.recv().is_ok() {}
    scheduled?;
    result.map_err(|_| EngineError::new("DISCONNECTED"))?
}
type ReleaseReceiver = tokio::sync::watch::Receiver<Option<Result<(), EngineError>>>;
struct Inner {
    app: tauri::AppHandle,
    work: NativeWorkOwner,
    id: u64,
    generation: AtomicU64,
    closing: AtomicBool,
    acquiring: AtomicBool,
    pending: AtomicUsize,
    settled: tokio::sync::Notify,
    release: Mutex<Option<ReleaseReceiver>>,
}
struct Acquisition(Arc<Inner>);
impl Drop for Acquisition {
    fn drop(&mut self) {
        self.0.acquiring.store(false, Ordering::SeqCst);
        self.0.pending.fetch_sub(1, Ordering::SeqCst);
        self.0.settled.notify_waiters();
    }
}
#[derive(Clone)]
pub struct NativeEnergyOwner(Arc<Inner>);
impl NativeEnergyOwner {
    /// Lazy construction accepts no bus connection, inhibitor or timer.
    pub fn new(app: &tauri::AppHandle, work: NativeWorkOwner) -> Result<Self, EngineError> {
        work.assert_open()?;
        Ok(Self(Arc::new(Inner {
            app: app.clone(),
            work,
            id: NEXT.fetch_add(1, Ordering::Relaxed),
            generation: AtomicU64::new(0),
            closing: AtomicBool::new(false),
            acquiring: AtomicBool::new(false),
            pending: AtomicUsize::new(0),
            settled: tokio::sync::Notify::new(),
            release: Mutex::new(None),
        })))
    }
    pub async fn set_active(&self, active: bool, current: Scope) -> Result<bool, EngineError> {
        if !active {
            wait_release(begin_release(self.0.clone(), false)?).await?;
            return Ok(false);
        }
        current()?;
        self.0.work.assert_open()?;
        #[cfg(not(target_os = "linux"))]
        {
            Ok(false)
        }
        #[cfg(target_os = "linux")]
        {
            let generation = {
                let release = self
                    .0
                    .release
                    .lock()
                    .map_err(|_| EngineError::new("DISCONNECTED"))?;
                if self.0.closing.load(Ordering::SeqCst) {
                    return Err(EngineError::new("DISCONNECTED"));
                }
                if release
                    .as_ref()
                    .is_some_and(|r| r.borrow().as_ref().is_none_or(|result| result.is_err()))
                {
                    return Err(EngineError::new("BACKPRESSURE"));
                }
                self.0
                    .acquiring
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .map_err(|_| EngineError::new("BACKPRESSURE"))?;
                self.0.pending.fetch_add(1, Ordering::SeqCst);
                self.0.generation.load(Ordering::SeqCst)
            };
            let state = Arc::new(AtomicU8::new(WAITING));
            let mut call = CallLifetime {
                state: state.clone(),
                committed: false,
            };
            let owner = self.0.clone();
            let weak = Arc::downgrade(&owner);
            let current: Scope = Arc::new(move || {
                let owner = weak
                    .upgrade()
                    .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
                if owner.closing.load(Ordering::SeqCst)
                    || owner.generation.load(Ordering::SeqCst) != generation
                    || state.load(Ordering::SeqCst) == CANCELLED
                {
                    return Err(EngineError::new("CANCELLED"));
                }
                owner.work.assert_open()?;
                current()
            });
            let accepted_current = current.clone();
            let (receive, reply) = tokio::sync::oneshot::channel();
            tauri::async_runtime::spawn(async move {
                let _owned = Acquisition(owner.clone());
                let result = acquire(owner, current).await;
                let _ = receive.send(result);
            });
            let result = reply
                .await
                .map_err(|_| EngineError::new("DISCONNECTED"))??;
            if result {
                accepted_current()?;
                call.state.store(ACCEPTED, Ordering::SeqCst);
                call.committed = true;
            }
            Ok(result)
        }
    }
    pub async fn close(&self) -> Result<(), EngineError> {
        wait_release(begin_release(self.0.clone(), true)?).await
    }
}
fn begin_release(owner: Arc<Inner>, permanent: bool) -> Result<ReleaseReceiver, EngineError> {
    let mut slot = owner
        .release
        .lock()
        .map_err(|_| EngineError::new("DISCONNECTED"))?;
    let was_closed = owner.closing.load(Ordering::SeqCst);
    if permanent {
        owner.closing.store(true, Ordering::SeqCst);
    }
    if let Some(receiver) = slot.as_ref() {
        let pending = receiver.borrow().is_none();
        let complete = receiver
            .borrow()
            .as_ref()
            .is_some_and(|result| result.is_ok());
        if pending || was_closed && complete {
            return Ok(receiver.clone());
        }
    }
    // Fence a queued/opening acquisition before scheduling cleanup. Never wait
    // for a permission Response before closing its privately owned connection.
    owner.generation.fetch_add(1, Ordering::SeqCst);
    let (sender, receiver) = tokio::sync::watch::channel(None);
    *slot = Some(receiver.clone());
    let owned = owner.clone();
    tauri::async_runtime::spawn(async move {
        let result = release_owned(owned).await;
        let _ = sender.send(Some(result));
    });
    Ok(receiver)
}
async fn wait_release(mut receiver: ReleaseReceiver) -> Result<(), EngineError> {
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
async fn wait_acquisitions(owner: &Inner) {
    loop {
        let settled = owner.settled.notified();
        tokio::pin!(settled);
        settled.as_mut().enable();
        if owner.pending.load(Ordering::SeqCst) == 0 {
            return;
        }
        settled.await;
    }
}
async fn retained_release(
    schedule: impl FnOnce(Completion<Option<std::sync::mpsc::Receiver<()>>>) -> Result<(), EngineError>
        + Send
        + 'static,
) -> Result<(), EngineError> {
    let retired = tauri::async_runtime::spawn_blocking(move || join_gui(schedule))
        .await
        .map_err(|_| EngineError::new("INTERNAL_ERROR"))??;
    if let Some(retired) = retired {
        tauri::async_runtime::spawn_blocking(move || while retired.recv().is_ok() {})
            .await
            .map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
    }
    Ok(())
}
#[cfg(target_os = "linux")]
async fn acquire(owner: Arc<Inner>, current: Scope) -> Result<bool, EngineError> {
    let output = Arc::new(Mutex::new(None));
    let stored = output.clone();
    let work = owner.work.clone();
    work.run(move || {
        current()?;
        let Some(prepared) = linux::prepare() else {
            *stored
                .lock()
                .map_err(|_| EngineError::new("DISCONNECTED"))? = Some(false);
            return Ok(());
        };
        current()?;
        let app = owner.app.clone();
        let result = join_gui(move |completion| {
            app.run_on_main_thread(move || linux::begin(owner, current, prepared, completion))
                .map_err(|_| EngineError::new("DISCONNECTED"))
        })?;
        *stored
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))? = Some(result);
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
async fn release_owned(owner: Arc<Inner>) -> Result<(), EngineError> {
    #[cfg(target_os = "linux")]
    {
        let app = owner.app.clone();
        let weak = Arc::downgrade(&owner);
        retained_release(move |completion| {
            app.run_on_main_thread(move || linux::release(weak, completion))
                .map_err(|_| EngineError::new("DISCONNECTED"))
        })
        .await?;
    }
    // Accepted raw address/connection/Response callbacks still own their leases.
    // A queued acquisition fenced above cannot create a later inhibitor.
    wait_acquisitions(&owner).await;
    Ok(())
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use gio::prelude::*;
    use gtk::{
        gio,
        glib::{self, variant::ToVariant},
    };
    use std::{
        cell::RefCell,
        collections::HashMap,
        io::Read,
        panic::{catch_unwind, AssertUnwindSafe},
        rc::Rc,
        time::{Duration, Instant},
    };
    const PORTAL: &str = "org.freedesktop.portal.Desktop";
    const DESKTOP: &str = "/org/freedesktop/portal/desktop";
    const REQUEST: &str = "org.freedesktop.portal.Request";
    pub(super) struct Prepared {
        address: String,
        token: String,
    }
    pub(super) fn prepare() -> Option<Prepared> {
        // Blocking OS discovery/randomness only on retained NativeWorkOwner.
        let address =
            gio::dbus_address_get_for_bus_sync(gio::BusType::Session, None::<&gio::Cancellable>)
                .ok()?;
        if address.is_empty() || address.len() > 4096 {
            return None;
        }
        let mut random = [0u8; 16];
        std::fs::File::open("/dev/urandom")
            .ok()?
            .read_exact(&mut random)
            .ok()?;
        let token = format!(
            "twentyonex_{}",
            random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        Some(Prepared {
            address: address.to_string(),
            token,
        })
    }
    fn owner_name(value: &glib::Variant) -> Option<String> {
        if value.size() > 256 || value.type_().as_str() != "(s)" {
            return None;
        }
        let name = value.get::<(String,)>()?.0;
        unique_name(&name).then_some(name)
    }
    fn method_handle(value: &glib::Variant, expected: &str) -> bool {
        value.size() <= 512
            && value.type_().as_str() == "(o)"
            && value.child_value(0).str() == Some(expected)
    }
    fn response(value: &glib::Variant) -> Option<u32> {
        if value.size() > 128
            || value.type_().as_str() != "(ua{sv})"
            || value.child_value(1).n_children() != 0
        {
            return None;
        }
        let code = value.child_value(0).get::<u32>()?;
        (code <= 2).then_some(code)
    }
    fn applied_proof(method_ack: bool, response: Option<u32>, valid: bool, retiring: bool) -> bool {
        method_ack && response == Some(0) && valid && !retiring
    }
    fn needs_release(applied: bool, age: Duration, valid: bool, connection_closed: bool) -> bool {
        !valid || connection_closed || !applied && age >= Duration::from_secs(5)
    }
    fn name_changed(value: &glib::Variant, expected: &str) -> bool {
        if value.size() > 512 || value.type_().as_str() != "(sss)" {
            return true;
        }
        let Some((name, old, new)) = value.get::<(String, String, String)>() else {
            return true;
        };
        name == PORTAL && old == expected && new != expected
    }
    struct Lifetime {
        _sender: std::sync::mpsc::Sender<()>,
    }
    impl Drop for Lifetime {
        fn drop(&mut self) {}
    }
    struct Session {
        owner: Weak<Inner>,
        current: Scope,
        connection: Option<gio::DBusConnection>,
        opening: bool,
        connect_cancel: gio::Cancellable,
        token: String,
        server: String,
        path: String,
        method_ack: bool,
        response: Option<u32>,
        applied: bool,
        retiring: bool,
        releasing: bool,
        pending: Option<Rc<Completion<bool>>>,
        cleanup: Option<Rc<Completion<Option<std::sync::mpsc::Receiver<()>>>>>,
        timer: Option<glib::SourceId>,
        subscriptions: Vec<gio::SignalSubscriptionId>,
        sender: Option<std::sync::mpsc::Sender<()>>,
        retired: Option<std::sync::mpsc::Receiver<()>>,
        started: Instant,
    }
    thread_local! {static SESSIONS:RefCell<HashMap<u64,Rc<RefCell<Session>>>>=RefCell::new(HashMap::new());}
    fn valid(session: &Session) -> bool {
        !session.retiring
            && catch_unwind(AssertUnwindSafe(|| (session.current)()))
                .is_ok_and(|result| result.is_ok())
    }
    fn force_release(session: &Rc<RefCell<Session>>) {
        let owner = {
            let mut state = session.borrow_mut();
            state.retiring = true;
            state.owner.upgrade()
        };
        if let Some(owner) = owner {
            let _ = begin_release(owner, false);
        }
    }
    fn protect(session: &Rc<RefCell<Session>>, effect: impl FnOnce()) {
        if catch_unwind(AssertUnwindSafe(effect)).is_err() {
            force_release(session);
        }
    }
    fn maybe_applied(session: &Rc<RefCell<Session>>) {
        let completion = {
            let mut state = session.borrow_mut();
            if !valid(&state) {
                drop(state);
                force_release(session);
                return;
            }
            if applied_proof(state.method_ack, state.response, true, state.retiring) {
                state.applied = true;
                state.pending.take()
            } else {
                None
            }
        };
        if let Some(completion) = completion {
            completion.finish(Ok(true));
        }
    }
    fn call(
        session: &Rc<RefCell<Session>>,
        destination: &str,
        path: &str,
        interface: &str,
        method: &str,
        params: glib::Variant,
        callback: impl FnOnce(Result<glib::Variant, glib::Error>) + 'static,
    ) {
        let (connection, hold) = {
            let state = session.borrow();
            (
                state.connection.as_ref().unwrap().clone(),
                state.pending.clone(),
            )
        };
        let retained = session.clone();
        connection.call(
            Some(destination),
            path,
            interface,
            method,
            Some(&params),
            None,
            gio::DBusCallFlags::NO_AUTO_START,
            2000,
            None::<&gio::Cancellable>,
            move |result| {
                protect(&retained, || callback(result));
                drop(hold); // actual callback lifetime, not reply
            },
        );
    }
    pub(super) fn begin(
        owner: Arc<Inner>,
        current: Scope,
        prepared: Prepared,
        completion: Completion<bool>,
    ) {
        let completion = Rc::new(completion);
        let result = catch_unwind(AssertUnwindSafe(|| -> Result<(), EngineError> {
            current()?;
            let existing = SESSIONS.with(|sessions| sessions.borrow().get(&owner.id).cloned());
            if let Some(session) = existing {
                let state = session.borrow();
                if state.applied
                    && valid(&state)
                    && state
                        .connection
                        .as_ref()
                        .is_some_and(|connection| !connection.is_closed())
                {
                    completion.finish(Ok(true));
                    return Ok(());
                }
                drop(state);
                session.borrow_mut().pending = Some(completion.clone());
                force_release(&session);
                return Ok(());
            }
            let (sender, retired) = std::sync::mpsc::channel();
            let connect_cancel = gio::Cancellable::new();
            let session = Rc::new(RefCell::new(Session {
                owner: Arc::downgrade(&owner),
                current,
                connection: None,
                opening: true,
                connect_cancel: connect_cancel.clone(),
                token: prepared.token,
                server: String::new(),
                path: String::new(),
                method_ack: false,
                response: None,
                applied: false,
                retiring: false,
                releasing: false,
                pending: Some(completion.clone()),
                cleanup: None,
                timer: None,
                subscriptions: Vec::new(),
                sender: Some(sender.clone()),
                retired: Some(retired),
                started: Instant::now(),
            }));
            SESSIONS.with(|sessions| {
                sessions.borrow_mut().insert(owner.id, session.clone());
            });
            let weak = Rc::downgrade(&session);
            let lifetime = Lifetime { _sender: sender };
            let timer = glib::timeout_add_local(Duration::from_millis(250), move || {
                let _keep = &lifetime;
                if let Some(session) = weak.upgrade() {
                    protect(&session, || {
                        let state = session.borrow();
                        let release = needs_release(
                            state.applied,
                            state.started.elapsed(),
                            valid(&state),
                            state
                                .connection
                                .as_ref()
                                .is_some_and(|connection| connection.is_closed()),
                        );
                        drop(state);
                        if release {
                            force_release(&session);
                        }
                    });
                }
                glib::ControlFlow::Continue
            });
            session.borrow_mut().timer = Some(timer);
            let retained = session.clone();
            let hold = completion.clone();
            gio::DBusConnection::for_address(
                &prepared.address,
                gio::DBusConnectionFlags::AUTHENTICATION_CLIENT
                    | gio::DBusConnectionFlags::MESSAGE_BUS_CONNECTION,
                None,
                Some(&connect_cancel),
                move |result| {
                    protect(&retained, || {
                        {
                            let mut state = retained.borrow_mut();
                            state.opening = false;
                            if let Ok(connection) = result {
                                connection.set_exit_on_close(false);
                                state.connection = Some(connection);
                            }
                        }
                        if !valid(&retained.borrow()) || retained.borrow().connection.is_none() {
                            force_release(&retained);
                            advance_release(&retained);
                            return;
                        }
                        let sender = retained
                            .borrow()
                            .connection
                            .as_ref()
                            .unwrap()
                            .unique_name()
                            .map(|name| name.to_string())
                            .unwrap_or_default();
                        let token = retained.borrow().token.clone();
                        let path = expected_handle(&sender, &token);
                        let Some(path) = path else {
                            force_release(&retained);
                            return;
                        };
                        retained.borrow_mut().path = path;
                        activate_portal(retained.clone());
                    });
                    drop(hold);
                },
            );
            Ok(())
        }))
        .unwrap_or_else(|_| Err(EngineError::new("INTERNAL_ERROR")));
        if let Err(error) = result {
            completion.finish(Err(error));
        }
    }
    fn activate_portal(session: Rc<RefCell<Session>>) {
        if !valid(&session.borrow()) {
            force_release(&session);
            return;
        }
        let retained = session.clone();
        call(
            &session,
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "StartServiceByName",
            (PORTAL, 0u32).to_variant(),
            move |result| {
                if !valid(&retained.borrow()) {
                    force_release(&retained);
                    return;
                }
                let ok = result.ok().is_some_and(|value| {
                    value.size() <= 16
                        && value.type_().as_str() == "(u)"
                        && value.get::<(u32,)>().is_some_and(|v| matches!(v.0, 1 | 2))
                });
                if !ok {
                    force_release(&retained);
                    return;
                }
                capture_server(retained);
            },
        );
    }
    fn capture_server(session: Rc<RefCell<Session>>) {
        let retained = session.clone();
        call(
            &session,
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "GetNameOwner",
            (PORTAL,).to_variant(),
            move |result| {
                if !valid(&retained.borrow()) {
                    force_release(&retained);
                    return;
                }
                let Some(server) = result.ok().and_then(|value| owner_name(&value)) else {
                    force_release(&retained);
                    return;
                };
                retained.borrow_mut().server = server;
                subscribe(&retained);
                inhibit(retained);
            },
        );
    }
    fn subscribe(session: &Rc<RefCell<Session>>) {
        let (connection, server, path, sender) = {
            let state = session.borrow();
            (
                state.connection.as_ref().unwrap().clone(),
                state.server.clone(),
                state.path.clone(),
                state.sender.as_ref().unwrap().clone(),
            )
        };
        let weak = Rc::downgrade(session);
        let lifetime = Lifetime {
            _sender: sender.clone(),
        };
        let response_id = connection.signal_subscribe(
            Some(&server),
            Some(REQUEST),
            Some("Response"),
            Some(&path),
            None,
            gio::DBusSignalFlags::NONE,
            move |connection, sender, path, interface, member, value| {
                let _keep = &lifetime;
                let Some(session) = weak.upgrade() else {
                    return;
                };
                let hold = session.borrow().pending.clone();
                protect(&session, || {
                    let state = session.borrow();
                    if state.connection.as_ref() != Some(connection)
                        || sender != state.server
                        || path != state.path
                        || interface != REQUEST
                        || member != "Response"
                    {
                        return;
                    }
                    drop(state);
                    let code = response(value);
                    if code != Some(0) {
                        force_release(&session);
                        return;
                    }
                    session.borrow_mut().response = code;
                    maybe_applied(&session);
                });
                drop(hold);
            },
        );
        let weak = Rc::downgrade(session);
        let lifetime = Lifetime { _sender: sender };
        let owner_id = connection.signal_subscribe(
            Some("org.freedesktop.DBus"),
            Some("org.freedesktop.DBus"),
            Some("NameOwnerChanged"),
            Some("/org/freedesktop/DBus"),
            Some(PORTAL),
            gio::DBusSignalFlags::NONE,
            move |connection, sender, path, interface, member, value| {
                let _keep = &lifetime;
                let Some(session) = weak.upgrade() else {
                    return;
                };
                let hold = session.borrow().pending.clone();
                protect(&session, || {
                    let state = session.borrow();
                    if state.connection.as_ref() != Some(connection)
                        || sender != "org.freedesktop.DBus"
                        || path != "/org/freedesktop/DBus"
                        || interface != "org.freedesktop.DBus"
                        || member != "NameOwnerChanged"
                    {
                        return;
                    }
                    let changed = name_changed(value, &state.server);
                    drop(state);
                    if changed {
                        force_release(&session);
                    }
                });
                drop(hold);
            },
        );
        let mut state = session.borrow_mut();
        state.subscriptions = vec![response_id, owner_id];
        state.sender.take();
    }
    fn inhibit(session: Rc<RefCell<Session>>) {
        if !valid(&session.borrow()) {
            force_release(&session);
            return;
        }
        let (server, token) = {
            let state = session.borrow();
            (state.server.clone(), state.token.clone())
        };
        let mut options = HashMap::<String, glib::Variant>::new();
        options.insert("handle_token".to_owned(), token.to_variant());
        options.insert(
            "reason".to_owned(),
            "Agent sessions are running".to_variant(),
        );
        let retained = session.clone();
        // Response subscriptions above exist BEFORE this sole acquisition effect.
        call(
            &session,
            &server,
            DESKTOP,
            "org.freedesktop.portal.Inhibit",
            "Inhibit",
            ("", 4u32, options).to_variant(),
            move |result| {
                let state = retained.borrow();
                let acknowledged = result
                    .ok()
                    .is_some_and(|value| method_handle(&value, &state.path));
                drop(state);
                if !acknowledged {
                    force_release(&retained);
                    return;
                }
                retained.borrow_mut().method_ack = true;
                maybe_applied(&retained);
            },
        );
    }
    pub(super) fn release(
        owner: Weak<Inner>,
        completion: Completion<Option<std::sync::mpsc::Receiver<()>>>,
    ) {
        let completion = Rc::new(completion);
        let result = catch_unwind(AssertUnwindSafe(|| -> Result<(), EngineError> {
            let Some(owner) = owner.upgrade() else {
                return Err(EngineError::new("DISCONNECTED"));
            };
            let session = SESSIONS.with(|sessions| sessions.borrow().get(&owner.id).cloned());
            let Some(session) = session else {
                completion.finish(Ok(None));
                return Ok(());
            };
            {
                let mut state = session.borrow_mut();
                state.retiring = true;
                state.cleanup = Some(completion.clone());
            }
            advance_release(&session);
            Ok(())
        }))
        .unwrap_or_else(|_| Err(EngineError::new("INTERNAL_ERROR")));
        if let Err(error) = result {
            completion.finish(Err(error));
        }
    }
    fn advance_release(session: &Rc<RefCell<Session>>) {
        let connecting = {
            let state = session.borrow();
            (state.retiring && state.opening).then(|| state.connect_cancel.clone())
        };
        if let Some(connecting) = connecting {
            connecting.cancel();
            return;
        }
        let (connection, control) = {
            let mut state = session.borrow_mut();
            if !state.retiring || state.releasing || state.opening || state.cleanup.is_none() {
                return;
            }
            state.releasing = true;
            (
                state.connection.clone(),
                state.cleanup.as_ref().unwrap().clone(),
            )
        };
        let Some(connection) = connection else {
            finish_release(session, true);
            return;
        };
        if connection.is_closed() {
            finish_release(session, true);
            return;
        }
        let retained = session.clone();
        let captured = connection.clone();
        connection.close(None::<&gio::Cancellable>, move |result| {
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                finish_release(&retained, result.is_ok() || captured.is_closed())
            }));
            if outcome.is_err() {
                control.finish(Err(EngineError::new("INTERNAL_ERROR")));
            }
            drop(control); // preserve actual GIO close callback lifetime
        });
    }
    fn finish_release(session: &Rc<RefCell<Session>>, success: bool) {
        if !success {
            let completion = {
                let mut state = session.borrow_mut();
                state.releasing = false;
                state.cleanup.take()
            };
            if let Some(completion) = completion {
                completion.finish(Err(EngineError::new("DISCONNECTED")));
            }
            return;
        }
        let (connection, subscriptions, timer, retired, pending, control, owner) = {
            let mut state = session.borrow_mut();
            state.applied = false;
            state.releasing = false;
            (
                state.connection.take(),
                std::mem::take(&mut state.subscriptions),
                state.timer.take(),
                state.retired.take(),
                state.pending.take(),
                state.cleanup.take(),
                state.owner.upgrade(),
            )
        };
        if let Some(connection) = connection {
            for subscription in subscriptions {
                connection.signal_unsubscribe(subscription);
            }
        }
        if let Some(timer) = timer {
            timer.remove();
        }
        session.borrow_mut().sender.take();
        if let Some(owner) = owner {
            SESSIONS.with(|sessions| {
                sessions.borrow_mut().remove(&owner.id);
            });
        }
        if let Some(pending) = pending {
            pending.finish(Ok(false));
        }
        if let Some(control) = control {
            control.finish(Ok(retired));
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        use glib::variant::ObjectPath;
        #[test]
        fn portal_method_handle_is_exact_bounded_object_path_not_string_or_foreign_request() {
            let token = format!("twentyonex_{}", "a".repeat(32));
            let expected = expected_handle(":1.23", &token).unwrap();
            assert!(method_handle(
                &(ObjectPath::try_from(expected.as_str()).unwrap(),).to_variant(),
                &expected
            ));
            assert!(!method_handle(
                &(expected.as_str(),).to_variant(),
                &expected
            ));
            let foreign = expected_handle(":1.24", &token).unwrap();
            assert!(!method_handle(
                &(ObjectPath::try_from(foreign.as_str()).unwrap(),).to_variant(),
                &expected
            ));
            let large = format!("/{}", "x".repeat(1024));
            let value = (ObjectPath::try_from(large.as_str()).unwrap(),).to_variant();
            assert!(value.size() > 512);
            assert!(!method_handle(&value, &large));
        }
        #[test]
        fn response_is_only_exact_bounded_empty_results_and_known_status() {
            for code in 0u32..=2 {
                assert_eq!(
                    response(&(code, HashMap::<String, glib::Variant>::new()).to_variant()),
                    Some(code)
                );
            }
            assert_eq!(
                response(&(3u32, HashMap::<String, glib::Variant>::new()).to_variant()),
                None
            );
            let mut extra = HashMap::<String, glib::Variant>::new();
            extra.insert("injected".to_owned(), true.to_variant());
            assert_eq!(response(&(0u32, extra).to_variant()), None);
            let mut huge = HashMap::<String, glib::Variant>::new();
            huge.insert("private".to_owned(), "x".repeat(4096).to_variant());
            let value = (0u32, huge).to_variant();
            assert!(value.size() > 128);
            assert_eq!(response(&value), None);
            assert_eq!(response(&(0u32,).to_variant()), None);
            assert_eq!(
                response(&("0", HashMap::<String, glib::Variant>::new()).to_variant()),
                None
            );
        }
        #[test]
        fn owner_identity_and_change_projection_refuse_oversized_or_foreign_names() {
            assert_eq!(
                owner_name(&(":1.23",).to_variant()).as_deref(),
                Some(":1.23")
            );
            let giant = (format!(":1.{}", "1".repeat(4096)),).to_variant();
            assert!(giant.size() > 256);
            assert!(owner_name(&giant).is_none());
            assert!(owner_name(&(PORTAL,).to_variant()).is_none());
            assert!(name_changed(
                &(PORTAL, ":1.23", ":1.24").to_variant(),
                ":1.23"
            ));
            assert!(!name_changed(
                &(PORTAL, ":1.21", ":1.22").to_variant(),
                ":1.23"
            ));
            assert!(!name_changed(
                &("foreign.portal", ":1.23", ":1.24").to_variant(),
                ":1.23"
            ));
            assert!(name_changed(&("malformed",).to_variant(), ":1.23"));
        }
        #[test]
        fn response_before_reply_never_grants_active_until_both_proofs_and_cannot_resurrect_retired_request(
        ) {
            assert!(!applied_proof(false, Some(0), true, false));
            assert!(!applied_proof(true, None, true, false));
            assert!(applied_proof(true, Some(0), true, false));
            for response in [Some(1), Some(2), None] {
                assert!(!applied_proof(true, response, true, false));
            }
            assert!(!applied_proof(true, Some(0), false, false));
            assert!(!applied_proof(true, Some(0), true, true));
            assert!(needs_release(true, Duration::ZERO, false, false));
            assert!(needs_release(true, Duration::ZERO, true, true));
            assert!(needs_release(false, Duration::from_secs(5), true, false));
            assert!(!needs_release(true, Duration::from_secs(100), true, false));
        }
        #[test]
        fn actual_glib_source_destruction_retires_the_monitors_capture_without_a_display() {
            let context = glib::MainContext::new();
            let _ownership = context.acquire().unwrap();
            let (sender, retired) = std::sync::mpsc::channel::<()>();
            let lifetime = Lifetime { _sender: sender };
            let source = glib::source::timeout_source_new(
                Duration::from_millis(250),
                Some("21x-energy-test-monitor"),
                glib::Priority::DEFAULT,
                move || {
                    let _keep = &lifetime;
                    glib::ControlFlow::Continue
                },
            );
            let _id = source.attach(Some(&context));
            assert_eq!(
                retired.try_recv(),
                Err(std::sync::mpsc::TryRecvError::Empty)
            );
            source.destroy();
            drop(source);
            assert_eq!(
                retired.try_recv(),
                Err(std::sync::mpsc::TryRecvError::Disconnected)
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_namespace_is_exact_and_token_not_an_external_path_grant() {
        let token = format!("twentyonex_{}", "a".repeat(32));
        assert_eq!(
            expected_handle(":1.23", &token).unwrap(),
            format!("/org/freedesktop/portal/desktop/request/1_23/{token}")
        );
        for sender in ["1.23", ":1.", ":1.2.3", "/other", ""] {
            assert!(expected_handle(sender, &token).is_none());
        }
        for token in [
            "../other".to_owned(),
            "twentyonex_".to_owned(),
            format!("twentyonex_{}", "A".repeat(32)),
            format!("twentyonex_{}", "é".repeat(16)),
        ] {
            assert!(expected_handle(":1.23", &token).is_none());
        }
    }
    #[test]
    fn dropped_call_revokes_but_successful_applied_handoff_survives_waiter_return() {
        let state = Arc::new(AtomicU8::new(WAITING));
        {
            let _call = CallLifetime {
                state: state.clone(),
                committed: false,
            };
        }
        assert_eq!(state.load(Ordering::SeqCst), CANCELLED);
        let state = Arc::new(AtomicU8::new(WAITING));
        {
            let mut call = CallLifetime {
                state: state.clone(),
                committed: false,
            };
            call.state.store(ACCEPTED, Ordering::SeqCst);
            call.committed = true;
        }
        assert_eq!(state.load(Ordering::SeqCst), ACCEPTED);
    }
    #[tokio::test]
    async fn early_gui_reply_is_not_actual_callback_retirement() {
        let work = NativeWorkOwner::default();
        let retained = work.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let raw = tokio::spawn(async move {
            retained
                .run(move || {
                    let applied = join_gui(move |completion: Completion<bool>| {
                        let _ = tx.send(completion);
                        Ok(())
                    })?;
                    assert!(applied);
                    Ok(())
                })
                .await
        });
        let completion = rx.await.unwrap();
        completion.finish(Ok(true));
        assert!(!raw.is_finished());
        assert_eq!(work.active().unwrap(), 1);
        drop(completion);
        raw.await.unwrap().unwrap();
        work.drain().await.unwrap();
        assert_eq!(work.active().unwrap(), 0);
    }
    #[tokio::test]
    async fn failed_scheduling_keeps_accepted_callback_ownership() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let raw = tauri::async_runtime::spawn_blocking(move || {
            join_gui(move |completion: Completion<bool>| {
                let _ = tx.send(completion);
                Err(EngineError::new("DISCONNECTED"))
            })
        });
        let completion = rx.await.unwrap();
        completion.finish(Ok(false));
        assert!(!raw.inner().is_finished());
        drop(completion);
        assert_eq!(raw.await.unwrap().unwrap_err().code, "DISCONNECTED");
    }
    #[tokio::test]
    async fn dropped_public_waiter_does_not_abandon_accepted_native_raw_work() {
        let work = NativeWorkOwner::default();
        let retained = work.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let raw = tokio::spawn(async move {
            retained
                .run(move || {
                    join_gui(move |completion: Completion<bool>| {
                        let _ = tx.send(completion);
                        Ok(())
                    })?;
                    Ok(())
                })
                .await
        });
        let completion = rx.await.unwrap();
        raw.abort();
        let _ = raw.await;
        work.close().unwrap();
        assert_eq!(work.active().unwrap(), 1);
        completion.finish(Ok(false));
        assert_eq!(work.active().unwrap(), 1);
        drop(completion);
        work.drain().await.unwrap();
        assert_eq!(work.active().unwrap(), 0);
    }
    #[tokio::test]
    async fn cleanup_is_independent_of_closed_work_and_joins_signal_timer_capture_retirement() {
        let work = NativeWorkOwner::default();
        work.close().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(retained_release(move |completion| {
            let _ = tx.send(completion);
            Ok(())
        }));
        let completion = rx.await.unwrap();
        let (signal, retired) = std::sync::mpsc::channel::<()>();
        completion.finish(Ok(Some(retired)));
        assert!(!task.is_finished());
        drop(completion);
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        drop(signal);
        task.await.unwrap().unwrap();
        work.drain().await.unwrap();
    }
    #[tokio::test]
    async fn failed_cleanup_requires_real_callback_retirement_and_never_reports_inactive() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(retained_release(move |completion| {
            let _ = tx.send(completion);
            Ok(())
        }));
        let completion = rx.await.unwrap();
        completion.finish(Err(EngineError::new("DISCONNECTED")));
        assert!(!task.is_finished());
        drop(completion);
        assert_eq!(task.await.unwrap().unwrap_err().code, "DISCONNECTED");
    }
}
