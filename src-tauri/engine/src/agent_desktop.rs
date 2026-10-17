//! Debug fixture wire policy. No SDK, task ownership or approval authority is
//! inferred here; the dedicated synthetic service verifies those identities.
//! Keep exact fields/bounds aligned with agent-desktop-codecs.ts and its public
//! agent DTO from configuration-desktop-codecs.ts.
use serde_json::Value;
#[path = "agent_activity.rs"]
mod activity;
use std::collections::HashSet;

const OPERATIONS: &[&str] = &[
    "agent:getAll",
    "agentSession:start",
    "agentSession:resume",
    "agentSession:approve",
    "agentSession:stop",
];
const QUEUE_REASONS: &[&str] = &[
    "agent_limit",
    "global_limit",
    "global_pause",
    "project_paused",
    "project_daily_cap",
    "project_limit",
    "concurrency_level",
    "file_overlap",
    "recovery",
    "dependency",
    "agent_unavailable",
];
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const RECOVERY_ERROR: &str = "The agent operation failed.";
const QUEUE_FIELDS: &[&str] = &[
    "id",
    "taskId",
    "projectId",
    "agentId",
    "reason",
    "queuedAt",
    "position",
    "priority",
    "state",
    "retryCount",
    "nextRetryAt",
    "generation",
    "dependencyReason",
    "recoveryCause",
    "recoveryAction",
    "recoveryResult",
    "lastError",
];

fn object(value: &Value, required: &[&str], optional: &[&str]) -> bool {
    value.as_object().is_some_and(|map| {
        required.iter().all(|key| map.contains_key(*key))
            && map
                .keys()
                .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
    })
}
fn text(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|s| !s.contains('\0') && s.encode_utf16().count() <= max)
}
fn nonblank(value: &Value, max: usize) -> bool {
    text(value, max)
        && value.as_str().is_some_and(|s| {
            !s.trim_matches(|c: char| {
                matches!(c,
                    '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
                    '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
                    '\u{205f}' | '\u{3000}' | '\u{feff}'
                )
            })
            .is_empty()
        })
}
fn id(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 128
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
    })
}
fn positive(value: &Value) -> bool {
    value
        .as_u64()
        .is_some_and(|n| n >= 1 && n <= MAX_SAFE_INTEGER)
}
fn nonnegative(value: &Value) -> bool {
    value.as_u64().is_some_and(|n| n <= MAX_SAFE_INTEGER)
}
fn member(value: &Value, allowed: &[&str]) -> bool {
    value.as_str().is_some_and(|s| allowed.contains(&s))
}
fn array(value: &Value, check: fn(&Value) -> bool) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.len() <= 128 && items.iter().all(check))
}
fn unique_ids(value: &Value) -> bool {
    array(value, id)
        && value.as_array().is_some_and(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<HashSet<_>>()
                .len()
                == items.len()
        })
}
fn json(value: &Value, depth: usize) -> bool {
    depth <= 64
        && match value {
            Value::Array(items) => items.iter().all(|item| json(item, depth + 1)),
            Value::Object(map) => map.values().all(|item| json(item, depth + 1)),
            _ => true,
        }
}
fn server_url(value: &Value) -> bool {
    if !text(value, 8192) {
        return false;
    }
    let Some(source) = value.as_str() else {
        return false;
    };
    if source.bytes().any(|c| c <= 0x20 || c == 0x7f || c == b'\\') {
        return false;
    }
    let prefix = if source
        .get(..7)
        .is_some_and(|s| s.eq_ignore_ascii_case("http://"))
    {
        7
    } else if source
        .get(..8)
        .is_some_and(|s| s.eq_ignore_ascii_case("https://"))
    {
        8
    } else {
        return false;
    };
    let authority = source[prefix..].split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    url::Url::parse(source).is_ok_and(|parsed| {
        matches!(parsed.scheme(), "http" | "https")
            && parsed.has_host()
            && parsed.username().is_empty()
            && parsed.password().is_none()
    })
}
fn mcp_entry(value: &Value) -> bool {
    id(value)
        || object(value, &["serverId"], &["enabledTools"])
            && id(&value["serverId"])
            && value
                .get("enabledTools")
                .is_none_or(|items| array(items, |item| text(item, 256)))
}
fn public_config(value: &Value) -> bool {
    const FIELDS: &[&str] = &[
        "coding_agent",
        "model",
        "reasoning_effort",
        "auth_method",
        "permission_mode",
        "sandbox_mode",
        "system_prompt",
        "mcp_servers",
        "skill_ids",
        "secret_ids",
        "fallback_agent_ids",
        "max_parallel_sessions",
        "concurrency_cap",
    ];
    object(value, &[], FIELDS)
        && value
            .as_object()
            .unwrap()
            .iter()
            .all(|(key, item)| match key.as_str() {
                "coding_agent" => {
                    member(item, &["opencode", "claude-code", "codex", "cursor", "pi"])
                }
                "model" => text(item, 256),
                "reasoning_effort" => {
                    member(item, &["minimal", "low", "medium", "high", "xhigh", "max"])
                }
                "auth_method" => member(item, &["subscription", "api_key"]),
                "permission_mode" => member(item, &["ask", "allow"]),
                "sandbox_mode" => member(
                    item,
                    &["read-only", "workspace-write", "danger-full-access"],
                ),
                "system_prompt" => text(item, 65_536),
                "mcp_servers" => array(item, mcp_entry),
                "skill_ids" | "secret_ids" | "fallback_agent_ids" => unique_ids(item),
                "max_parallel_sessions" | "concurrency_cap" => positive(item),
                _ => false,
            })
}
fn public_agent(value: &Value) -> bool {
    object(
        value,
        &[
            "id",
            "name",
            "server_url",
            "config",
            "is_default",
            "created_at",
            "updated_at",
        ],
        &[],
    ) && id(&value["id"])
        && nonblank(&value["name"], 512)
        && server_url(&value["server_url"])
        && public_config(&value["config"])
        && value["is_default"].is_boolean()
        && text(&value["created_at"], 128)
        && text(&value["updated_at"], 128)
}

