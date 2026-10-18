//! Private viewer v1. These declarations grant no renderer operation or OS URL
//! handler. The native host fixes content policy and owns the child WebView.
use serde_json::Value;

pub const HTML_BYTES: usize = 128 * 1024;
pub const ACTIVE: usize = 16;
pub const EPOCH_IDS: usize = 4096;
pub const TTL_MS: u64 = 600_000;
pub const SCHEME: &str = "x21-artifact";
pub const CSP: &str = "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

fn exact(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    })
}
pub fn viewer_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                *byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)
            }
        })
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}
pub fn registration(value: &Value) -> bool {
    exact(value, &["viewerId", "uiLeaseId", "html"])
        && value["viewerId"].as_str().is_some_and(viewer_id)
        && crate::production_ui_contracts::lease_id(&value["uiLeaseId"])
        && value["html"]
            .as_str()
            .is_some_and(|html| html.len() <= HTML_BYTES)
}
pub fn identity(value: &Value) -> bool {
    exact(value, &["viewerId"]) && value["viewerId"].as_str().is_some_and(viewer_id)
}
pub fn receipt(value: &Value, field: &str, id: &str) -> bool {
    matches!(field, "registered" | "opened" | "retired")
        && exact(value, &["viewerId", field])
        && viewer_id(id)
        && value["viewerId"] == id
        && value[field] == true
}
pub fn closed(value: &Value) -> bool {
    exact(value, &["viewerId", "reason"])
        && value["viewerId"].as_str().is_some_and(viewer_id)
        && matches!(
            value["reason"].as_str(),
            Some("closed" | "parent-retired" | "expired" | "failed")
        )
}
pub fn delivery_receipt(value: &Value) -> bool {
    exact(value, &["accepted"]) && value["accepted"].is_boolean()
}
pub fn label(id: &str) -> String {
    format!("artifact-{id}")
}
pub fn document_url(id: &str) -> String {
    if cfg!(windows) {
        format!("http://{SCHEME}.localhost/{id}")
    } else {
        format!("{SCHEME}://localhost/{id}")
    }
}
/// No normalization of a caller path, query or encoded alias into authority.
pub fn document_request(label_value: &str, method: &str, uri: &str, id: &str) -> bool {
    viewer_id(id) && label_value == label(id) && method == "GET" && uri == document_url(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const ID: &str = "12345678-1234-4234-8234-123456789abc";
    #[test]
    fn finite_contract_rejects_other_identity_paths_grants_and_unbounded_html() {
        let valid = json!({"viewerId":ID,"uiLeaseId":"u".repeat(32),"html":"<b>preview</b>"});
        assert!(registration(&valid));
        for key in ["title", "url", "path", "profileId", "permissions", "script"] {
            let mut invalid = valid.clone();
            invalid[key] = json!("foreign");
            assert!(!registration(&invalid));
        }
        for id in [
            ID.to_uppercase(),
            ID.replace("-4234-", "-5234-"),
            "../main".into(),
        ] {
            let mut invalid = valid.clone();
            invalid["viewerId"] = json!(id);
            assert!(!registration(&invalid));
        }
        let mut invalid = valid.clone();
        invalid["html"] = json!("é".repeat(HTML_BYTES / 2 + 1));
        assert!(!registration(&invalid));
        assert!(identity(&json!({"viewerId":ID})));
        assert!(!identity(&json!({"viewerId":ID,"uiLeaseId":"foreign"})));
        assert!(receipt(&json!({"viewerId":ID,"opened":true}), "opened", ID));
        assert!(!receipt(
            &json!({"viewerId":ID,"opened":true,"url":"file:///"}),
            "opened",
            ID
        ));
    }
    #[test]
    fn content_transport_accepts_only_its_exact_excluded_document() {
        let url = document_url(ID);
        let label = label(ID);
        assert!(document_request(&label, "GET", &url, ID));
        for path in [
            format!("{url}?x=1"),
            format!("{url}#x"),
            format!("{url}/"),
            url.replace("12345678", "%31%32%33%34%35%36%37%38"),
        ] {
            assert!(!document_request(&label, "GET", &path, ID));
        }
        assert!(!document_request("main", "GET", &url, ID));
        assert!(!document_request(&label, "POST", &url, ID));
        assert!(!document_request(&label, "GET", "file:///etc/passwd", ID));
    }
    #[test]
    fn closed_callback_has_fixed_sanitized_reasons_and_boolean_ack_only() {
        for reason in ["closed", "parent-retired", "expired", "failed"] {
            assert!(closed(&json!({"viewerId":ID,"reason":reason})));
        }
        assert!(!closed(&json!({"viewerId":ID,"reason":"file:///private"})));
        assert!(!closed(
            &json!({"viewerId":ID,"reason":"closed","html":"secret"})
        ));
        assert!(delivery_receipt(&json!({"accepted":false})));
        assert!(!delivery_receipt(&json!({"accepted":true,"code":"secret"})));
    }
}
