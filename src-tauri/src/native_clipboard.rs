//! Direct current-document clipboard read. GTK callbacks are asynchronous;
//! accepted callbacks remain owned until their actual completion, even when
//! the public waiter times out or disappears. No copied-file contents are read.
use super::{native_services::NativeWorkOwner, production_ui::NativeUiOwner};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use twentyonex_engine::EngineError;

pub const OPERATION: &str = "chatImages:readClipboard";
pub const MAX_BYTES: usize = 512 * 1024;
const MAX_TARGETS: usize = 64;
const PNG: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const UNAVAILABLE: &str = "Clipboard image reading is unavailable in this desktop host.";
const COPIED_FILES: &str = "Copied image files are not available here yet.";
const TOO_LARGE: &str = "The clipboard image exceeds the supported size.";
const UNSUPPORTED: &str = "The clipboard image format is not supported here.";
const FAILED: &str = "The clipboard image could not be read.";
const ERRORS: &[&str] = &[UNAVAILABLE, COPIED_FILES, TOO_LARGE, UNSUPPORTED, FAILED];
const COPIED_TYPES: &[&str] = &[
    "text/uri-list",
    "x-special/gnome-copied-files",
    "x-special/nautilus-clipboard",
];
const OTHER_IMAGES: &[&str] = &[
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/tiff",
    "image/bmp",
    "image/svg+xml",
    "image/x-icon",
];
type Scope = Arc<dyn Fn() -> Result<(), EngineError> + Send + Sync>;
type Reply = std::sync::mpsc::Sender<Result<Value, EngineError>>;