pub(super) fn known_operation(operation: &str) -> bool {
    OPERATIONS.contains(&operation)
}
pub(super) fn valid_request(operation: &str, value: &Value) -> bool {
    if !json(value, 0) {
        return false;
    }
    match operation {
        "agent:getAll" => object(value, &[], &[]),
        "agentSession:start" => {
            object(value, &["agentId", "taskId"], &["skipInitialPrompt"])
                && id(&value["agentId"])
                && id(&value["taskId"])
                && value.get("skipInitialPrompt").is_none_or(Value::is_boolean)
        }
        "agentSession:resume" => {
            object(value, &["agentId", "taskId", "sessionId"], &[])
                && ["agentId", "taskId", "sessionId"]
                    .iter()
                    .all(|key| id(&value[*key]))
        }
        "agentSession:approve" => {
            object(
                value,
                &["sessionId", "approved", "requestId"],
                &["message", "responseType"],
            ) && id(&value["sessionId"])
                && value["approved"].is_boolean()
                && nonblank(&value["requestId"], 512)
                && value.get("message").is_none_or(|item| text(item, 65_536))
                && value
                    .get("responseType")
                    .is_none_or(|item| member(item, &["permission", "question"]))
        }
        "agentSession:stop" => object(value, &["sessionId"], &[]) && id(&value["sessionId"]),
        _ => false,
    }
}
pub(super) fn valid_result(operation: &str, value: &Value) -> bool {
    if !known_operation(operation)
        || !json(value, 0)
        || !object(value, &["defined", "value"], &[])
        || value["defined"] != true
    {
        return false;
    }
    let result = &value["value"];
    match operation {
        "agent:getAll" => array(result, public_agent),
        "agentSession:start" => {
            object(result, &["sessionId"], &[]) && id(&result["sessionId"])
                || object(
                    result,
                    &["sessionId", "queued", "queuePosition", "queueReason"],
                    &[],
                ) && result["sessionId"] == ""
                    && result["queued"] == true
                    && positive(&result["queuePosition"])
                    && member(&result["queueReason"], QUEUE_REASONS)
        }
        "agentSession:resume" => {
            object(result, &["sessionId"], &[]) && id(&result["sessionId"])
                || object(result, &["sessionId", "ended"], &[])
                    && result["sessionId"] == ""
                    && result["ended"] == true
        }
        "agentSession:approve" | "agentSession:stop" => {
            object(result, &["success"], &[]) && result["success"].is_boolean()
        }
        _ => false,
    }
}
fn recovery_token(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 128
            && s.as_bytes()[0].is_ascii_lowercase()
            && s.bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'_' | b'-'))
    })
}
fn queue_entry(value: &Value) -> bool {
    object(value, QUEUE_FIELDS, &[])
        && ["id", "taskId", "projectId", "agentId"]
            .iter()
            .all(|key| id(&value[*key]))
        && member(&value["reason"], QUEUE_REASONS)
        && text(&value["queuedAt"], 128)
        && positive(&value["position"])
        && (value["priority"].is_null() || text(&value["priority"], 128))
        && member(
            &value["state"],
            &[
                "queued",
                "retrying",
                "claimed",
                "starting",
                "started",
                "recovered",
                "failed",
                "cancelled",
            ],
        )
        && nonnegative(&value["retryCount"])
        && nonnegative(&value["generation"])
        && (value["nextRetryAt"].is_null() || text(&value["nextRetryAt"], 128))
        && [
            "dependencyReason",
            "recoveryCause",
            "recoveryAction",
            "recoveryResult",
        ]
        .iter()
        .all(|key| value[*key].is_null() || recovery_token(&value[*key]))
        && (value["lastError"].is_null() || value["lastError"] == RECOVERY_ERROR)
}
pub(super) fn valid_event(frame: &Value) -> bool {
    let payload = &frame["payload"];
    if !json(payload, 0) {
        return false;
    }
    match frame["operation"].as_str() {
        Some("agent:status") => {
            object(
                payload,
                &["sessionId", "agentId", "taskId", "status"],
                &[
                    "epoch",
                    "seq",
                    "heartbeat",
                    "disconnected",
                    "activityOutcome",
                ],
            ) && ["sessionId", "agentId", "taskId"]
                .iter()
                .all(|key| id(&payload[*key]))
                && member(
                    &payload["status"],
                    &["idle", "working", "waiting_approval", "error"],
                )
                && activity::valid_metadata(payload)
        }
        Some("agent:startQueueChanged") => {
            object(payload, &["queue"], &["failed"])
                && payload["queue"]
                    .as_array()
                    .is_some_and(|entries| entries.len() <= 1 && entries.iter().all(queue_entry))
                && payload.get("failed").is_none_or(|failure| {
                    object(failure, &["taskId", "error"], &[])
                        && id(&failure["taskId"])
                        && failure["error"] == RECOVERY_ERROR
                })
        }
        Some("project:statusChanged" | "concurrency:changed") => {
            object(payload, &["projectId"], &[]) && id(&payload["projectId"])
        }
        Some("agent:recoveryStateChanged") => {
            object(
                payload,
                &["taskId", "cause", "action", "result", "error"],
                &[],
            ) && id(&payload["taskId"])
                && ["cause", "action", "result"]
                    .iter()
                    .all(|key| recovery_token(&payload[*key]))
                && (payload["error"].is_null() || payload["error"] == RECOVERY_ERROR)
        }
        // Existing task:updated/transcript:changed use desktop.rs's exact DB DTO.
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn fixture_requests_require_approval_identity_and_never_admit_workspace_or_extra_authority() {
        assert!(valid_request(
            "agentSession:start",
            &json!({"agentId":"agent-1","taskId":"task-1","skipInitialPrompt":true})
        ));
        assert!(valid_request(
            "agentSession:resume",
            &json!({"agentId":"agent-1","taskId":"task-1","sessionId":"session-1"})
        ));
        assert!(valid_request(
            "agentSession:approve",
            &json!({"sessionId":"session-1","approved":false,"requestId":"backend/request:1","responseType":"permission"})
        ));
        for payload in [
            json!({"sessionId":"session-1","approved":true}),
            json!({"sessionId":"session-1","approved":true,"requestId":"\u{feff}\u{00a0}"}),
            json!({"sessionId":"session-1","approved":true,"requestId":"request\0bad"}),
            json!({"sessionId":"session-1","approved":true,"requestId":"request-1","permissionMode":"allow"}),
        ] {
            assert!(!valid_request("agentSession:approve", &payload));
        }
        assert!(!valid_request(
            "agentSession:start",
            &json!({"agentId":"agent-1","taskId":"task-1","workspaceDir":null})
        ));
        assert!(!valid_request(
            "agentSession:resume",
            &json!({"agentId":"agent-1","taskId":"task-1","sessionId":"session-1","workspaceDir":"/tmp"})
        ));
        assert!(!known_operation("agentSession:send"));
        assert!(!known_operation("agent:create"));
        assert!(!known_operation("fixture.agentStart"));
    }
    #[test]
    fn optional_results_are_exact_and_queue_positions_are_positive_safe_integers() {
        assert!(valid_result(
            "agentSession:start",
            &json!({"defined":true,"value":{"sessionId":"session-1"}})
        ));
        assert!(valid_result(
            "agentSession:start",
            &json!({"defined":true,"value":{"sessionId":"","queued":true,"queuePosition":1,"queueReason":"agent_limit"}})
        ));
        assert!(valid_result(
            "agentSession:resume",
            &json!({"defined":true,"value":{"sessionId":"","ended":true}})
        ));
        assert!(valid_result(
            "agentSession:approve",
            &json!({"defined":true,"value":{"success":false}})
        ));
        for value in [
            json!({"defined":false}),
            json!({"defined":true,"value":{"sessionId":"","queued":true,"queuePosition":0,"queueReason":"agent_limit"}}),
            json!({"defined":true,"value":{"sessionId":"","queued":true,"queuePosition":9007199254740992u64,"queueReason":"agent_limit"}}),
            json!({"defined":true,"value":{"sessionId":"session-1","queued":false}}),
        ] {
            assert!(!valid_result("agentSession:start", &value));
        }
    }
    #[test]
    fn public_agents_reject_secret_config_fields_and_invalid_server_authority() {
        let agent = json!({"id":"agent-1","name":"Fixture agent","server_url":"http://localhost:4096","config":{"coding_agent":"opencode","secret_ids":["secret-1"],"max_parallel_sessions":1},"is_default":false,"created_at":"fixture","updated_at":"fixture"});
        assert!(valid_result(
            "agent:getAll",
            &json!({"defined":true,"value":[agent.clone()]})
        ));
        let mut private = agent.clone();
        private["config"]["api_keys"] = json!({"openai":"must-not-forward"});
        assert!(!public_agent(&private));
        private = agent.clone();
        private["config"]["mcp_servers"] =
            json!([{"serverId":"mcp-1","environment":{"private":"must-not-forward"}}]);
        assert!(!public_agent(&private));
        private = agent.clone();
        private["config"]["secret_ids"] = json!(["secret-1", "secret-1"]);
        assert!(!public_agent(&private));
        for invalid in [
            "http://user:password@localhost",
            "http://@localhost",
            "http:///localhost",
            "http://localhost\\private",
            "mailto:fixture@example.com",
            "http://localhost:99999",
            "http://[::1",
        ] {
            let mut malformed = agent.clone();
            malformed["server_url"] = json!(invalid);
            assert!(!public_agent(&malformed));
        }
        assert!(server_url(&json!("https://[::1]:4096/path")));
        assert!(server_url(&json!("HTTPS://example.com")));
    }
    #[test]
    fn activity_events_pair_epoch_and_sequence_and_forward_only_fixed_recovery_errors() {
        let base = json!({"sessionId":"session-1","agentId":"agent-1","taskId":"task-1","status":"working"});
        let mut frame = json!({"operation":"agent:status","payload":base});
        assert!(valid_event(&frame));
        frame["payload"]["epoch"] = json!("activity:fixture.1");
        assert!(!valid_event(&frame));
        frame["payload"]["seq"] = json!(1);
        frame["payload"]["heartbeat"] = json!(true);
        assert!(valid_event(&frame));
        frame["payload"]["seq"] = json!(0);
        assert!(!valid_event(&frame));
        frame["payload"]["seq"] = json!(1);
        frame["payload"]["heartbeat"] = json!(false);
        assert!(!valid_event(&frame));
        assert!(valid_event(
            &json!({"operation":"agent:startQueueChanged","payload":{"queue":[]}})
        ));
        assert!(!valid_event(
            &json!({"operation":"agent:startQueueChanged","payload":{"queue":[{"private":"must-not-forward"}]}})
        ));
        assert!(valid_event(
            &json!({"operation":"agent:recoveryStateChanged","payload":{"taskId":"task-1","cause":"fixture_restart","action":"resume","result":"failed","error":"The agent operation failed."}})
        ));
        assert!(!valid_event(
            &json!({"operation":"agent:recoveryStateChanged","payload":{"taskId":"task-1","cause":"fixture_restart","action":"resume","result":"failed","error":"private provider error"}})
        ));
    }

    #[test]
    #[cfg(feature = "production-service")]
    fn diagnostic_and_production_activity_metadata_have_the_same_finite_authority() {
        let valid = json!({"sessionId":"session-1","agentId":"agent-1","taskId":"task-1","status":"working","epoch":"owner:1","seq":1,"heartbeat":true,"disconnected":true});
        let check = |payload: &Value| {
            let frame = json!({"operation":"agent:status","payload":payload});
            let diagnostic = valid_event(&frame);
            assert_eq!(
                diagnostic,
                crate::production::contracts::valid_event("agent:status", payload)
            );
            diagnostic
        };
        assert!(check(&valid));
        for change in [
            json!({"heartbeat":null}),
            json!({"disconnected":false}),
            json!({"epoch":"bad epoch"}),
            json!({"seq":0}),
            json!({"seq":9007199254740992_u64}),
            json!({"activityOutcome":"failed","status":"error"}),
            json!({"providerDetails":"private"}),
        ] {
            let mut value = valid.clone();
            for (key, item) in change.as_object().unwrap() {
                value[key] = item.clone();
            }
            assert!(!check(&value));
        }
        let mut outcome = valid.clone();
        outcome.as_object_mut().unwrap().remove("heartbeat");
        outcome.as_object_mut().unwrap().remove("disconnected");
        outcome["status"] = json!("idle");
        outcome["activityOutcome"] = json!("completed");
        assert!(check(&outcome));
        outcome["status"] = json!("working");
        assert!(!check(&outcome));
    }
    #[test]
    fn string_bounds_match_utf16_and_ecmascript_trim() {
        assert!(nonblank(&json!("\u{0085}"), 512));
        assert!(!nonblank(&json!("\u{feff}\u{00a0}"), 512));
        assert!(text(&json!("🔑".repeat(256)), 512));
        assert!(!text(&json!("🔑".repeat(257)), 512));
    }
    #[test]
    fn actual_start_claim_queue_is_public_bounded_and_has_exact_recovery_metadata() {
        let row = json!({"id":"claim-1","taskId":"task-1","projectId":"project-1","agentId":"agent-1", "reason":"agent_limit","queuedAt":"fixture-time","position":1,"priority":"medium","state":"starting","retryCount":0,"nextRetryAt":null,"generation":1,"dependencyReason":null,"recoveryCause":null,"recoveryAction":null,"recoveryResult":null,"lastError":null});
        let event =
            |rows: Value| json!({"operation":"agent:startQueueChanged","payload":{"queue":rows}});
        assert!(valid_event(&event(json!([row.clone()]))));
        assert!(!valid_event(&event(json!([row.clone(), row.clone()]))));
        for (key, invalid) in [
            ("position", json!(0)),
            ("retryCount", json!(-1)),
            ("generation", json!(9007199254740992u64)),
            ("state", json!("private_state")),
            ("recoveryCause", json!("private diagnostic text")),
            ("lastError", json!("private backend detail")),
            ("nextRetryAt", json!("x".repeat(129))),
        ] {
            let mut malformed = row.clone();
            malformed[key] = invalid;
            assert!(!valid_event(&event(json!([malformed]))));
        }
        let mut private = row.clone();
        private["ownerToken"] = json!("must-not-forward");
        assert!(!valid_event(&event(json!([private]))));
        let mut recovery = row.clone();
        recovery["recoveryCause"] = json!("fixture_restart");
        recovery["recoveryAction"] = json!("resume");
        recovery["recoveryResult"] = json!("failed");
        recovery["lastError"] = json!(RECOVERY_ERROR);
        assert!(valid_event(&event(json!([recovery]))));
        assert!(valid_event(
            &json!({"operation":"agent:startQueueChanged","payload":{"queue":[],"failed":{"taskId":"task-1","error":RECOVERY_ERROR}}})
        ));
        assert!(!valid_event(
            &json!({"operation":"agent:startQueueChanged","payload":{"queue":[],"failed":{"taskId":"task-1","error":"private failure"}}})
        ));
        assert!(!valid_event(
            &json!({"operation":"agent:startQueueChanged","payload":{"queue":[],"failed":null}})
        ));
    }
}
