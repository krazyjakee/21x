//! Fixed native policy and ownership of blocking OS URL-launch calls.
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;
use twentyonex_engine::EngineError;

pub const OPERATIONS: &[&str] = &["shell:openExternal", "app:getVersion"];
pub const MAX_URL_BYTES: usize = 8192;
pub const MAX_NATIVE_WORK: usize = 4;
pub fn trusted_origin(url: &tauri::Url, development: bool) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && (url.port().is_none()
            && (url.scheme() == "tauri" && url.host_str() == Some("localhost")
                || matches!(url.scheme(), "http" | "https")
                    && url.host_str() == Some("tauri.localhost"))
            || development
                && url.scheme() == "http"
                && url.host_str() == Some("localhost")
                && url.port() == Some(1421))
}
pub fn trusted_main(label: &str, url: &tauri::Url, development: bool) -> bool {
    label == "main" && trusted_origin(url, development)
}
pub fn lifecycle(
    expected_epoch: Option<&str>,
    actual_epoch: &str,
    available: bool,
) -> Result<(), EngineError> {
    if expected_epoch.is_some_and(|expected| expected != actual_epoch) {
        return Err(EngineError::new("STALE_EPOCH"));
    }
    if !available {
        return Err(EngineError::new("DISCONNECTED"));
    }
    Ok(())
}
pub fn external_url(value: &str, callback: bool) -> bool {
    if value.is_empty()
        || value.len() > MAX_URL_BYTES
        || value
            .chars()
            .any(|c| c <= '\u{0020}' || c == '\u{007f}' || c == '\\')
    {
        return false;
    }
    let Ok(url) = tauri::Url::parse(value) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some_and(|password| !password.is_empty()) {
        return false;
    }
    if matches!(url.scheme(), "http" | "https") {
        // Reject WHATWG coercions and even empty user-info delimiters.
        let Some((_, remainder)) = value.split_once("://") else {
            return false;
        };
        let authority = remainder.split(['/', '?', '#']).next().unwrap_or("");
        !authority.is_empty() && !authority.contains('@') && url.host_str().is_some()
    } else {
        !callback && url.scheme() == "mailto" && !url.path().is_empty()
    }
}
pub fn request(operation: &str, value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    match operation {
        "shell:openExternal" => {
            map.len() == 1
                && map
                    .get("url")
                    .and_then(Value::as_str)
                    .is_some_and(|url| external_url(url, false))
        }
        "app:getVersion" => map.is_empty(),
        _ => false,
    }
}
pub fn version(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'+'))
    {
        return false;
    }
    let mut build = value.split('+');
    let release = build.next().unwrap_or("");
    let suffix = build.next();
    let valid_suffix = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-'))
    };
    if build.next().is_some() || suffix.is_some_and(|part| !valid_suffix(part)) {
        return false;
    }
    let (core, pre) = release
        .split_once('-')
        .map_or((release, None), |(core, pre)| (core, Some(pre)));
    if pre.is_some_and(|part| !valid_suffix(part)) {
        return false;
    }
    let parts: Vec<_> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit()))
}
#[derive(Default)]
struct WorkState {
    closing: bool,
    active: usize,
}
#[derive(Default)]
struct WorkInner {
    state: Mutex<WorkState>,
    settled: Notify,
}
#[derive(Clone, Default)]
pub struct NativeWorkOwner(Arc<WorkInner>);
struct Receipt(NativeWorkOwner);
impl Drop for Receipt {
    fn drop(&mut self) {
        // Mutex poisoning retains a blocked owner; a work panic itself is
        // joined by the independent driver and reported as INTERNAL_ERROR.
        if let Ok(mut state) = self.0 .0.state.lock() {
            state.active -= 1;
        }
        self.0 .0.settled.notify_waiters();
    }
}
impl NativeWorkOwner {
    pub fn close(&self) -> Result<(), EngineError> {
        self.0
            .state
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?
            .closing = true;
        Ok(())
    }
    pub fn assert_open(&self) -> Result<(), EngineError> {
        if self
            .0
            .state
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?
            .closing
        {
            return Err(EngineError::new("DISCONNECTED"));
        }
        Ok(())
    }
    pub fn active(&self) -> Result<usize, EngineError> {
        Ok(self
            .0
            .state
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?
            .active)
    }
    pub async fn run<F>(&self, work: F) -> Result<(), EngineError>
    where
        F: FnOnce() -> Result<(), EngineError> + Send + 'static,
    {
        let receipt = {
            let mut state = self
                .0
                .state
                .lock()
                .map_err(|_| EngineError::new("DISCONNECTED"))?;
            if state.closing {
                return Err(EngineError::new("DISCONNECTED"));
            }
            if state.active >= MAX_NATIVE_WORK {
                return Err(EngineError::new("BACKPRESSURE"));
            }
            state.active += 1;
            Receipt(self.clone())
        };
        let owner = self.clone();
        let (deliver, result) = tokio::sync::oneshot::channel();
        let raw = tauri::async_runtime::spawn_blocking(move || {
            owner.assert_open()?;
            work()
        });
        // The driver owns and joins the raw handle independently of the public
        // response. Timeout/disconnect drops only the receiver, never raw work.
        tauri::async_runtime::spawn(async move {
            let _receipt = receipt;
            let outcome = raw
                .await
                .map_err(|_| EngineError::new("INTERNAL_ERROR"))
                .and_then(|result| result);
            let _ = deliver.send(outcome);
        });
        result.await.map_err(|_| EngineError::new("DISCONNECTED"))?
    }
    pub async fn drain(&self) -> Result<(), EngineError> {
        self.close()?;
        loop {
            let settled = self.0.settled.notified();
            tokio::pin!(settled);
            // Register before reading active; a completion between read and
            // await must not be lost by Notify::notify_waiters.
            settled.as_mut().enable();
            if self.active()? == 0 {
                return Ok(());
            }
            settled.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn urls_and_native_shapes_are_finite() {
        for url in [
            "https://example.test/oauth?state=fixture#done",
            "http://127.0.0.1:3000",
            "mailto:fixture@example.test?subject=Fixture",
        ] {
            assert!(external_url(url, false));
        }
        assert!(!external_url("mailto:fixture@example.test", true));
        for url in [
            "file:///private",
            "javascript:alert(1)",
            "tel:1234",
            "https:/example.test",
            "https://user:pass@example.test",
            "https://@example.test",
            "https://example.test/ bad",
            "https://example.test/bad\0path",
            "https://example.test\\path",
        ] {
            assert!(!external_url(url, false), "{url}");
        }
        assert!(request(
            "shell:openExternal",
            &json!({"url":"https://example.test"})
        ));
        assert!(!request(
            "shell:openExternal",
            &json!({"url":"https://example.test","with":"arbitrary-program"})
        ));
        assert!(!request(
            "app:getVersion",
            &json!({"profileRoot":"/private"})
        ));
        assert!(!request("shell:openPath", &json!({"path":"/private"})));
        assert!(version("1.2.3-preview.1+fixture"));
        assert!(!version("private/path"));
    }
    #[test]
    fn trusted_main_and_current_lifecycle_are_required_independently_of_payloads() {
        let url = tauri::Url::parse("tauri://localhost/index.html").unwrap();
        assert!(trusted_main("main", &url, false));
        assert!(!trusted_main("foreign", &url, false));
        for origin in [
            "https://example.test",
            "tauri://user@localhost",
            "tauri://localhost:1421",
            "http://localhost:1420",
            "http://127.0.0.1:1421",
        ] {
            assert!(!trusted_main(
                "main",
                &tauri::Url::parse(origin).unwrap(),
                true
            ));
        }
        let dev = tauri::Url::parse("http://localhost:1421").unwrap();
        assert!(trusted_main("main", &dev, true));
        assert!(!trusted_main("main", &dev, false));
        assert!(lifecycle(Some("current"), "current", true).is_ok());
        assert_eq!(
            lifecycle(Some("old"), "current", true).unwrap_err().code,
            "STALE_EPOCH"
        );
        assert_eq!(
            lifecycle(Some("current"), "current", false)
                .unwrap_err()
                .code,
            "DISCONNECTED"
        );
    }
    #[tokio::test]
    async fn abandoned_public_request_retains_raw_work_and_fences_shutdown() {
        let owner = NativeWorkOwner::default();
        let (entered, started) = tokio::sync::oneshot::channel();
        let (release, held) = std::sync::mpsc::channel();
        let copy = owner.clone();
        let public = tokio::spawn(async move {
            copy.run(move || {
                let _ = entered.send(());
                held.recv().unwrap();
                Ok(())
            })
            .await
        });
        started.await.unwrap();
        public.abort();
        assert_eq!(owner.active().unwrap(), 1);
        owner.close().unwrap();
        let copy = owner.clone();
        let mut drain = tokio::spawn(async move { copy.drain().await });
        tokio::task::yield_now().await;
        assert!(owner.assert_open().is_err());
        assert!(!drain.is_finished());
        assert!(owner.run(|| Ok(())).await.is_err());
        release.send(()).unwrap();
        (&mut drain).await.unwrap().unwrap();
        assert_eq!(owner.active().unwrap(), 0);
    }
    #[tokio::test]
    async fn bounded_raw_work_admission_does_not_queue_or_run_rejected_effects() {
        let owner = NativeWorkOwner::default();
        let mut releases = Vec::new();
        let mut requests = Vec::new();
        for _ in 0..MAX_NATIVE_WORK {
            let (entered, started) = tokio::sync::oneshot::channel();
            let (release, held) = std::sync::mpsc::channel();
            let copy = owner.clone();
            requests.push(tokio::spawn(async move {
                copy.run(move || {
                    let _ = entered.send(());
                    held.recv().unwrap();
                    Ok(())
                })
                .await
            }));
            started.await.unwrap();
            releases.push(release);
        }
        assert_eq!(owner.active().unwrap(), MAX_NATIVE_WORK);
        let called = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let effect = called.clone();
        assert_eq!(
            owner
                .run(move || {
                    effect.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                })
                .await
                .unwrap_err()
                .code,
            "BACKPRESSURE"
        );
        assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
        for release in releases {
            release.send(()).unwrap();
        }
        for request in requests {
            request.await.unwrap().unwrap();
        }
        owner.drain().await.unwrap();
        assert_eq!(owner.active().unwrap(), 0);
    }
    #[tokio::test]
    async fn failed_or_panicked_native_call_settles_without_faking_success() {
        let owner = NativeWorkOwner::default();
        assert_eq!(
            owner
                .run(|| Err(EngineError::new("INTERNAL_ERROR")))
                .await
                .unwrap_err()
                .code,
            "INTERNAL_ERROR"
        );
        assert_eq!(
            owner
                .run(|| panic!("controlled native call panic"))
                .await
                .unwrap_err()
                .code,
            "INTERNAL_ERROR"
        );
        owner.drain().await.unwrap();
        assert_eq!(owner.active().unwrap(), 0);
    }
}
