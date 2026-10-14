//! Preview Linux notifications through the session bus. Notification IDs and
//! signal authority belong to one captured connection and unique server name.
use super::native_services::NativeWorkOwner;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::Manager;
use twentyonex_engine::EngineError;

pub(crate) type Scope = Arc<dyn Fn() -> Result<(), EngineError> + Send + Sync>;
const MAX_NOTIFICATIONS: usize = 64;
static NEXT: AtomicU64 = AtomicU64::new(1);
fn text(value: &str, limit: usize, multiline: bool, required: bool) -> bool {
    (!required || !value.is_empty())
        && value.len() <= limit
        && !value.chars().any(|c| {
            c == '\u{007f}' || c < '\u{0020}' && !(multiline && matches!(c, '\t' | '\r' | '\n'))
        })
}
fn payload(title: &str, body: &str) -> bool {
    text(title, 160, false, true) && text(body, 2048, true, false)
}
fn escape_markup(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn unique_name(value: &str) -> bool {
    let Some(value) = value.strip_prefix(':') else {
        return false;
    };
    let Some((major, minor)) = value.split_once('.') else {
        return false;
    };
    value.len() <= 127
        && !major.is_empty()
        && !minor.is_empty()
        && major
            .bytes()
            .chain(minor.bytes())
            .all(|b| b.is_ascii_digit())
}
fn owned_action(sender: &str, server: &str, action: &str, owned: bool, closing: bool) -> bool {
    !closing && owned && unique_name(server) && sender == server && action == "openapp"
}
fn same_server(expected: &str, observed: &str, same_connection: bool, closing: bool) -> bool {
    !closing && same_connection && unique_name(observed) && expected == observed
}
fn capacity(delivered: usize, pending: usize) -> bool {
    delivered.saturating_add(pending) < MAX_NOTIFICATIONS
}
struct Active(Arc<AtomicBool>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
struct Request {
    current: Scope,
    reply: std::sync::mpsc::Sender<Result<bool, EngineError>>,
    _lifetime: std::sync::mpsc::Sender<()>,
}
impl Drop for Request {
    fn drop(&mut self) {}
}
impl Request {
    fn finish(&self, result: Result<bool, EngineError>) {
        let _ = self.reply.send(result);
    }
}
struct Cleanup {
    reply: std::sync::mpsc::Sender<Result<(), EngineError>>,
    signals: std::sync::mpsc::Sender<std::sync::mpsc::Receiver<()>>,
    _lifetime: std::sync::mpsc::Sender<()>,
}
impl Drop for Cleanup {
    fn drop(&mut self) {}
}
async fn retained_cleanup(
    schedule: impl FnOnce(Cleanup) -> Result<(), EngineError> + Send + 'static,
) -> Result<(), EngineError> {
    tauri::async_runtime::spawn_blocking(move || {
        let (reply, response) = std::sync::mpsc::channel();
        let (lifetime, retired) = std::sync::mpsc::channel::<()>();
        let (signals, subscriptions) = std::sync::mpsc::channel();
        let scheduled = schedule(Cleanup {
            reply,
            signals,
            _lifetime: lifetime,
        });
        let answer = response.recv();
        while retired.recv().is_ok() {}
        // Signal unsubscribe is not closure destruction. Every accepted signal
        // capture must actually retire, even when a close call or schedule fails.
        while let Ok(signal) = subscriptions.recv() {
            while signal.recv().is_ok() {}
        }
        scheduled?;
        answer.map_err(|_| EngineError::new("DISCONNECTED"))?
    })
    .await
    .map_err(|_| EngineError::new("INTERNAL_ERROR"))?
}
async fn retained_request(
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
    let result = Arc::new(Mutex::new(None));
    let stored = result.clone();
    work.run(move || {
        current()?;
        let (reply, response) = std::sync::mpsc::channel();
        let (lifetime, retired) = std::sync::mpsc::channel::<()>();
        let scheduled = schedule(Request {
            current: current.clone(),
            reply,
            _lifetime: lifetime,
        });
        let answer = response.recv();
        while retired.recv().is_ok() {}
        scheduled?;
        let answer = answer.map_err(|_| EngineError::new("DISCONNECTED"))??;
        current()?;
        *stored
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))? = Some(answer);
        Ok(())
    })
    .await?;
    let answer = result
        .lock()
        .map_err(|_| EngineError::new("DISCONNECTED"))?
        .take()
        .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
    Ok(answer)
}
struct Inner {
    app: tauri::AppHandle,
    work: NativeWorkOwner,
    id: u64,
    closing: Arc<AtomicBool>,
    close: Mutex<Option<tokio::sync::watch::Receiver<Option<Result<(), EngineError>>>>>,
}
#[derive(Clone)]
pub struct NativeNotificationOwner(Arc<Inner>);
impl NativeNotificationOwner {
    pub fn new(app: &tauri::AppHandle, work: NativeWorkOwner) -> Result<Self, EngineError> {
        work.assert_open()?;
        Ok(Self(Arc::new(Inner {
            app: app.clone(),
            work,
            id: NEXT.fetch_add(1, Ordering::Relaxed),
            closing: Arc::new(AtomicBool::new(false)),
            close: Mutex::new(None),
        })))
    }
    fn scope(&self, current: Scope) -> Scope {
        let closing = self.0.closing.clone();
        let work = self.0.work.clone();
        Arc::new(move || {
            if closing.load(Ordering::SeqCst) {
                return Err(EngineError::new("DISCONNECTED"));
            }
            work.assert_open()?;
            current()
        })
    }
    pub async fn permission(&self, current: Scope) -> Result<String, EngineError> {
        let current = self.scope(current);
        current()?;
        #[cfg(not(target_os = "linux"))]
        {
            Ok("denied".to_owned())
        }
        #[cfg(target_os = "linux")]
        {
            Ok(if self.request(None, current).await? {
                "granted"
            } else {
                "denied"
            }
            .to_owned())
        }
    }
    pub async fn show(
        &self,
        title: String,
        body: String,
        only_when_inactive: bool,
        current: Scope,
    ) -> Result<bool, EngineError> {
        if !payload(&title, &body) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        let current = self.scope(current);
        current()?;
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (title, body, only_when_inactive);
            Ok(false)
        }
        #[cfg(target_os = "linux")]
        {
            self.request(Some((title, body, only_when_inactive)), current)
                .await
        }
    }
    #[cfg(target_os = "linux")]
    async fn request(
        &self,
        message: Option<(String, String, bool)>,
        current: Scope,
    ) -> Result<bool, EngineError> {
        let (app, id, closing) = (self.0.app.clone(), self.0.id, self.0.closing.clone());
        let public = retained_request(self.0.work.clone(), current, move |request| {
            let callback_app = app.clone();
            app.run_on_main_thread(move || {
                linux::begin(id, callback_app, closing, message, request)
            })
            .map_err(|_| EngineError::new("DISCONNECTED"))
        });
        // Timeout revokes future effects; raw GIO callbacks are still joined.
        tokio::time::timeout(std::time::Duration::from_secs(5), public)
            .await
            .map_err(|_| EngineError::new("TIMEOUT"))?
    }
    pub async fn close(&self) -> Result<(), EngineError> {
        self.0.closing.store(true, Ordering::SeqCst);
        let mut receiver = {
            let mut slot = self
                .0
                .close
                .lock()
                .map_err(|_| EngineError::new("DISCONNECTED"))?;
            let failed = slot.as_ref().is_some_and(|receiver| {
                receiver
                    .borrow()
                    .as_ref()
                    .is_some_and(|result| result.is_err())
            });
            if let Some(receiver) = slot.as_ref().filter(|_| !failed) {
                receiver.clone()
            } else {
                let (sender, receiver) = tokio::sync::watch::channel(None);
                *slot = Some(receiver.clone());
                let owner = self.clone();
                // This driver owns cleanup independently of a dropped close waiter.
                tauri::async_runtime::spawn(async move {
                    let result = owner.close_owned().await;
                    let _ = sender.send(Some(result));
                });
                receiver
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
            let (app, id) = (self.0.app.clone(), self.0.id);
            retained_cleanup(move |request| {
                app.run_on_main_thread(move || linux::close(id, request))
                    .map_err(|_| EngineError::new("DISCONNECTED"))
            })
            .await
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use glib::translate::*;
    use gtk::{
        gio,
        glib::{self, variant::ToVariant},
    };
    use std::{
        cell::RefCell,
        collections::HashMap,
        panic::{catch_unwind, AssertUnwindSafe},
        rc::Rc,
    };
    const NAME: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";
    fn absent_notification(error: &glib::Error) -> bool {
        if error.message().len() > 4096 {
            return false;
        }
        let name: Option<glib::GString> = unsafe {
            from_glib_full(gio::ffi::g_dbus_error_get_remote_error(
                error.to_glib_none().0,
            ))
        };
        matches!(
            name.as_deref(),
            Some(
                "org.freedesktop.DBus.Error.NameHasNoOwner"
                    | "org.freedesktop.DBus.Error.ServiceUnknown"
                    | "org.freedesktop.Notifications.Error.InvalidId"
            )
        )
    }
    fn server_reply(value: &glib::Variant) -> Option<String> {
        if value.size() > 256 {
            return None;
        }
        value
            .get::<(String,)>()
            .map(|value| value.0)
            .filter(|value| unique_name(value))
    }
    fn action_parameters(value: &glib::Variant) -> Option<(u32, String)> {
        if value.size() > 256 {
            return None;
        }
        value.get::<(u32, String)>()
    }
    struct Notice {
        epoch: String,
        clicked: bool,
    }
    fn retire_closed_notice(
        notices: &mut HashMap<u32, Notice>,
        id: u32,
        result: &Result<glib::Variant, glib::Error>,
    ) -> bool {
        let acknowledged = result
            .as_ref()
            .is_ok_and(|value| value.get::<()>().is_some())
            || result.as_ref().err().is_some_and(absent_notification);
        if acknowledged {
            notices.remove(&id);
        }
        acknowledged
    }
    struct Session {
        connection: gio::DBusConnection,
        server: String,
        notices: HashMap<u32, Notice>,
        pending: usize,
        subscriptions: Vec<gio::SignalSubscriptionId>,
        signal_retired: Option<std::sync::mpsc::Receiver<()>>,
        closing: bool,
    }
    thread_local! {static SESSIONS:RefCell<HashMap<u64,Rc<RefCell<Session>>>>=RefCell::new(HashMap::new());}
    struct SignalLifetime(std::sync::mpsc::Sender<()>);
    impl Drop for SignalLifetime {
        fn drop(&mut self) {}
    }
    fn protected(request: &Request, effect: impl FnOnce() -> Result<(), EngineError>) {
        if let Err(error) = catch_unwind(AssertUnwindSafe(effect))
            .unwrap_or_else(|_| Err(EngineError::new("INTERNAL_ERROR")))
        {
            request.finish(Err(error));
        }
    }
    fn subscribe(session: &Rc<RefCell<Session>>, app: tauri::AppHandle, closing: Arc<AtomicBool>) {
        let (sender, retired) = std::sync::mpsc::channel::<()>();
        session.borrow_mut().signal_retired = Some(retired);
        let (connection, server) = {
            let s = session.borrow();
            (s.connection.clone(), s.server.clone())
        };
        let weak = Rc::downgrade(session);
        let lifetime = SignalLifetime(sender.clone());
        let action = connection.signal_subscribe(
            Some(&server),
            Some(NAME),
            Some("ActionInvoked"),
            Some(PATH),
            None,
            gio::DBusSignalFlags::NONE,
            move |connection, sender, path, interface, member, parameters| {
                let _keep = &lifetime;
                let _ = catch_unwind(AssertUnwindSafe(|| {
                    let Some(session) = weak.upgrade() else {
                        return;
                    };
                    if path != PATH || interface != NAME || member != "ActionInvoked" {
                        return;
                    }
                    let Some((id, action)) = action_parameters(parameters) else {
                        return;
                    };
                    let epoch = {
                        let mut state = session.borrow_mut();
                        if connection != &state.connection
                            || !owned_action(
                                sender,
                                &state.server,
                                &action,
                                state.notices.contains_key(&id),
                                state.closing || closing.load(Ordering::SeqCst),
                            )
                        {
                            return;
                        }
                        let notice = state.notices.get_mut(&id).unwrap();
                        if notice.clicked {
                            return;
                        }
                        notice.clicked = true;
                        notice.epoch.clone()
                    };
                    // Application-owned intent only: use the current trusted main
                    // document, never a source callback, URL, task or data action.
                    if super::super::available_engine(&app, Some(&epoch)).is_err() {
                        return;
                    }
                    let Some(window) = app.get_webview_window("main") else {
                        return;
                    };
                    if super::super::authorize(&window).is_err() {
                        return;
                    }
                    let _ = window.show();
                    if super::super::available_engine(&app, Some(&epoch)).is_ok()
                        && super::super::authorize(&window).is_ok()
                    {
                        let _ = window.set_focus();
                    }
                }));
            },
        );
        let weak = Rc::downgrade(session);
        let lifetime = SignalLifetime(sender);
        let closed = connection.signal_subscribe(
            Some(&server),
            Some(NAME),
            Some("NotificationClosed"),
            Some(PATH),
            None,
            gio::DBusSignalFlags::NONE,
            move |connection, sender, path, interface, member, parameters| {
                let _keep = &lifetime;
                let _ = catch_unwind(AssertUnwindSafe(|| {
                    let Some(session) = weak.upgrade() else {
                        return;
                    };
                    let mut state = session.borrow_mut();
                    if connection != &state.connection
                        || sender != state.server
                        || path != PATH
                        || interface != NAME
                        || member != "NotificationClosed"
                    {
                        return;
                    }
                    if let Some((id, _reason)) = (parameters.size() <= 16)
                        .then(|| parameters.get::<(u32, u32)>())
                        .flatten()
                    {
                        state.notices.remove(&id);
                    }
                }));
            },
        );
        session.borrow_mut().subscriptions = vec![action, closed];
    }
    pub(super) fn begin(
        id: u64,
        app: tauri::AppHandle,
        closing: Arc<AtomicBool>,
        message: Option<(String, String, bool)>,
        request: Request,
    ) {
        let request = Rc::new(request);
        protected(&request, || {
            (request.current)()?;
            if closing.load(Ordering::SeqCst) {
                return Err(EngineError::new("DISCONNECTED"));
            }
            let existing = SESSIONS.with(|sessions| sessions.borrow().get(&id).cloned());
            if let Some(session) = existing {
                let connection = session.borrow().connection.clone();
                query(id, app, closing, message, request.clone(), connection);
            } else {
                let retained = request.clone();
                gio::bus_get(
                    gio::BusType::Session,
                    None::<&gio::Cancellable>,
                    move |connection| {
                        protected(&retained, || {
                            (retained.current)()?;
                            match connection {
                                Ok(connection) => {
                                    query(id, app, closing, message, retained.clone(), connection)
                                }
                                Err(_) => retained.finish(Ok(false)),
                            };
                            Ok(())
                        });
                    },
                );
            }
            Ok(())
        });
    }
    fn query(
        id: u64,
        app: tauri::AppHandle,
        closing: Arc<AtomicBool>,
        message: Option<(String, String, bool)>,
        request: Rc<Request>,
        connection: gio::DBusConnection,
    ) {
        if connection.is_closed() {
            request.finish(Ok(false));
            return;
        }
        let captured = connection.clone();
        connection.call(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "GetNameOwner",
            Some(&(NAME,).to_variant()),
            None,
            gio::DBusCallFlags::NO_AUTO_START,
            1000,
            None::<&gio::Cancellable>,
            move |result| {
                protected(&request, || {
                    (request.current)()?;
                    let Some(server) = result.ok().and_then(|v| server_reply(&v)) else {
                        request.finish(Ok(false));
                        return Ok(());
                    };
                    if !unique_name(&server) || captured.is_closed() {
                        request.finish(Ok(false));
                        return Ok(());
                    }
                    let existing = SESSIONS.with(|sessions| sessions.borrow().get(&id).cloned());
                    let session = if let Some(session) = existing {
                        let state = session.borrow();
                        if !same_server(
                            &state.server,
                            &server,
                            state.connection == captured,
                            state.closing,
                        ) {
                            request.finish(Ok(false));
                            return Ok(());
                        }
                        drop(state);
                        session
                    } else {
                        let session = Rc::new(RefCell::new(Session {
                            connection: captured.clone(),
                            server,
                            notices: HashMap::new(),
                            pending: 0,
                            subscriptions: Vec::new(),
                            signal_retired: None,
                            closing: false,
                        }));
                        subscribe(&session, app.clone(), closing.clone());
                        SESSIONS.with(|sessions| {
                            sessions.borrow_mut().insert(id, session.clone());
                        });
                        session
                    };
                    match message {
                        None => request.finish(Ok(true)),
                        Some(message) => notify(app, session, message, request.clone())?,
                    };
                    Ok(())
                });
            },
        );
    }
    fn notify(
        app: tauri::AppHandle,
        session: Rc<RefCell<Session>>,
        message: (String, String, bool),
        request: Rc<Request>,
    ) -> Result<(), EngineError> {
        (request.current)()?;
        if message.2 {
            if let Some(window) = app.get_webview_window("main") {
                // Failure to determine focus refuses a status alert.
                if window.is_focused().unwrap_or(true) {
                    request.finish(Ok(false));
                    return Ok(());
                }
            }
        }
        let epoch = super::super::available_engine(&app, None)?.epoch();
        let hints = HashMap::<String, glib::Variant>::new();
        let params = (
            "21x Preview",
            0u32,
            "",
            escape_markup(&message.0),
            escape_markup(&message.1),
            vec!["openapp", "Open app"],
            hints,
            10000i32,
        )
            .to_variant();
        (request.current)()?;
        let (connection, server) = {
            let mut state = session.borrow_mut();
            if state.closing || !capacity(state.notices.len(), state.pending) {
                request.finish(Ok(false));
                return Ok(());
            }
            state.pending += 1;
            (state.connection.clone(), state.server.clone())
        };
        connection.call(
            Some(&server),
            PATH,
            NAME,
            "Notify",
            Some(&params),
            None,
            gio::DBusCallFlags::NO_AUTO_START,
            3000,
            None::<&gio::Cancellable>,
            move |result| {
                protected(&request, || {
                    let id = result
                        .ok()
                        .filter(|v| v.size() <= 16)
                        .and_then(|v| v.get::<(u32,)>())
                        .map(|v| v.0)
                        .filter(|id| *id != 0);
                    // Even a caller that disappeared after acceptance still owns the
                    // returned ID for exact cleanup. Never repeat Notify on timeout.
                    {
                        let mut state = session.borrow_mut();
                        state.pending -= 1;
                        if let Some(id) = id {
                            state.notices.insert(
                                id,
                                Notice {
                                    epoch,
                                    clicked: false,
                                },
                            );
                        }
                    }
                    (request.current)()?;
                    request.finish(Ok(id.is_some()));
                    Ok(())
                });
            },
        );
        Ok(())
    }
    struct CleanupBatch {
        remaining: usize,
        failed: bool,
        request: Rc<Cleanup>,
    }
    fn finish_cleanup(id: u64, batch: &Rc<RefCell<CleanupBatch>>) {
        let mut batch = batch.borrow_mut();
        if batch.remaining != 0 {
            return;
        }
        if !batch.failed {
            SESSIONS.with(|sessions| {
                sessions.borrow_mut().remove(&id);
            });
        }
        let result = if batch.failed {
            Err(EngineError::new("DISCONNECTED"))
        } else {
            Ok(())
        };
        let _ = batch.request.reply.send(result);
    }
    pub(super) fn close(id: u64, request: Cleanup) {
        let request = Rc::new(request);
        let result = catch_unwind(AssertUnwindSafe(|| -> Result<(), EngineError> {
            let session = SESSIONS.with(|sessions| sessions.borrow().get(&id).cloned());
            let Some(session) = session else {
                let _ = request.reply.send(Ok(()));
                return Ok(());
            };
            let (connection, server, ids, subscriptions, retired) = {
                let mut state = session.borrow_mut();
                state.closing = true;
                (
                    state.connection.clone(),
                    state.server.clone(),
                    state.notices.keys().copied().collect::<Vec<_>>(),
                    std::mem::take(&mut state.subscriptions),
                    state.signal_retired.take(),
                )
            };
            for subscription in subscriptions {
                connection.signal_unsubscribe(subscription);
            }
            if let Some(retired) = retired {
                let _ = request.signals.send(retired);
            }
            let batch = Rc::new(RefCell::new(CleanupBatch {
                remaining: ids.len(),
                failed: false,
                request: request.clone(),
            }));
            // Only our IDs at our originally captured unique server. A daemon
            // restart cannot redirect CloseNotification to another application.
            let id_owner = id;
            for id in ids {
                let retained = batch.clone();
                let session = session.clone();
                connection.call(
                    Some(&server),
                    PATH,
                    NAME,
                    "CloseNotification",
                    Some(&(id,).to_variant()),
                    None,
                    gio::DBusCallFlags::NO_AUTO_START,
                    1000,
                    None::<&gio::Cancellable>,
                    move |result| {
                        // Exact expired-ID/vanished-owner errors retire this ID.
                        // Other failures retain our IDs and owner for retry.
                        let outcome = catch_unwind(AssertUnwindSafe(|| {
                            let success = retire_closed_notice(
                                &mut session.borrow_mut().notices,
                                id,
                                &result,
                            );
                            let mut batch = retained.borrow_mut();
                            batch.remaining -= 1;
                            batch.failed |= !success;
                            drop(batch);
                            finish_cleanup(id_owner, &retained);
                        }));
                        if outcome.is_err() {
                            let mut batch = retained.borrow_mut();
                            batch.failed = true;
                            let _ = batch
                                .request
                                .reply
                                .send(Err(EngineError::new("INTERNAL_ERROR")));
                        }
                    },
                );
            }
            finish_cleanup(id, &batch);
            Ok(())
        }))
        .unwrap_or_else(|_| Err(EngineError::new("INTERNAL_ERROR")));
        if let Err(error) = result {
            let _ = request.reply.send(Err(error));
        }
    }
    #[cfg(test)]
    mod bounded_reply_tests {
        use super::*;
        #[test]
        fn bounds_raw_variant_before_copying_server_and_action_strings() {
            assert_eq!(server_reply(&(":1.21",).to_variant()), Some(":1.21".into()));
            assert!(server_reply(&("not-a-unique-server",).to_variant()).is_none());
            assert!(server_reply(&(format!(":1.{}", "1".repeat(100_000)),).to_variant()).is_none());
            assert_eq!(
                action_parameters(&(12u32, "openapp").to_variant()),
                Some((12, "openapp".into()))
            );
            assert!(action_parameters(&(12u32, "x".repeat(100_000)).to_variant()).is_none());
            assert!(action_parameters(&(12u64, "openapp").to_variant()).is_none());
        }
    }
    #[cfg(test)]
    mod cleanup_tests {
        use super::*;
        fn remote(name: &str, message: &str) -> glib::Error {
            let name = std::ffi::CString::new(name).unwrap();
            let message = std::ffi::CString::new(message).unwrap();
            unsafe {
                from_glib_full(gio::ffi::g_dbus_error_new_for_dbus_error(
                    name.as_ptr(),
                    message.as_ptr(),
                ))
            }
        }
        fn notices() -> HashMap<u32, Notice> {
            [
                (
                    7,
                    Notice {
                        epoch: "owned-epoch".to_owned(),
                        clicked: false,
                    },
                ),
                (
                    8,
                    Notice {
                        epoch: "other-owned-epoch".to_owned(),
                        clicked: false,
                    },
                ),
            ]
            .into_iter()
            .collect()
        }
        #[test]
        fn exact_expired_id_and_vanished_owner_errors_retire_only_the_requested_owned_id() {
            for name in [
                "org.freedesktop.Notifications.Error.InvalidId",
                "org.freedesktop.DBus.Error.NameHasNoOwner",
                "org.freedesktop.DBus.Error.ServiceUnknown",
            ] {
                let mut ids = notices();
                let result = Err(remote(name, "arbitrary private server detail"));
                assert!(retire_closed_notice(&mut ids, 7, &result));
                assert!(!ids.contains_key(&7));
                assert!(ids.contains_key(&8));
                assert!(retire_closed_notice(&mut ids, 999, &result));
                assert!(ids.contains_key(&8));
            }
            assert!(!same_server(":1.21", ":1.22", true, false));
            assert!(!same_server(":1.21", ":1.21", false, false));
            assert!(!owned_action(":1.21", ":1.21", "openapp", false, false));
        }
        #[test]
        fn unsupported_remote_errors_and_forged_error_text_retain_ids_for_retry() {
            for name in [
                "org.freedesktop.DBus.Error.InvalidArgs",
                "org.freedesktop.Notifications.Error.InvalidIdExtra",
                "org.freedesktop.Notifications.Error.InvalidID",
                "org.freedesktop.Notifications.Error.Failed",
            ] {
                let mut ids = notices();
                let result = Err(remote(
                    name,
                    "org.freedesktop.Notifications.Error.InvalidId",
                ));
                assert!(!retire_closed_notice(&mut ids, 7, &result));
                assert_eq!(ids.len(), 2);
                assert!(retire_closed_notice(&mut ids, 7, &Ok(().to_variant())));
                assert!(!ids.contains_key(&7));
                assert!(ids.contains_key(&8));
            }
            let mut ids = notices();
            assert!(!retire_closed_notice(
                &mut ids,
                7,
                &Ok(("invalid response",).to_variant())
            ));
            assert_eq!(ids.len(), 2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_public_text_rejects_controls_and_escapes_markup() {
        assert!(payload("Preview", "Body\n\twith lines\r"));
        assert!(payload("Preview", ""));
        assert!(!payload("", "Body"));
        assert!(!payload("bad\nheader", "Body"));
        assert!(!payload("Preview", "bad\0body"));
        assert!(!payload("Preview", "\u{007f}"));
        assert!(!payload(&"é".repeat(81), "Body"));
        assert!(!payload("Preview", &"é".repeat(1025)));
        assert_eq!(escape_markup("<&\"'>"), "&lt;&amp;&quot;&apos;&gt;");
    }
    #[test]
    fn actions_require_exact_captured_unique_server_owned_id_and_fixed_intent() {
        assert!(owned_action(":1.21", ":1.21", "openapp", true, false));
        for (server, sender, action, owned, closing) in [
            (":1.21", ":1.22", "openapp", true, false),
            (
                "org.freedesktop.Notifications",
                "org.freedesktop.Notifications",
                "openapp",
                true,
                false,
            ),
            (":1.21", ":1.21", "https://example.test", true, false),
            (":1.21", ":1.21", "openapp", false, false),
            (":1.21", ":1.21", "openapp", true, true),
        ] {
            assert!(!owned_action(sender, server, action, owned, closing));
        }
        for name in [":1.", ":1.2.3", ":1.fake", "../server", ""] {
            assert!(!unique_name(name));
        }
        assert!(same_server(":1.21", ":1.21", true, false));
        assert!(!same_server(":1.21", ":1.22", true, false));
        assert!(!same_server(":1.21", ":1.21", false, false));
        assert!(!same_server(":1.21", ":1.21", true, true));
        assert!(capacity(63, 0));
        assert!(!capacity(63, 1));
        assert!(!capacity(0, 64));
        assert!(!capacity(usize::MAX, 1));
    }
    #[tokio::test]
    async fn accepted_reply_is_not_actual_callback_retirement() {
        let work = NativeWorkOwner::default();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(retained_request(
            work.clone(),
            Arc::new(|| Ok(())),
            move |request| {
                let _ = tx.send(request);
                Ok(())
            },
        ));
        let request = rx.await.unwrap();
        request.finish(Ok(true));
        assert_eq!(work.active().unwrap(), 1);
        assert!(!task.is_finished());
        drop(request);
        assert!(task.await.unwrap().unwrap());
        work.drain().await.unwrap();
        assert_eq!(work.active().unwrap(), 0);
    }
    #[tokio::test]
    async fn dropped_waiter_revokes_later_effect_but_retains_raw_callback() {
        let work = NativeWorkOwner::default();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(retained_request(
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
        assert_eq!(work.active().unwrap(), 0);
    }
    #[tokio::test]
    async fn accepted_callback_survives_scheduling_error_and_scope_loss() {
        let work = NativeWorkOwner::default();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(retained_request(
            work.clone(),
            Arc::new(|| Ok(())),
            move |request| {
                let _ = tx.send(request);
                Err(EngineError::new("DISCONNECTED"))
            },
        ));
        let request = rx.await.unwrap();
        request.finish(Ok(false));
        work.close().unwrap();
        assert_eq!(work.active().unwrap(), 1);
        drop(request);
        assert_eq!(task.await.unwrap().unwrap_err().code, "DISCONNECTED");
        work.drain().await.unwrap();
    }
    #[tokio::test]
    async fn caller_loss_after_notify_acceptance_does_not_acknowledge_or_replay() {
        let work = NativeWorkOwner::default();
        let current = Arc::new(AtomicBool::new(true));
        let guard = current.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let calls = Arc::new(AtomicU64::new(0));
        let admitted = calls.clone();
        let task = tokio::spawn(retained_request(
            work.clone(),
            Arc::new(move || {
                if guard.load(Ordering::SeqCst) {
                    Ok(())
                } else {
                    Err(EngineError::new("UNAUTHORIZED"))
                }
            }),
            move |request| {
                admitted.fetch_add(1, Ordering::SeqCst);
                let _ = tx.send(request);
                Ok(())
            },
        ));
        let request = rx.await.unwrap();
        request.finish(Ok(true));
        current.store(false, Ordering::SeqCst);
        assert_eq!(work.active().unwrap(), 1);
        drop(request);
        assert_eq!(task.await.unwrap().unwrap_err().code, "UNAUTHORIZED");
        work.drain().await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn cleanup_is_admitted_after_work_closed_and_joins_callback_and_signal_retirement() {
        let work = NativeWorkOwner::default();
        work.close().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(retained_cleanup(move |request| {
            let _ = tx.send(request);
            Ok(())
        }));
        let request = rx.await.unwrap();
        let (signal, retired) = std::sync::mpsc::channel::<()>();
        request.signals.send(retired).unwrap();
        request.reply.send(Ok(())).unwrap();
        assert!(!task.is_finished());
        drop(request);
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        drop(signal);
        task.await.unwrap().unwrap();
        work.drain().await.unwrap();
    }
    #[tokio::test]
    async fn failed_cleanup_schedule_still_joins_already_accepted_captures() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(retained_cleanup(move |request| {
            let _ = tx.send(request);
            Err(EngineError::new("DISCONNECTED"))
        }));
        let request = rx.await.unwrap();
        request
            .reply
            .send(Err(EngineError::new("INTERNAL_ERROR")))
            .unwrap();
        assert!(!task.is_finished());
        drop(request);
        assert_eq!(task.await.unwrap().unwrap_err().code, "DISCONNECTED");
    }
}
