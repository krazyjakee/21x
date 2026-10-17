//! Private OAuth leases. Callback secrets never become Tauri events or errors.
use crate::EngineError;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Notify;
use url::Url;

const MAX_ACTIVE: usize = 16;
const MAX_ISSUED: usize = 4096;
fn invalid() -> EngineError {
    EngineError::new("INVALID_ARGUMENTS")
}
fn exact(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|m| m.len() == keys.len() && keys.iter().all(|k| m.contains_key(*k)))
}
pub fn flow_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            14 => b == b'4',
            19 => matches!(b, b'8' | b'9' | b'a' | b'b'),
            _ => b.is_ascii_digit() || matches!(b, b'a'..=b'f'),
        })
}
fn state(value: &str) -> bool {
    (16..=256).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'-'))
}
fn code(value: &str) -> bool {
    (1..=4096).contains(&value.len()) && value.bytes().all(|b| (0x21..=0x7e).contains(&b))
}
pub fn redirect(kind: &str, value: &str) -> bool {
    match kind {
        "custom-scheme" => matches!(
            value,
            "twentyonex://oauth/callback" | "nuanu://oauth/callback"
        ),
        "loopback" => {
            (3000..=3010).any(|port| value == format!("http://localhost:{port}/callback"))
        }
        _ => false,
    }
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn authorization(value: &str) -> Option<(String, String)> {
    if value.len() > 8192
        || !value.starts_with("https://")
        || !value.bytes().all(|b| (0x21..=0x7e).contains(&b))
        || value.contains(['\\', '#'])
    {
        return None;
    }
    let url = Url::parse(value).ok()?;
    let authority = value[8..].split(['/', '?']).next()?;
    if authority.contains('@')
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let mut states = url
        .query_pairs()
        .filter(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned());
    let mut redirects = url
        .query_pairs()
        .filter(|(k, _)| k == "redirect_uri")
        .map(|(_, v)| v.into_owned());
    let nonce = states.next()?;
    let uri = redirects.next()?;
    (state(&nonce) && states.next().is_none() && redirects.next().is_none()).then_some((nonce, uri))
}
pub fn registration(value: &Value) -> bool {
    if !exact(
        value,
        &[
            "flowId",
            "kind",
            "stateSha256",
            "redirectUri",
            "authorizationUrl",
            "ttlMs",
        ],
    ) {
        return false;
    }
    let Some(id) = value["flowId"].as_str() else {
        return false;
    };
    let Some(kind) = value["kind"].as_str() else {
        return false;
    };
    let Some(uri) = value["redirectUri"].as_str() else {
        return false;
    };
    let Some(hash) = value["stateSha256"].as_str() else {
        return false;
    };
    let Some(auth) = value["authorizationUrl"].as_str() else {
        return false;
    };
    flow_id(id)
        && redirect(kind, uri)
        && hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
        && value["ttlMs"]
            .as_u64()
            .is_some_and(|ms| (1..=300000).contains(&ms))
        && authorization(auth).is_some_and(|(_, redirect)| redirect == uri)
}
pub fn flow_request(value: &Value) -> bool {
    exact(value, &["flowId"]) && value["flowId"].as_str().is_some_and(flow_id)
}
pub fn callback(value: &Value) -> bool {
    if !exact(
        value,
        &["flowId", "kind", "redirectUri", "state", "outcome"],
    ) || !value["flowId"].as_str().is_some_and(flow_id)
        || value["kind"] != "custom-scheme"
        || !value["redirectUri"]
            .as_str()
            .is_some_and(|s| redirect("custom-scheme", s))
        || !value["state"].as_str().is_some_and(state)
    {
        return false;
    }
    let outcome = &value["outcome"];
    if outcome["status"] == "code" {
        exact(outcome, &["status", "code"]) && outcome["code"].as_str().is_some_and(code)
    } else {
        exact(outcome, &["status"])
            && matches!(outcome["status"].as_str(), Some("denied" | "failed"))
    }
}
pub fn delivery_receipt(value: &Value) -> bool {
    exact(value, &["accepted"]) && value["accepted"].is_boolean()
}

struct Entry {
    kind: String,
    uri: String,
    authorization: Option<String>,
    state_hash: String,
    expires: Instant,
    opening: bool,
    consumed: bool,
    retiring: bool,
    active: usize,
}
#[derive(Default)]
struct State {
    closing: bool,
    entries: HashMap<String, Entry>,
    issued: HashSet<String>,
    states: HashSet<String>,
}
struct Inner {
    state: Mutex<State>,
    settled: Notify,
    custom_schemes: bool,
}
#[derive(Clone)]
pub struct OAuthAuthority(Arc<Inner>);
/// A raw open/delivery receipt stays alive even if its public request times out.
pub struct OAuthWork {
    owner: OAuthAuthority,
    id: String,
    payload: Value,
}
impl OAuthWork {
    pub fn payload(&self) -> &Value {
        &self.payload
    }
}
impl Drop for OAuthWork {
    fn drop(&mut self) {
        if let Ok(mut state) = self.owner.0.state.lock() {
            if let Some(entry) = state.entries.get_mut(&self.id) {
                entry.active -= 1;
            }
        }
        self.owner.0.settled.notify_waiters();
    }
}
impl OAuthAuthority {
    /// `custom_schemes` is trusted registration authority, never a WebView flag.
    pub fn new(custom_schemes: bool) -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(State::default()),
            settled: Notify::new(),
            custom_schemes,
        }))
    }
    pub fn register(&self, request: &Value) -> Result<Value, EngineError> {
        if !registration(request) {
            return Err(invalid());
        }
        let id = request["flowId"].as_str().unwrap();
        let kind = request["kind"].as_str().unwrap();
        if kind == "custom-scheme" && !self.0.custom_schemes {
            return Err(EngineError::new("UNKNOWN_OPERATION"));
        }
        let auth = request["authorizationUrl"].as_str().unwrap();
        let (nonce, _) = authorization(auth).ok_or_else(invalid)?;
        let hash = digest(&nonce);
        if request["stateSha256"] != hash {
            return Err(invalid());
        }
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        if state.closing {
            return Err(EngineError::new("DISCONNECTED"));
        }
        if state.issued.contains(id) || state.states.contains(&hash) {
            return Err(invalid());
        }
        if state.entries.len() >= MAX_ACTIVE || state.issued.len() >= MAX_ISSUED {
            return Err(EngineError::new("BACKPRESSURE"));
        }
        state.entries.insert(
            id.into(),
            Entry {
                kind: kind.into(),
                uri: request["redirectUri"].as_str().unwrap().into(),
                authorization: Some(auth.into()),
                state_hash: hash.clone(),
                expires: Instant::now() + Duration::from_millis(request["ttlMs"].as_u64().unwrap()),
                opening: false,
                consumed: false,
                retiring: false,
                active: 0,
            },
        );
        state.issued.insert(id.into());
        state.states.insert(hash);
        Ok(json!({"flowId":id,"registered":true}))
    }
    pub fn begin_open(&self, id: &str) -> Result<OAuthWork, EngineError> {
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        if state.closing {
            return Err(EngineError::new("DISCONNECTED"));
        }
        let entry = state.entries.get_mut(id).ok_or_else(invalid)?;
        if entry.retiring || entry.opening || entry.consumed || Instant::now() >= entry.expires {
            return Err(invalid());
        }
        entry.opening = true;
        entry.active += 1;
        let url = entry.authorization.take().ok_or_else(invalid)?;
        Ok(OAuthWork {
            owner: self.clone(),
            id: id.into(),
            payload: json!({"url":url}),
        })
    }
    /// Parse first, then atomically claim. Foreign/malformed input cannot burn a lease.
    pub fn begin_delivery(&self, raw: &str) -> Result<OAuthWork, EngineError> {
        if !self.0.custom_schemes {
            return Err(EngineError::new("UNKNOWN_OPERATION"));
        }
        let (uri, nonce, outcome) = parse_callback(raw).ok_or_else(invalid)?;
        let hash = digest(&nonce);
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        if state.closing {
            return Err(EngineError::new("DISCONNECTED"));
        }
        let Some((id, entry)) = state
            .entries
            .iter_mut()
            .find(|(_, e)| e.state_hash == hash && e.uri == uri && e.kind == "custom-scheme")
        else {
            return Err(invalid());
        };
        if entry.retiring || !entry.opening || entry.consumed || Instant::now() >= entry.expires {
            return Err(invalid());
        }
        entry.consumed = true;
        entry.active += 1;
        Ok(OAuthWork {
            owner: self.clone(),
            id: id.clone(),
            payload: json!({"flowId":id,"kind":"custom-scheme","redirectUri":uri,"state":nonce,"outcome":outcome}),
        })
    }
    pub fn stop(&self) -> Result<(), EngineError> {
        self.0
            .state
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?
            .closing = true;
        Ok(())
    }
    pub async fn retire(&self, id: &str) -> Result<Value, EngineError> {
        if !flow_id(id) {
            return Err(invalid());
        }
        loop {
            let settled = self.0.settled.notified();
            {
                let mut state = self
                    .0
                    .state
                    .lock()
                    .map_err(|_| EngineError::new("DISCONNECTED"))?;
                match state.entries.get_mut(id) {
                    Some(entry) => {
                        entry.retiring = true;
                        if entry.active == 0 {
                            state.entries.remove(id);
                            return Ok(json!({"flowId":id,"retired":true}));
                        }
                    }
                    None => return Ok(json!({"flowId":id,"retired":true})),
                }
            }
            settled.await;
        }
    }
    pub async fn close(&self) -> Result<(), EngineError> {
        self.stop()?;
        let ids: Vec<_> = self
            .0
            .state
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?
            .entries
            .keys()
            .cloned()
            .collect();
        for id in ids {
            self.retire(&id).await?;
        }
        Ok(())
    }
}
fn parse_callback(raw: &str) -> Option<(String, String, Value)> {
    if raw.len() > 8192
        || !raw.bytes().all(|b| (0x21..=0x7e).contains(&b))
        || raw.contains(['\\', '#'])
    {
        return None;
    }
    let (uri, _) = raw.split_once('?')?;
    if !redirect("custom-scheme", uri) {
        return None;
    }
    // WHATWG form decoding tolerates malformed percent encodings; callbacks do not.
    for (i, b) in raw.bytes().enumerate() {
        if b == b'%'
            && !raw
                .as_bytes()
                .get(i + 1..i + 3)
                .is_some_and(|s| s.iter().all(u8::is_ascii_hexdigit))
        {
            return None;
        }
    }
    let url = Url::parse(raw).ok()?;
    let mut fields = HashMap::new();
    for (key, value) in url.query_pairs() {
        if !matches!(
            key.as_ref(),
            "state" | "code" | "error" | "error_description" | "error_uri"
        ) || fields
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return None;
        }
    }
    let nonce = fields.remove("state")?;
    if !state(&nonce) {
        return None;
    }
    let outcome = match (fields.get("code"), fields.get("error")) {
        (Some(value), None) if code(value) && fields.len() == 1 => {
            json!({"status":"code","code":value})
        }
        (None, Some(error)) if code(error) => {
            json!({"status":if error == "access_denied" { "denied" } else { "failed" }})
        }
        _ => return None,
    };
    Some((uri.into(), nonce, outcome))
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "bdf2af85-5898-414c-a64c-27c38ce72eb2";
    const NONCE: &str = "synthetic_nonce_0123456789";
    fn request(kind: &str) -> Value {
        let uri = if kind == "custom-scheme" {
            "twentyonex://oauth/callback"
        } else {
            "http://localhost:3000/callback"
        };
        let mut url = Url::parse("https://provider.example/authorize").unwrap();
        url.query_pairs_mut()
            .append_pair("state", NONCE)
            .append_pair("redirect_uri", uri);
        json!({"flowId":ID,"kind":kind,"redirectUri":uri,"authorizationUrl":url.as_str(),"stateSha256":digest(NONCE),"ttlMs":300000})
    }
    fn success() -> String {
        format!("twentyonex://oauth/callback?state={NONCE}&code=synthetic-code")
    }
    #[tokio::test]
    async fn warm_delivery_is_one_shot_and_retirement_joins_open_and_delivery() {
        let owner = OAuthAuthority::new(true);
        owner.register(&request("custom-scheme")).unwrap();
        assert!(owner.begin_delivery(&success()).is_err());
        let opening = owner.begin_open(ID).unwrap();
        assert!(owner.begin_open(ID).is_err());
        let delivery = owner.begin_delivery(&success()).unwrap();
        assert!(callback(delivery.payload()));
        assert!(owner.begin_delivery(&success()).is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(5), owner.retire(ID))
                .await
                .is_err()
        );
        drop(opening);
        assert!(
            tokio::time::timeout(Duration::from_millis(5), owner.retire(ID))
                .await
                .is_err()
        );
        drop(delivery);
        assert_eq!(
            owner.retire(ID).await.unwrap(),
            json!({"flowId":ID,"retired":true})
        );
        assert!(owner.register(&request("custom-scheme")).is_err());
        owner.close().await.unwrap();
    }
    #[tokio::test]
    async fn foreign_or_malformed_callback_cannot_consume_matching_intent() {
        let owner = OAuthAuthority::new(true);
        owner.register(&request("custom-scheme")).unwrap();
        drop(owner.begin_open(ID).unwrap());
        for bad in [
            success().replace("twentyonex:", "nuanu:"),
            success().replace(NONCE, "foreign_nonce_0123456789"),
            success() + "&code=duplicate",
            success() + "&state=duplicate",
            success() + "&providerId=linear",
            success() + "#fragment",
            success().replace("synthetic-code", "%00"),
            success().replace("synthetic-code", "%GG"),
            success().replace("oauth/callback", "oauth/other/../callback"),
            success().replace("oauth/callback", "user@oauth/callback"),
            success() + "&error=access_denied",
        ] {
            assert!(owner.begin_delivery(&bad).is_err());
        }
        let accepted = owner.begin_delivery(&success()).unwrap();
        drop(accepted);
        owner.close().await.unwrap();
    }
    #[tokio::test]
    async fn denial_and_failure_are_sanitized_one_shot_outcomes() {
        for (error, status) in [("access_denied", "denied"), ("server_error", "failed")] {
            let owner = OAuthAuthority::new(true);
            owner.register(&request("custom-scheme")).unwrap();
            drop(owner.begin_open(ID).unwrap());
            let raw = format!("twentyonex://oauth/callback?state={NONCE}&error={error}&error_description=secret+detail&error_uri=https%3A%2F%2Fforeign.example");
            let delivery = owner.begin_delivery(&raw).unwrap();
            assert_eq!(delivery.payload()["outcome"], json!({"status":status}));
            assert!(!delivery.payload().to_string().contains("secret"));
            assert!(owner.begin_delivery(&success()).is_err());
            drop(delivery);
            owner.close().await.unwrap();
        }
    }
    #[tokio::test]
    async fn loopback_and_unapproved_schemes_do_not_gain_custom_callback_authority() {
        let owner = OAuthAuthority::new(false);
        assert_eq!(
            owner.register(&request("custom-scheme")).unwrap_err().code,
            "UNKNOWN_OPERATION"
        );
        owner.register(&request("loopback")).unwrap();
        drop(owner.begin_open(ID).unwrap());
        assert!(owner.begin_delivery(&success()).is_err());
        owner.close().await.unwrap();
    }
    #[tokio::test]
    async fn stop_fences_admission_and_retirement_stays_available() {
        let owner = OAuthAuthority::new(true);
        owner.register(&request("custom-scheme")).unwrap();
        let opening = owner.begin_open(ID).unwrap();
        owner.stop().unwrap();
        assert!(owner.begin_delivery(&success()).is_err());
        assert!(owner.begin_open(ID).is_err());
        let mut another = request("custom-scheme");
        another["flowId"] = json!("cdf2af85-5898-414c-a64c-27c38ce72eb2");
        assert_eq!(owner.register(&another).unwrap_err().code, "DISCONNECTED");
        drop(opening);
        owner.close().await.unwrap();
        assert!(owner.retire(ID).await.is_ok());
    }
    #[tokio::test]
    async fn expired_and_previous_process_pending_flows_cannot_complete() {
        let owner = OAuthAuthority::new(true);
        let mut value = request("custom-scheme");
        value["ttlMs"] = json!(1);
        owner.register(&value).unwrap();
        drop(owner.begin_open(ID).unwrap());
        tokio::time::sleep(Duration::from_millis(3)).await;
        assert!(owner.begin_delivery(&success()).is_err());
        let replacement = OAuthAuthority::new(true);
        assert!(replacement.begin_delivery(&success()).is_err());
        owner.close().await.unwrap();
        replacement.close().await.unwrap();
    }
    #[tokio::test]
    async fn bounded_capacity_never_evicts_state_replay_protection() {
        let owner = OAuthAuthority::new(false);
        for number in 0..MAX_ACTIVE {
            let mut value = request("loopback");
            value["flowId"] = json!(format!("{number:08x}-5898-414c-a64c-27c38ce72eb2"));
            let nonce = format!("unique_nonce_{number:016}");
            value["stateSha256"] = json!(digest(&nonce));
            value["authorizationUrl"] = json!(value["authorizationUrl"]
                .as_str()
                .unwrap()
                .replace(NONCE, &nonce));
            owner.register(&value).unwrap();
        }
        assert_eq!(
            owner.register(&request("loopback")).unwrap_err().code,
            "BACKPRESSURE"
        );
        owner
            .retire("00000000-5898-414c-a64c-27c38ce72eb2")
            .await
            .unwrap();
        let mut repeated = request("loopback");
        repeated["stateSha256"] = json!(digest("unique_nonce_0000000000000000"));
        repeated["authorizationUrl"] = json!(repeated["authorizationUrl"]
            .as_str()
            .unwrap()
            .replace(NONCE, "unique_nonce_0000000000000000"));
        assert_eq!(
            owner.register(&repeated).unwrap_err().code,
            "INVALID_ARGUMENTS"
        );
        owner.close().await.unwrap();
    }
    #[test]
    fn exact_registration_and_url_authority_rejects_injection_and_state_mismatch() {
        let good = request("loopback");
        assert!(registration(&good));
        for (field, bad) in [
            ("ttlMs", json!(300001)),
            ("redirectUri", json!("http://localhost:3011/callback")),
            ("flowId", json!("renderer-selected")),
            ("providerId", json!("linear")),
        ] {
            let mut value = good.clone();
            value[field] = bad;
            assert!(!registration(&value));
        }
        let owner = OAuthAuthority::new(false);
        let mut bad = good;
        bad["stateSha256"] = json!("0".repeat(64));
        assert!(owner.register(&bad).is_err());
        assert!(!callback(
            &json!({"flowId":ID,"kind":"custom-scheme","redirectUri":"twentyonex://oauth/callback","state":NONCE,"outcome":{"status":"denied","error_description":"secret"}})
        ));
    }
}
