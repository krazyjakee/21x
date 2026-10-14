//! Complementary finite DTO policy. Actual scopes, secrets, filesystem and
//! process effects remain owned by the production TypeScript domain services.
use super::{bounded_bytes, id, integer, object, text};
use serde_json::Value;
use std::collections::HashSet;

pub const COMMANDS: &[&str] = &[
    "cliMcp:snapshot",
    "cliMcp:upsert",
    "cliMcp:remove",
    "cliMcp:setEnabled",
    "cliMcp:setToolEnabled",
    "cliMcp:probe",
    "chatImages:saveToTask",
    "attachments:remove",
];
fn optional(v: &Value, key: &str, check: impl Fn(&Value) -> bool) -> bool {
    v.get(key).is_none_or(check)
}
fn choice(v: &Value, values: &[&str]) -> bool {
    v.as_str().is_some_and(|s| values.contains(&s))
}
fn list(v: &Value, max: usize, check: impl Fn(&Value) -> bool) -> bool {
    v.as_array()
        .is_some_and(|a| a.len() <= max && a.iter().all(check))
}
fn unique(v: &Value, key: Option<&str>) -> bool {
    v.as_array().is_some_and(|a| {
        a.iter()
            .filter_map(|v| key.map_or(Some(v), |k| v.get(k)))
            .filter_map(Value::as_str)
            .collect::<HashSet<_>>()
            .len()
            == a.len()
    })
}
fn cli(v: &Value) -> bool {
    choice(v, &["claude-code", "opencode", "codex"])
}
fn ecma_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn ecma_nonempty(s: &str) -> bool {
    !s.trim_matches(ecma_whitespace).is_empty()
}
fn name(v: &Value) -> bool {
    text(v, 128)
        && v.as_str().is_some_and(|s| {
            ecma_nonempty(s)
                && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
                && !["__proto__", "constructor", "prototype"].contains(&s)
        })
}
fn fingerprint(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
// The service applies the exact JavaScript Date.parse predicate. Native
// checks bound the producer date label without inventing a stricter parser.
fn date(v: &Value) -> bool {
    text(v, 128) && v.as_str().is_some_and(|s| !s.is_empty())
}
fn dictionary(v: &Value, env: bool) -> bool {
    v.as_object().is_some_and(|m| {
        m.len() <= 128
            && m.iter().all(|(k, v)| {
                name(&Value::String(k.clone()))
                    && text(v, 16384)
                    && if env {
                        k.bytes()
                            .next()
                            .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
                            && k.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
                    } else {
                        !k.contains(['\r', '\n', ':'])
                    }
            })
    })
}
fn definition(v: &Value, input: bool) -> bool {
    if !object(
        v,
        &["transport"],
        &["command", "args", "url", "env", "headers"],
    ) || !choice(&v["transport"], &["stdio", "http", "sse"])
        || !optional(v, "command", |x| text(x, 4096))
        || !optional(v, "args", |x| list(x, 128, |s| text(s, 4096)))
        || !optional(v, "url", |x| text(x, 4096))
        || !optional(v, "env", |x| dictionary(x, true))
        || !optional(v, "headers", |x| dictionary(x, false))
    {
        return false;
    }
    if !input {
        return true;
    }
    if v["transport"] == "stdio" {
        return v["command"]
            .as_str()
            .is_some_and(|s| ecma_nonempty(s) && !s.contains(['\r', '\n']));
    }
    v["url"]
        .as_str()
        .and_then(|s| url::Url::parse(s).ok())
        .is_some_and(|u| {
            ["http", "https"].contains(&u.scheme())
                && u.username().is_empty()
                && u.password().is_none_or(str::is_empty)
                && u.query().is_none_or(str::is_empty)
                && u.fragment().is_none_or(str::is_empty)
        })
}
fn reference(v: &Value, extra: &[&str]) -> bool {
    let mut required = vec!["cli", "name"];
    required.extend_from_slice(extra);
    object(v, &required, &["expectedFingerprint"])
        && cli(&v["cli"])
        && name(&v["name"])
        && optional(v, "expectedFingerprint", fingerprint)
}
fn tools(v: &Value) -> bool {
    list(v, 128, |x| {
        object(x, &["name", "description"], &[])
            && name(&x["name"])
            && text(&x["description"], 4096)
    })
}
fn probe(v: &Value, extended: bool) -> bool {
    let mut opts = vec!["error", "errorDetail", "toolCount"];
    if extended {
        opts.extend_from_slice(&["tools", "unresolvedReferences"]);
    }
    object(v, &["status", "checkedAt"], &opts)
        && choice(&v["status"], &["connected", "failed"])
        && date(&v["checkedAt"])
        && optional(v, "error", |x| text(x, 4096))
        && optional(v, "errorDetail", |x| text(x, 4096))
        && optional(v, "toolCount", |x| {
            integer(x) && x.as_u64().is_some_and(|n| n <= 128)
        })
        && (!extended
            || optional(v, "tools", tools)
                && optional(v, "unresolvedReferences", |x| list(x, 128, name)))
}
fn server(v: &Value) -> bool {
    object(
        v,
        &[
            "cli",
            "name",
            "definition",
            "enabled",
            "disabledTools",
            "maskedKeys",
            "issues",
        ],
        &["enabledToolsOnly", "tools", "probe"],
    ) && cli(&v["cli"])
        && name(&v["name"])
        && definition(&v["definition"], false)
        && v["enabled"].is_boolean()
        && list(&v["disabledTools"], 128, name)
        && optional(v, "enabledToolsOnly", |x| list(x, 128, name))
        && object(&v["maskedKeys"], &["env", "headers"], &[])
        && ["env", "headers"]
            .iter()
            .all(|k| list(&v["maskedKeys"][k], 128, name))
        && list(&v["issues"], 32, |x| text(x, 4096))
        && optional(v, "tools", tools)
        && optional(v, "probe", |x| probe(x, false))
}
fn config(v: &Value) -> bool {
    object(
        v,
        &[
            "cli",
            "label",
            "files",
            "fingerprint",
            "capabilities",
            "notes",
        ],
        &["error"],
    ) && cli(&v["cli"])
        && text(&v["label"], 128)
        && fingerprint(&v["fingerprint"])
        && list(&v["files"], 2, |f| {
            object(f, &["path", "exists", "role"], &[])
                && text(&f["path"], 4096)
                && f["exists"].is_boolean()
                && text(&f["role"], 128)
        })
        && object(
            &v["capabilities"],
            &["serverToggle", "toolToggle", "envReferenceSyntax"],
            &[],
        )
        && ["serverToggle", "toolToggle"]
            .iter()
            .all(|k| choice(&v["capabilities"][k], &["native", "deny-rule", "none"]))
        && text(&v["capabilities"]["envReferenceSyntax"], 128)
        && list(&v["notes"], 32, |x| text(x, 4096))
        && optional(v, "error", |x| text(x, 4096))
}
fn snapshot(v: &Value) -> bool {
    object(v, &["clis", "servers", "loadedAt"], &[])
        && v["clis"]
            .as_array()
            .is_some_and(|a| a.len() == 3 && a.iter().all(config))
        && unique(&v["clis"], Some("cli"))
        && list(&v["servers"], 128, server)
        && date(&v["loadedAt"])
        && bounded_bytes(v, 900000)
}
fn apply(v: &Value) -> bool {
    object(v, &["cli", "ok", "warnings"], &["error", "conflict"])
        && cli(&v["cli"])
        && v["ok"].is_boolean()
        && list(&v["warnings"], 32, |x| text(x, 4096))
        && optional(v, "error", |x| text(x, 4096))
        && optional(v, "conflict", |x| {
            object(
                x,
                &["cli", "paths", "expectedFingerprint", "currentFingerprint"],
                &[],
            ) && cli(&x["cli"])
                && list(&x["paths"], 2, |s| text(s, 4096))
                && fingerprint(&x["expectedFingerprint"])
                && fingerprint(&x["currentFingerprint"])
        })
}
fn mutation(v: &Value) -> bool {
    object(v, &["results", "snapshot"], &[])
        && list(&v["results"], 3, apply)
        && snapshot(&v["snapshot"])
}
fn upsert(v: &Value) -> bool {
    object(
        v,
        &["targets", "name", "definition"],
        &["previousName", "expectedFingerprints"],
    ) && list(&v["targets"], 3, cli)
        && v["targets"].as_array().is_some_and(|a| !a.is_empty())
        && unique(&v["targets"], None)
        && name(&v["name"])
        && v["name"].as_str().is_some_and(|s| {
            !["__proto__", "constructor", "prototype"].contains(&s.trim_matches(ecma_whitespace))
        })
        && optional(v, "previousName", name)
        && definition(&v["definition"], true)
        && optional(v, "expectedFingerprints", |x| {
            x.as_object().is_some_and(|m| {
                m.iter()
                    .all(|(k, v)| cli(&Value::String(k.clone())) && fingerprint(v))
            })
        })
}
fn utf8(v: &Value, max: usize) -> bool {
    v.as_str().is_some_and(|s| s.len() <= max)
}
pub(crate) fn uuid(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        let b = s.as_bytes();
        b.len() == 36
            && b.iter().enumerate().all(|(i, c)| {
                if [8, 13, 18, 23].contains(&i) {
                    *c == b'-'
                } else {
                    c.is_ascii_hexdigit()
                }
            })
            && (b'1'..=b'5').contains(&b[14])
            && matches!(b[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
    })
}
pub(crate) fn filename(v: &Value) -> bool {
    utf8(v, 216)
        && v.as_str().is_some_and(|s| {
            if s.is_empty()
                || s == "."
                || s == ".."
                || s.ends_with(['.', ' '])
                || s.chars().any(|c| {
                    c <= '\u{1f}'
                        || c == '\u{7f}'
                        || ('\u{202a}'..='\u{202e}').contains(&c)
                        || ('\u{2066}'..='\u{2069}').contains(&c)
                        || "\\/<>:\"|?*".contains(c)
                })
            {
                return false;
            }
            let base = s.split('.').next().unwrap_or("").to_ascii_lowercase();
            if ["con", "prn", "aux", "nul"].contains(&base.as_str()) {
                return false;
            }
            let tail = base
                .strip_prefix("com")
                .or_else(|| base.strip_prefix("lpt"));
            !tail.is_some_and(|s| {
                s.chars().count() == 1
                    && s.chars()
                        .next()
                        .is_some_and(|c| ('1'..='9').contains(&c) || "¹²³".contains(c))
            })
        })
}
fn mime(v: &Value) -> bool {
    choice(v, &["image/png", "image/jpeg", "image/gif", "image/webp"])
}
fn base64(data: &str) -> Option<usize> {
    if data.is_empty() || data.len() % 4 != 0 || data.len() > (512 * 1024_usize).div_ceil(3) * 4 {
        return None;
    }
    let padding = data
        .as_bytes()
        .iter()
        .rev()
        .take_while(|c| **c == b'=')
        .count();
    if padding > 2 {
        return None;
    }
    if !data.as_bytes()[..data.len() - padding]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || matches!(*b, b'+' | b'/'))
    {
        return None;
    }
    let mut head = [0_u8; 12];
    let mut count = 0;
    let mut acc = 0_u32;
    let mut bits = 0;
    for b in data.bytes().take(16).take_while(|b| *b != b'=') {
        let six = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(six);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            head[count] = (acc >> bits) as u8;
            count += 1;
            acc &= (1 << bits) - 1;
        }
    }
    let valid = count >= 8 && head[..8] == [137, 80, 78, 71, 13, 10, 26, 10]
        || count >= 3 && head[..3] == [255, 216, 255]
        || count >= 6 && (head[..6] == *b"GIF87a" || head[..6] == *b"GIF89a")
        || count >= 12 && head[..4] == *b"RIFF" && head[8..12] == *b"WEBP";
    if !valid {
        return None;
    }
    Some(data.len() * 3 / 4 - padding)
}
fn images(v: &Value) -> bool {
    v.as_array().is_some_and(|a| {
        if a.len() > 5 {
            return false;
        }
        let mut total = 0;
        for image in a {
            if !object(image, &["name", "mimeType", "data"], &[])
                || !utf8(&image["name"], 1024)
                || !mime(&image["mimeType"])
            {
                return false;
            }
            let Some(size) = image["data"].as_str().and_then(base64) else {
                return false;
            };
            total += size;
            if size > 512 * 1024 || total > 512 * 1024 {
                return false;
            }
        }
        true
    })
}
fn attachment(v: &Value) -> bool {
    object(v, &["id", "filename", "size", "mime_type", "added_at"], &[])
        && uuid(&v["id"])
        && filename(&v["filename"])
        && integer(&v["size"])
        && utf8(&v["mime_type"], 128)
        && v["mime_type"].as_str().is_some_and(|s| {
            let parts: Vec<_> = s.split('/').collect();
            parts.len() == 2
                && parts.iter().all(|s| {
                    !s.is_empty()
                        && s.bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b".+-".contains(&c))
                })
        })
        && utf8(&v["added_at"], 64)
        && v["added_at"].as_str().is_some_and(|s| {
            let b = s.as_bytes();
            b.len() >= 11
                && b[..4].iter().all(u8::is_ascii_digit)
                && b[4] == b'-'
                && b[5..7].iter().all(u8::is_ascii_digit)
                && b[7] == b'-'
                && b[8..10].iter().all(u8::is_ascii_digit)
                && b[10] == b'T'
        })
}
pub fn request(op: &str, v: &Value) -> bool {
    if op == "chatImages:saveToTask" {
        return bounded_bytes(v, 889999)
            && object(v, &["taskId", "images"], &[])
            && id(&v["taskId"])
            && images(&v["images"]);
    }
    if op == "attachments:remove" {
        return bounded_bytes(v, 889999)
            && object(v, &["taskId", "attachmentId"], &[])
            && id(&v["taskId"])
            && uuid(&v["attachmentId"]);
    }
    if !bounded_bytes(v, 900000) {
        return false;
    }
    match op {
        "cliMcp:snapshot" => object(v, &[], &[]),
        "cliMcp:upsert" => object(v, &["request"], &[]) && upsert(&v["request"]),
        "cliMcp:remove" | "cliMcp:probe" => object(v, &["ref"], &[]) && reference(&v["ref"], &[]),
        "cliMcp:setEnabled" => {
            object(v, &["ref"], &[])
                && reference(&v["ref"], &["enabled"])
                && v["ref"]["enabled"].is_boolean()
        }
        "cliMcp:setToolEnabled" => {
            object(v, &["ref"], &[])
                && reference(&v["ref"], &["tool", "enabled"])
                && name(&v["ref"]["tool"])
                && v["ref"]["enabled"].is_boolean()
        }
        _ => false,
    }
}
pub fn result(op: &str, wire: &Value) -> bool {
    if op == "attachments:remove" {
        return object(wire, &["defined"], &[]) && wire["defined"] == false;
    }
    if !object(wire, &["defined", "value"], &[]) || wire["defined"] != true {
        return false;
    }
    let v = &wire["value"];
    if op == "chatImages:saveToTask" {
        return bounded_bytes(v, 131072) && list(v, 128, attachment) && unique(v, Some("id"));
    }
    if !bounded_bytes(v, 900000) {
        return false;
    }
    match op {
        "cliMcp:snapshot" => snapshot(v),
        "cliMcp:upsert" | "cliMcp:remove" | "cliMcp:setEnabled" | "cliMcp:setToolEnabled" => {
            mutation(v)
        }
        "cliMcp:probe" => probe(v, true),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const UUID: &str = "61f07006-c85b-438e-83a7-497c77b0dcae";
    fn metadata() -> Value {
        json!({"id":UUID,"filename":"写真.png","size":12,"mime_type":"image/png","added_at":"2026-10-14T00:00:00.000Z"})
    }
    #[test]
    fn exact_requests_do_not_grant_paths_callbacks_or_namespaces() {
        assert_eq!(COMMANDS.len(), 8);
        for op in COMMANDS {
            assert!(!request(op, &json!({"nativeGrant":true})), "{op}");
        }
        assert!(request(
            "cliMcp:upsert",
            &json!({"request":{"targets":["codex"],"name":"actual","definition":{"transport":"stdio","command":"fixture","env":{"TOKEN":"••••••••"}}}})
        ));
        assert!(!request(
            "cliMcp:upsert",
            &json!({"request":{"targets":["codex","codex"],"name":"actual","definition":{"transport":"stdio","command":"fixture"}}})
        ));
        for name in [" __proto__ ", "constructor\u{feff}", " prototype "] {
            assert!(!request(
                "cliMcp:upsert",
                &json!({"request":{"targets":["claude-code"],"name":name,"definition":{"transport":"stdio","command":"fixture"}}})
            ));
        }
        for url in [
            "https://user:secret@example.test/mcp",
            "https://example.test/mcp?token=secret",
            "https://example.test/mcp#token",
        ] {
            assert!(!request(
                "cliMcp:upsert",
                &json!({"request":{"targets":["codex"],"name":"actual","definition":{"transport":"http","url":url}}})
            ));
        }
        assert!(request(
            "cliMcp:remove",
            &json!({"ref":{"cli":"opencode","name":"actual","expectedFingerprint":"a".repeat(64)}})
        ));
        assert!(!request(
            "cliMcp:remove",
            &json!({"ref":{"cli":"opencode","name":"actual","fingerprint":"a".repeat(64)}})
        ));
        assert!(!request(
            "cliMcp:setToolEnabled",
            &json!({"ref":{"cli":"codex","name":"actual","tool":"__proto__","enabled":true}})
        ));
        assert!(request(
            "attachments:remove",
            &json!({"taskId":"task_fixture","attachmentId":UUID})
        ));
        assert!(!request(
            "attachments:remove",
            &json!({"taskId":"task_fixture","attachmentId":UUID,"filename":"private"})
        ));
    }
    #[test]
    fn string_units_image_magic_aggregate_and_uuid_versions_match_source() {
        assert!(request(
            "cliMcp:upsert",
            &json!({"request":{"targets":["codex"],"name":"\u{0085}","definition":{"transport":"stdio","command":"\u{0085}"}}})
        ));
        assert!(!request(
            "cliMcp:upsert",
            &json!({"request":{"targets":["codex"],"name":"\u{feff}","definition":{"transport":"stdio","command":"fixture"}}})
        ));
        assert!(!request(
            "cliMcp:upsert",
            &json!({"request":{"targets":["codex"],"name":"actual","definition":{"transport":"stdio","command":"\u{feff}"}}})
        ));
        assert!(text(&json!("🌱".repeat(2048)), 4096));
        assert!(!text(&json!("🌱".repeat(2049)), 4096));
        assert!(utf8(&json!("🌱".repeat(256)), 1024));
        assert!(!utf8(&json!("🌱".repeat(257)), 1024));
        assert!(request(
            "chatImages:saveToTask",
            &json!({"taskId":"task_fixture","images":[{"name":"../写真.png","mimeType":"image/jpeg","data":"iVBORw0KGgoAAQID"}]})
        ));
        assert!(!request(
            "chatImages:saveToTask",
            &json!({"taskId":"task_fixture","images":[{"name":"a.png","mimeType":"image/png","data":"YWJjZA=="}]})
        ));
        let data = format!("iVBORw0KGgoA{}", "A".repeat(400000));
        assert!(!request(
            "chatImages:saveToTask",
            &json!({"taskId":"task_fixture","images":[{"name":"a.png","mimeType":"image/png","data":data},{"name":"b.png","mimeType":"image/png","data":data}]})
        ));
        assert!(uuid(&json!("61f07006-c85b-538e-83a7-497c77b0dcae")));
        assert!(!uuid(&json!("61f07006-c85b-638e-83a7-497c77b0dcae")));
        for invalid in ["../private", "CON.png", "COM¹.txt", "unsafe.", "a/b"] {
            assert!(!filename(&json!(invalid)));
        }
    }
    #[test]
    fn finite_results_preserve_metadata_void_and_probe_shapes() {
        assert!(result(
            "chatImages:saveToTask",
            &json!({"defined":true,"value":[metadata()]})
        ));
        assert!(!result(
            "chatImages:saveToTask",
            &json!({"defined":true,"value":[metadata(),metadata()]})
        ));
        assert!(result("attachments:remove", &json!({"defined":false})));
        assert!(!result(
            "attachments:remove",
            &json!({"defined":false,"value":null})
        ));
        assert!(result(
            "cliMcp:probe",
            &json!({"defined":true,"value":{"status":"failed","checkedAt":"2026-10-14T00:00:00.000Z","error":"The MCP connection could not be checked.","tools":[],"unresolvedReferences":["TOKEN"]}})
        ));
        assert!(!result(
            "cliMcp:probe",
            &json!({"defined":true,"value":{"status":"failed","checkedAt":"2026-10-14T00:00:00.000Z","tools":[{"name":"tool","description":"x".repeat(4097)}]}})
        ));
        assert!(!result(
            "cliMcp:probe",
            &json!({"defined":true,"value":{"status":"uncertain","checkedAt":"2026-10-14T00:00:00.000Z"}})
        ));
    }
    #[test]
    fn actual_owned_results_have_finite_outer_dtos() {
        let Ok(path) = std::env::var("TWENTYONEX_CLI_ATTACHMENTS_RESULTS") else {
            return;
        };
        let bytes = std::fs::read(path).unwrap();
        assert!(bytes.len() < 16000000);
        let corpus: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(corpus["version"], 1);
        let rows = corpus["responses"].as_array().unwrap();
        assert_eq!(rows.len(), COMMANDS.len());
        let operations: HashSet<_> = rows
            .iter()
            .filter_map(|row| row["operation"].as_str())
            .collect();
        assert_eq!(operations.len(), COMMANDS.len());
        for row in rows {
            let op = row["operation"].as_str().unwrap();
            assert!(COMMANDS.contains(&op));
            assert!(result(op, &row["wire"]), "{op}: {}", row["wire"]);
        }
    }
}