pub fn request(value: &Value) -> bool {
    value.as_object().is_some_and(|map| map.is_empty())
}
fn exact(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|map| map.len() == keys.len() && keys.iter().all(|key| map.contains_key(*key)))
}
fn error(message: &str) -> Value {
    json!({"images":[],"errors":[message]})
}
fn empty() -> Value {
    json!({"images":[],"errors":[]})
}
fn encode(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(4 * bytes.len().div_ceil(3));
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        output.push(ALPHABET[(a >> 2) as usize] as char);
        output.push(ALPHABET[(((a & 3) << 4) | (b >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[(((b & 15) << 2) | (c >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(c & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}
fn image(bytes: &[u8]) -> Value {
    if bytes.len() > MAX_BYTES {
        return error(TOO_LARGE);
    }
    if !bytes.starts_with(&PNG) {
        return error(UNSUPPORTED);
    }
    json!({"images":[{"name":"image.png","mimeType":"image/png","data":encode(bytes)}],"errors":[]})
}
fn canonical_png(value: &Value) -> bool {
    let Some(data) = value.as_str() else {
        return false;
    };
    if data.is_empty() || data.len() > 4 * MAX_BYTES.div_ceil(3) || data.len() % 4 != 0 {
        return false;
    }
    let padding = data.bytes().rev().take_while(|byte| *byte == b'=').count();
    if padding > 2 {
        return false;
    }
    let content = &data.as_bytes()[..data.len() - padding];
    let symbol = |byte: u8| {
        ALPHABET
            .iter()
            .position(|item| *item == byte)
            .map(|index| index as u32)
    };
    if content.is_empty() || content.iter().any(|byte| symbol(*byte).is_none()) {
        return false;
    }
    let last = symbol(*content.last().unwrap()).unwrap();
    if padding == 2 && last & 15 != 0 || padding == 1 && last & 3 != 0 {
        return false;
    }
    let size = data.len() / 4 * 3 - padding;
    if size < PNG.len() || size > MAX_BYTES {
        return false;
    }
    let (mut bits, mut accumulator, mut index) = (0u32, 0u32, 0usize);
    for byte in content {
        accumulator = (accumulator << 6) | symbol(*byte).unwrap();
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            if ((accumulator >> bits) & 255) as u8 != PNG[index] {
                return false;
            }
            index += 1;
            accumulator &= (1 << bits) - 1;
            if index == PNG.len() {
                return true;
            }
        }
    }
    false
}
pub fn result(value: &Value) -> bool {
    if !exact(value, &["defined", "value"]) || value["defined"] != true {
        return false;
    }
    let value = &value["value"];
    if !exact(value, &["images", "errors"]) {
        return false;
    }
    let (Some(images), Some(errors)) = (value["images"].as_array(), value["errors"].as_array())
    else {
        return false;
    };
    images.len() <= 1
        && errors.len() <= 1
        && (images.is_empty() || errors.is_empty())
        && images.iter().all(|item| {
            exact(item, &["name", "mimeType", "data"])
                && item["name"] == "image.png"
                && item["mimeType"] == "image/png"
                && canonical_png(&item["data"])
        })
        && errors.iter().all(|item| {
            item.as_str()
                .is_some_and(|message| ERRORS.contains(&message))
        })
        && serde_json::to_vec(&json!({"defined":true,"value":value}))
            .is_ok_and(|bytes| bytes.len() < 890000)
}
#[derive(Debug, PartialEq)]
enum TargetChoice {
    Empty,
    Png,
    CopiedFiles,
    Unsupported,
    Failed,
}
fn choose_targets<T: PartialEq>(
    targets: &[T],
    png: &T,
    copied: &[T],
    images: &[T],
) -> TargetChoice {
    if targets.len() > MAX_TARGETS {
        return TargetChoice::Failed;
    }
    if targets.iter().any(|target| copied.contains(target)) {
        return TargetChoice::CopiedFiles;
    }
    if targets.contains(png) {
        return TargetChoice::Png;
    }
    if targets.iter().any(|target| images.contains(target)) {
        return TargetChoice::Unsupported;
    }
    TargetChoice::Empty
}
struct ActiveRequest(Arc<AtomicBool>);
impl Drop for ActiveRequest {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
struct CallbackRequest {
    scope: Scope,
    reply: Reply,
    lifetime: std::sync::mpsc::Sender<()>,
}
// A whole request is captured, so closure ownership cannot drop its receipt
// independently of the callback scope/reply during disjoint-field capture.
impl Drop for CallbackRequest {
    fn drop(&mut self) {}
}
impl CallbackRequest {
    fn finish(&self, value: Result<Value, EngineError>) {
        let _ = self.reply.send(value);
    }
}

async fn retained_read(
    work: NativeWorkOwner,
    current: Scope,
    schedule: impl FnOnce(CallbackRequest) -> Result<(), EngineError> + Send + 'static,
) -> Result<Value, EngineError> {
    let active = Arc::new(AtomicBool::new(true));
    let _request = ActiveRequest(active.clone());
    let scope: Scope = Arc::new(move || {
        if !active.load(Ordering::SeqCst) {
            return Err(EngineError::new("CANCELLED"));
        }
        current()
    });
    let result = Arc::new(Mutex::new(None));
    let stored = result.clone();
    work.run(move || {
        scope()?;
        let (reply, completed) = std::sync::mpsc::channel();
        let (lifetime, retired) = std::sync::mpsc::channel::<()>();
        // A scheduling error does not acknowledge a callback that may already
        // have been accepted. Its owned sender must actually retire first.
        let scheduled = schedule(CallbackRequest {
            scope: scope.clone(),
            reply,
            lifetime,
        });
        let answer = completed.recv();
        // Reply delivery is not callback retirement. Join every accepted GTK
        // closure capture, including failure and cancellation paths, first.
        while retired.recv().is_ok() {}
        let value = match answer {
            Ok(answer) => answer?,
            Err(_) => error(FAILED),
        };
        scope()?;
        let wire = json!({"defined":true,"value":if scheduled.is_err(){error(FAILED)}else{value}});
        if !self::result(&wire) {
            return Err(EngineError::new("INVALID_RESULT"));
        }
        *stored
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))? = Some(wire);
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

pub async fn read(
    app: tauri::AppHandle,
    work: NativeWorkOwner,
    ui: NativeUiOwner,
    window: tauri::WebviewWindow,
    epoch: String,
    lease: String,
) -> Result<Value, EngineError> {
    ui.assert_publish(&window, &epoch, &lease)?;
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, work);
        return Ok(json!({"defined":true,"value":error(UNAVAILABLE)}));
    }
    #[cfg(target_os = "linux")]
    {
        let guard_work = work.clone();
        let current: Scope = Arc::new(move || {
            guard_work.assert_open()?;
            ui.assert_publish(&window, &epoch, &lease)
        });
        let operation = retained_read(work, current, move |request| {
            app.run_on_main_thread(move || gtk_clipboard::begin(request))
                .map_err(|_| EngineError::new("DISCONNECTED"))
        });
        // The private callback lifetime outlives this public deadline. Dropping
        // operation revokes later reads without cancelling or losing its receipt.
        match tokio::time::timeout(std::time::Duration::from_secs(5), operation).await {
            Ok(result) => result,
            Err(_) => Ok(json!({"defined":true,"value":error(FAILED)})),
        }
    }
}

#[cfg(target_os = "linux")]
mod gtk_clipboard {
    use super::*;
    use gtk::glib::translate::{from_glib_borrow, ToGlibPtr};
    use std::panic::{catch_unwind, AssertUnwindSafe};
    struct Targets {
        request: CallbackRequest,
        png: gtk::gdk::Atom,
        copied: Vec<gtk::gdk::Atom>,
        images: Vec<gtk::gdk::Atom>,
    }
    pub(super) fn begin(request: CallbackRequest) {
        let reply = request.reply.clone();
        let outcome = catch_unwind(AssertUnwindSafe(move || {
            if let Err(error) = (request.scope)() {
                request.finish(Err(error));
                return;
            }
            if !gtk::is_initialized_main_thread() || gtk::gdk::Display::default().is_none() {
                request.finish(Ok(error(UNAVAILABLE)));
                return;
            }
            let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
            let targets = Targets {
                request,
                png: gtk::gdk::Atom::intern("image/png"),
                copied: COPIED_TYPES
                    .iter()
                    .map(|name| gtk::gdk::Atom::intern(name))
                    .collect(),
                images: OTHER_IMAGES
                    .iter()
                    .map(|name| gtk::gdk::Atom::intern(name))
                    .collect(),
            };
            // gtk-rs 0.18.2 omits the safe request_targets wrapper. GTK owns this
            // exact one-shot box until targets_received; no timeout frees it.
            unsafe {
                gtk::ffi::gtk_clipboard_request_targets(
                    clipboard.to_glib_none().0,
                    Some(targets_received),
                    Box::into_raw(Box::new(targets)).cast(),
                );
            }
        }));
        if outcome.is_err() {
            let _ = reply.send(Ok(error(FAILED)));
        }
    }
    unsafe extern "C" fn targets_received(
        clipboard: *mut gtk::ffi::GtkClipboard,
        atoms: *mut gtk::gdk::ffi::GdkAtom,
        count: i32,
        data: gtk::glib::ffi::gpointer,
    ) {
        // The pointer was created solely by begin(), and GTK calls this once.
        let targets = unsafe { Box::from_raw(data.cast::<Targets>()) };
        let reply = targets.request.reply.clone();
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            (targets.request.scope)()?;
            if clipboard.is_null()
                || count < 0
                || count as usize > MAX_TARGETS
                || count > 0 && atoms.is_null()
            {
                return Ok(Some(error(FAILED)));
            }
            // Bounds and authority precede even inspecting borrowed opaque atoms.
            let atoms = if count == 0 {
                &[][..]
            } else {
                unsafe { std::slice::from_raw_parts(atoms, count as usize) }
            };
            let png = targets.png.to_glib_none().0;
            let copied = targets
                .copied
                .iter()
                .map(|atom| atom.to_glib_none().0)
                .collect::<Vec<_>>();
            let images = targets
                .images
                .iter()
                .map(|atom| atom.to_glib_none().0)
                .collect::<Vec<_>>();
            match choose_targets(atoms, &png, &copied, &images) {
                TargetChoice::CopiedFiles => Ok(Some(error(COPIED_FILES))),
                TargetChoice::Unsupported => Ok(Some(error(UNSUPPORTED))),
                TargetChoice::Failed => Ok(Some(error(FAILED))),
                TargetChoice::Empty => Ok(Some(empty())),
                TargetChoice::Png => {
                    (targets.request.scope)()?;
                    let clipboard: gtk::glib::translate::Borrowed<gtk::Clipboard> =
                        unsafe { from_glib_borrow(clipboard) };
                    let request = CallbackRequest {
                        scope: targets.request.scope.clone(),
                        reply: targets.request.reply.clone(),
                        lifetime: targets.request.lifetime.clone(),
                    };
                    let png = targets.png;
                    clipboard.request_contents(&png, move |_, selection| {
                        // Catch every Rust panic before gtk-rs' C trampoline.
                        let answer = catch_unwind(AssertUnwindSafe(|| {
                            (request.scope)()?;
                            if selection.target() != png
                                || selection.data_type() != png
                                || selection.format() != 8
                            {
                                return Ok(error(UNSUPPORTED));
                            }
                            let length = selection.length();
                            if length < 0 {
                                return Ok(error(FAILED));
                            }
                            if length as usize > MAX_BYTES {
                                return Ok(error(TOO_LARGE));
                            }
                            if (length as usize) < PNG.len() {
                                return Ok(error(UNSUPPORTED));
                            }
                            (request.scope)()?;
                            // Borrow GTK's immutable callback buffer. Do not call
                            // data(), which allocates an unbounded Vec before checks.
                            let pointer = unsafe {
                                gtk::ffi::gtk_selection_data_get_data(selection.to_glib_none().0)
                            };
                            if pointer.is_null() {
                                return Ok(error(FAILED));
                            }
                            let bytes =
                                unsafe { std::slice::from_raw_parts(pointer, length as usize) };
                            Ok(image(bytes))
                        }));
                        let answer = answer.unwrap_or_else(|_| Ok(error(FAILED)));
                        request.finish(answer);
                    });
                    Ok(None)
                }
            }
        }));
        match outcome {
            Ok(Ok(Some(value))) => {
                let _ = reply.send(Ok(value));
            }
            Ok(Ok(None)) => {} // ownership continues in the real contents callback
            Ok(Err(error)) => {
                let _ = reply.send(Err(error));
            }
            Err(_) => {
                let _ = reply.send(Ok(error(FAILED)));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wire(value: Value) -> Value {
        json!({"defined":true,"value":value})
    }
    #[test]
    fn exact_direct_request_never_grants_documents_targets_paths_or_clipboard_writes() {
        assert!(request(&json!({})));
        for value in [
            json!([]),
            json!(null),
            json!({"uiLease":"opaque"}),
            json!({"window":"main"}),
            json!({"target":"image/png"}),
            json!({"path":"/private.png"}),
            json!({"write":true}),
            json!({"caller":"main"}),
        ] {
            assert!(!request(&value));
        }
    }
    #[test]
    fn png_output_is_bounded_canonical_and_exact_without_metadata_or_private_errors() {
        assert!(result(&wire(empty())));
        for message in ERRORS {
            assert!(result(&wire(error(message))));
        }
        assert!(result(&wire(image(&PNG))));
        let mut bytes = vec![0u8; MAX_BYTES];
        bytes[..PNG.len()].copy_from_slice(&PNG);
        let boundary = wire(image(&bytes));
        assert!(result(&boundary));
        assert!(serde_json::to_vec(&boundary).unwrap().len() < 890000);
        bytes.push(0);
        assert_eq!(image(&bytes), error(TOO_LARGE));
        assert_eq!(image(b"not a PNG"), error(UNSUPPORTED));
        let good = wire(image(&PNG));
        for (key, value) in [
            ("name", json!("/private.png")),
            ("mimeType", json!("image/jpeg")),
            ("data", json!("data:image/png;base64,iVBORw0KGgo=")),
            ("data", json!("iVBORw0KGgp=")),
            ("data", json!("iVBORw0KGgoAAA=B")),
            ("sourcePath", json!("/private")),
        ] {
            let mut bad = good.clone();
            bad["value"]["images"][0][key] = value;
            assert!(!result(&bad));
        }
        let mut bad = good.clone();
        bad["value"]["errors"] = json!([FAILED]);
        assert!(!result(&bad));
        assert!(!result(&wire(
            json!({"images":[],"errors":["private GTK error"]})
        )));
        assert!(!result(&wire(
            json!({"images":[],"errors":[FAILED,UNAVAILABLE]})
        )));
        assert!(!result(&json!({"defined":false})));
        let mut extra = good;
        extra["leaseId"] = json!("opaque");
        assert!(!result(&extra));
        let mut twice = wire(image(&PNG));
        let image = twice["value"]["images"][0].clone();
        twice["value"]["images"].as_array_mut().unwrap().push(image);
        assert!(!result(&twice));
    }
    #[test]
    fn copied_files_have_priority_and_text_never_requests_contents() {
        assert_eq!(
            choose_targets(&[1, 2], &1, &[2, 3], &[4]),
            TargetChoice::CopiedFiles
        );
        assert_eq!(
            choose_targets(&[3], &1, &[2, 3], &[4]),
            TargetChoice::CopiedFiles
        );
        assert_eq!(
            choose_targets(&[4], &1, &[2, 3], &[4]),
            TargetChoice::Unsupported
        );
        assert_eq!(choose_targets(&[1], &1, &[2, 3], &[4]), TargetChoice::Png);
        assert_eq!(
            choose_targets(&[8, 9], &1, &[2, 3], &[4]),
            TargetChoice::Empty
        );
        assert_eq!(choose_targets(&[], &1, &[2, 3], &[4]), TargetChoice::Empty);
        assert_eq!(
            choose_targets(&[1; 65], &1, &[2, 3], &[4]),
            TargetChoice::Failed
        );
    }
    #[tokio::test]
    async fn dropped_waiter_fences_delayed_targets_without_losing_callback_or_drain_ownership() {
        let work = NativeWorkOwner::default();
        let raw = work.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        let public = tokio::spawn(async move {
            retained_read(raw, Arc::new(|| Ok(())), move |request| {
                let _ = send.send(request);
                Ok(())
            })
            .await
        });
        let callback = receive.await.unwrap();
        public.abort();
        let _ = public.await;
        assert_eq!(work.active().unwrap(), 1);
        // The real target callback performs this same check before selecting
        // or requesting PNG contents. No late read follows a cancelled waiter.
        let contents = std::sync::atomic::AtomicU64::new(0);
        let answer = match (callback.scope)() {
            Ok(()) => {
                contents.fetch_add(1, Ordering::SeqCst);
                Ok(empty())
            }
            Err(error) => {
                assert_eq!(error.code, "CANCELLED");
                Err(error)
            }
        };
        callback.finish(answer);
        let drain_owner = work.clone();
        let drain = tokio::spawn(async move { drain_owner.drain().await });
        tokio::task::yield_now().await;
        assert!(!drain.is_finished());
        assert_eq!(work.active().unwrap(), 1);
        drop(callback);
        drain.await.unwrap().unwrap();
        assert_eq!(work.active().unwrap(), 0);
        assert_eq!(contents.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn early_reply_and_initial_scheduling_error_cannot_retire_an_accepted_callback() {
        let work = NativeWorkOwner::default();
        let raw = work.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        let public = tokio::spawn(async move {
            retained_read(raw, Arc::new(|| Ok(())), move |request| {
                let _ = send.send(request);
                Err(EngineError::new("DISCONNECTED"))
            })
            .await
        });
        let callback = receive.await.unwrap();
        callback.finish(Ok(empty()));
        tokio::task::yield_now().await;
        assert!(!public.is_finished());
        assert_eq!(work.active().unwrap(), 1);
        drop(callback);
        assert_eq!(public.await.unwrap().unwrap(), wire(error(FAILED)));
        work.drain().await.unwrap();
        assert_eq!(work.active().unwrap(), 0);
    }
    #[tokio::test]
    async fn document_change_refuses_callback_data_and_shutdown_waits_for_real_capture_drop() {
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
        let public = tokio::spawn(async move {
            retained_read(raw, scope, move |request| {
                let _ = send.send(request);
                Ok(())
            })
            .await
        });
        let callback = receive.await.unwrap();
        live.store(false, Ordering::SeqCst);
        callback.finish((callback.scope)().map(|_| image(&PNG)));
        let drain_owner = work.clone();
        let drain = tokio::spawn(async move { drain_owner.drain().await });
        tokio::task::yield_now().await;
        assert!(!drain.is_finished());
        drop(callback);
        assert_eq!(public.await.unwrap().unwrap_err().code, "STALE_EPOCH");
        drain.await.unwrap().unwrap();
    }
    #[tokio::test]
    async fn public_deadline_retires_authority_but_not_the_accepted_native_receipt() {
        let work = NativeWorkOwner::default();
        let raw = work.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        let public = tokio::spawn(async move {
            tokio::time::timeout(
                std::time::Duration::from_millis(20),
                retained_read(raw, Arc::new(|| Ok(())), move |request| {
                    let _ = send.send(request);
                    Ok(())
                }),
            )
            .await
        });
        let callback = receive.await.unwrap();
        assert!(public.await.unwrap().is_err());
        assert_eq!(work.active().unwrap(), 1);
        assert_eq!((callback.scope)().unwrap_err().code, "CANCELLED");
        callback.finish((callback.scope)().map(|_| empty()));
        let drain_owner = work.clone();
        let drain = tokio::spawn(async move { drain_owner.drain().await });
        tokio::task::yield_now().await;
        assert!(!drain.is_finished());
        drop(callback);
        drain.await.unwrap().unwrap();
    }
}
