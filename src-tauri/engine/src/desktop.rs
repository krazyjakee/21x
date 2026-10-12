//! Explicit synthetic database wire policy. Keep aligned with database-desktop-codecs.ts.
use serde_json::Value;

const OPERATIONS: &[&str] = &[
    "db:getTasks",
    "db:getTask",
    "db:createTask",
    "db:updateTask",
    "db:deleteTask",
    "project:getAll",
    "project:get",
    "project:getDefault",
    "project:create",
    "settings:get",
    "settings:set",
    "settings:getAll",
    "agentSession:getTranscriptSnapshot",
    "agentSession:getTranscriptDelta",
    "agentSession:getTranscriptPage",
];
const TASK_STRINGS: &[&str] = &[
    "id",
    "title",
    "description",
    "type",
    "priority",
    "status",
    "assignee",
    "source",
    "project_id",
    "created_at",
    "updated_at",
];
const TASK_NULLABLE: &[&str] = &[
    "due_date",
    "agent_id",
    "external_id",
    "source_id",
    "session_id",
    "snoozed_until",
    "resolution",
    "feedback_comment",
    "recurrence_parent_id",
    "last_occurrence_at",
    "next_occurrence_at",
    "heartbeat_last_check_at",
    "heartbeat_next_check_at",
    "parent_task_id",
];
const TASK_BOOLEANS: &[&str] = &[
    "is_recurring",
    "heartbeat_enabled",
    "auto_start_agent",
    "auto_complete_without_review",
];
const TASK_OTHER: &[&str] = &[
    "labels",
    "attachments",
    "repos",
    "output_fields",
    "skill_ids",
    "feedback_rating",
    "recurrence_pattern",
    "heartbeat_interval_minutes",
    "complete_at_source",
    "next_subtask_ids",
    "sort_order",
];
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(super) fn object(value: &Value, required: &[&str], optional: &[&str]) -> bool {
    value.as_object().is_some_and(|map| {
        required.iter().all(|key| map.contains_key(*key))
            && map
                .keys()
                .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
    })
}
pub(super) fn text(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|s| !s.contains('\0') && s.encode_utf16().count() <= max)
}
pub(super) fn nonempty(value: &Value, max: usize) -> bool {
    text(value, max)
        && value.as_str().is_some_and(|s| {
            !s.trim_matches(|c: char| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
                .is_empty()
        })
}
pub(super) fn id(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 128
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
    })
}
pub(super) fn cursor(value: &Value) -> bool {
    value.as_u64().is_some_and(|n| n <= MAX_SAFE_INTEGER)
}
pub(super) fn member(value: &Value, choices: &[&str]) -> bool {
    value.as_str().is_some_and(|s| choices.contains(&s))
}
fn nullable_text(value: &Value) -> bool {
    value.is_null() || text(value, 65_536)
}
pub(super) fn array(value: &Value, check: fn(&Value) -> bool) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.len() <= 128 && items.iter().all(check))
}
fn strings(value: &Value) -> bool {
    array(value, |item| text(item, 256))
}
fn json(value: &Value, depth: usize) -> bool {
    depth <= 64
        && match value {
            Value::Array(items) => items.iter().all(|item| json(item, depth + 1)),
            Value::Object(map) => map.values().all(|item| json(item, depth + 1)),
            _ => true,
        }
}
fn setting(value: &Value) -> bool {
    member(value, &["theme", "sidebar_collapsed", "synthetic_ui_value"])
}
fn task_input(value: &Value, create: bool) -> bool {
    let allowed = if create {
        &[
            "title",
            "description",
            "type",
            "priority",
            "labels",
            "project_id",
            "status",
            "auto_start_agent",
            "auto_complete_without_review",
        ][..]
    } else {
        &["title", "description", "type", "priority", "labels"][..]
    };
    object(value, if create { &["title"] } else { &[] }, allowed)
        && value
            .as_object()
            .unwrap()
            .iter()
            .all(|(key, item)| match key.as_str() {
                "title" => nonempty(item, 512),
                "description" => text(item, 65_536),
                "type" => member(item, &["general", "coding", "manual", "review", "approval"]),
                "priority" => member(item, &["critical", "high", "medium", "low"]),
                "labels" => strings(item),
                "project_id" => id(item),
                "status" => item == "not_started",
                _ => item == false,
            })
}
fn project_input(value: &Value) -> bool {
    object(value, &["name"], &["description"])
        && nonempty(&value["name"], 512)
        && value
            .get("description")
            .is_none_or(|item| text(item, 65_536))
}
pub(super) fn known_operation(operation: &str) -> bool {
    if OPERATIONS.contains(&operation) || super::configuration_desktop::known_operation(operation) {
        return true;
    }
    #[cfg(feature = "synthetic-agent")]
    {
        return super::agent_desktop::known_operation(operation);
    }
    #[cfg(not(feature = "synthetic-agent"))]
    false
}
pub(super) fn valid_request(operation: &str, value: &Value) -> bool {
    if !json(value, 0) {
        return false;
    }
    if super::configuration_desktop::known_operation(operation) {
        return super::configuration_desktop::valid_request(operation, value);
    }
    #[cfg(feature = "synthetic-agent")]
    if super::agent_desktop::known_operation(operation) {
        return super::agent_desktop::valid_request(operation, value);
    }
    match operation {
        "db:getTasks" => {
            object(value, &[], &["projectId"]) && value.get("projectId").is_none_or(id)
        }
        "db:getTask" | "db:deleteTask" | "project:get" => {
            object(value, &["id"], &[]) && id(&value["id"])
        }
        "db:createTask" => object(value, &["data"], &[]) && task_input(&value["data"], true),
        "db:updateTask" => {
            object(value, &["id", "data"], &[])
                && id(&value["id"])
                && task_input(&value["data"], false)
        }
        "project:getAll" => {
            object(value, &[], &["includeArchived"])
                && value.get("includeArchived").is_none_or(Value::is_boolean)
        }
        "project:getDefault" | "settings:getAll" => object(value, &[], &[]),
        "project:create" => object(value, &["data"], &[]) && project_input(&value["data"]),
        "settings:get" => object(value, &["key"], &[]) && setting(&value["key"]),
        "settings:set" => {
            object(value, &["key", "value"], &[])
                && setting(&value["key"])
                && text(&value["value"], 4096)
        }
        "agentSession:getTranscriptSnapshot" => {
            object(value, &["taskId"], &["sinceSeq"])
                && id(&value["taskId"])
                && value.get("sinceSeq").is_none_or(cursor)
        }
        "agentSession:getTranscriptDelta" => {
            object(value, &["taskId", "sinceRev"], &[])
                && id(&value["taskId"])
                && cursor(&value["sinceRev"])
        }
        "agentSession:getTranscriptPage" => {
            object(value, &["taskId", "page"], &[])
                && id(&value["taskId"])
                && page_request(&value["page"])
        }
        _ => false,
    }
}
fn attachment(value: &Value) -> bool {
    object(
        value,
        &["id", "filename", "size", "mime_type", "added_at"],
        &[],
    ) && id(&value["id"])
        && text(&value["filename"], 256)
        && cursor(&value["size"])
        && text(&value["mime_type"], 128)
        && text(&value["added_at"], 128)
}
fn task(value: &Value) -> bool {
    let required: Vec<&str> = [TASK_STRINGS, TASK_NULLABLE, TASK_BOOLEANS, TASK_OTHER].concat();
    object(value, &required, &["last_activity_at"])
        && TASK_STRINGS.iter().all(|key| text(&value[*key], 65_536))
        && id(&value["id"])
        && id(&value["project_id"])
        && member(
            &value["type"],
            &["general", "coding", "manual", "review", "approval"],
        )
        && member(&value["priority"], &["critical", "high", "medium", "low"])
        && member(
            &value["status"],
            &[
                "not_started",
                "triaging",
                "agent_working",
                "ready_for_review",
                "agent_learning",
                "completed",
            ],
        )
        && TASK_NULLABLE.iter().all(|key| nullable_text(&value[*key]))
        && TASK_BOOLEANS.iter().all(|key| value[*key].is_boolean())
        && ["labels", "repos", "next_subtask_ids"]
            .iter()
            .all(|key| strings(&value[*key]))
        && (value["skill_ids"].is_null() || strings(&value["skill_ids"]))
        && array(&value["attachments"], attachment)
        && array(&value["output_fields"], |item| json(item, 0))
        && (value["feedback_rating"].is_null() || value["feedback_rating"].is_number())
        && (value["recurrence_pattern"].is_null()
            || text(&value["recurrence_pattern"], 65_536)
            || value["recurrence_pattern"].is_object())
        && (value["heartbeat_interval_minutes"].is_null()
            || cursor(&value["heartbeat_interval_minutes"]))
        && (value["complete_at_source"].is_null() || value["complete_at_source"].is_boolean())
        && cursor(&value["sort_order"])
        && value.get("last_activity_at").is_none_or(nullable_text)
        && json(value, 0)
}
pub(super) fn project(value: &Value) -> bool {
    object(
        value,
        &[
            "id",
            "name",
            "description",
            "default_agent_id",
            "captain_agent_id",
            "git_provider",
            "git_org",
            "settings",
            "sort_order",
            "archived",
            "created_at",
            "updated_at",
        ],
        &[],
    ) && id(&value["id"])
        && ["name", "description", "created_at", "updated_at"]
            .iter()
            .all(|key| text(&value[*key], 65_536))
        && [
            "default_agent_id",
            "captain_agent_id",
            "git_provider",
            "git_org",
        ]
        .iter()
        .all(|key| nullable_text(&value[*key]))
        && value["settings"].is_object()
        && cursor(&value["sort_order"])
        && value["archived"].is_boolean()
        && json(value, 0)
}
fn part(value: &Value) -> bool {
    object(
        value,
        &[
            "taskId",
            "partId",
            "seq",
            "role",
            "content",
            "createdAt",
            "updatedAt",
            "rev",
        ],
        &["partType", "tool", "payload"],
    ) && id(&value["taskId"])
        && text(&value["partId"], 512)
        && value["partId"].as_str().is_some_and(|s| !s.is_empty())
        && ["seq", "rev", "createdAt", "updatedAt"]
            .iter()
            .all(|key| cursor(&value[*key]))
        && text(&value["role"], 128)
        && text(&value["content"], 65_536)
        && value.get("partType").is_none_or(|v| text(v, 128))
        && json(value, 0)
}
fn delta(value: &Value) -> bool {
    object(value, &["parts", "maxRev"], &[])
        && array(&value["parts"], part)
        && cursor(&value["maxRev"])
        && value["parts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|part| part["rev"].as_u64().unwrap() <= value["maxRev"].as_u64().unwrap())
}
fn page_request(value: &Value) -> bool {
    object(
        value,
        &["version", "mode", "after"],
        &["watermark", "limit"],
    ) && value["version"] == 1
        && member(&value["mode"], &["snapshot", "delta"])
        && cursor(&value["after"])
        && value.get("watermark").is_none_or(cursor)
        && value
            .get("limit")
            .is_none_or(|v| v.as_u64().is_some_and(|n| (1..=64).contains(&n)))
        && (value["mode"] != "delta"
            || value
                .get("watermark")
                .is_none_or(|v| value["after"].as_u64() <= v.as_u64()))
}
fn page_result(value: &Value) -> bool {
    if !object(
        value,
        &[
            "version",
            "taskId",
            "mode",
            "after",
            "parts",
            "cursor",
            "watermark",
            "hasMore",
        ],
        &[],
    ) || value["version"] != 1
        || !id(&value["taskId"])
        || !member(&value["mode"], &["snapshot", "delta"])
        || !["after", "cursor", "watermark"]
            .iter()
            .all(|key| cursor(&value[*key]))
        || !value["hasMore"].is_boolean()
        || !value["parts"]
            .as_array()
            .is_some_and(|items| items.len() <= 64 && items.iter().all(part))
    {
        return false;
    }
    let key = if value["mode"] == "snapshot" {
        "seq"
    } else {
        "rev"
    };
    let mut previous = value["after"].as_u64().unwrap();
    let watermark = value["watermark"].as_u64().unwrap();
    let mut ids = std::collections::HashSet::new();
    for part in value["parts"].as_array().unwrap() {
        let next = part[key].as_u64().unwrap();
        if part["taskId"] != value["taskId"]
            || next <= previous
            || part["rev"].as_u64().unwrap() > watermark
            || !ids.insert(part["partId"].as_str().unwrap())
        {
            return false;
        }
        previous = next;
    }
    let has_more = value["hasMore"] == true;
    let expected = if value["mode"] == "delta" && !has_more {
        watermark
    } else {
        previous
    };
    (!has_more || !value["parts"].as_array().unwrap().is_empty())
        && value["cursor"].as_u64() == Some(expected)
        && expected >= value["after"].as_u64().unwrap()
        && (value["mode"] != "delta" || expected <= watermark)
        && serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= 256 * 1024)
}

pub(super) fn valid_page_for_request(request: &Value, result: &Value) -> bool {
    let page = &result["value"];
    result["defined"] == true
        && page_result(page)
        && page["taskId"] == request["taskId"]
        && page["mode"] == request["page"]["mode"]
        && page["after"] == request["page"]["after"]
        && request["page"]
            .get("watermark")
            .is_none_or(|value| value == &page["watermark"])
        && page["parts"].as_array().unwrap().len() as u64
            <= request["page"]["limit"].as_u64().unwrap_or(64)
}
pub(super) fn valid_result(operation: &str, value: &Value) -> bool {
    if super::configuration_desktop::known_operation(operation) {
        return json(value, 0) && super::configuration_desktop::valid_result(operation, value);
    }
    #[cfg(feature = "synthetic-agent")]
    if super::agent_desktop::known_operation(operation) {
        return super::agent_desktop::valid_result(operation, value);
    }
    if !known_operation(operation) || !object(value, &["defined"], &["value"]) || !json(value, 0) {
        return false;
    }
    if value["defined"] == false {
        return value.get("value").is_none()
            && matches!(
                operation,
                "db:getTask"
                    | "db:updateTask"
                    | "project:get"
                    | "project:getDefault"
                    | "project:create"
                    | "settings:set"
            );
    }
    if value["defined"] != true || value.get("value").is_none() {
        return false;
    }
    let result = &value["value"];
    match operation {
        "db:getTasks" => array(result, task),
        "db:getTask" | "db:createTask" | "db:updateTask" => task(result),
        "db:deleteTask" => result.is_boolean(),
        "project:getAll" => array(result, project),
        "project:get" | "project:getDefault" | "project:create" => project(result),
        "settings:get" => result.is_null() || text(result, 4096),
        "settings:getAll" => result.as_object().is_some_and(|map| {
            map.iter()
                .all(|(key, value)| setting(&Value::String(key.clone())) && text(value, 4096))
        }),
        "agentSession:getTranscriptSnapshot" => array(result, part),
        "agentSession:getTranscriptDelta" => delta(result),
        "agentSession:getTranscriptPage" => page_result(result),
        _ => false,
    }
}
// Fixed native test ingress; deliberately absent from known_operation/request.
pub(super) fn valid_internal_result(operation: &str, value: &Value) -> bool {
    operation == "fixture.transcriptUpsert"
        && object(value, &["maxRev", "changedPartIds"], &[])
        && cursor(&value["maxRev"])
        && value["changedPartIds"].as_array().is_some_and(|ids| {
            ids.len() <= 32
                && ids.iter().all(|value| {
                    text(value, 512) && value.as_str().is_some_and(|id| !id.is_empty())
                })
        })
}

pub(super) fn valid_event_envelope(frame: &Value) -> bool {
    object(
        frame,
        &[
            "kind",
            "protocolVersion",
            "engineEpoch",
            "operation",
            "payload",
            "sequence",
        ],
        &[],
    ) && frame["kind"] == "event"
        && frame["protocolVersion"] == 1
        && id(&frame["engineEpoch"])
        && cursor(&frame["sequence"])
        && frame["operation"].as_str().is_some_and(|name| {
            name.len() <= 128
                && name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                && name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b':' | b'-'))
        })
        && json(&frame["payload"], 0)
}
pub(super) fn valid_event(frame: &Value) -> bool {
    let payload = &frame["payload"];
    match frame["operation"].as_str() {
        Some("task:created") => object(payload, &["task"], &[]) && task(&payload["task"]),
        Some("task:updated") => {
            object(payload, &["taskId", "updates"], &[])
                && id(&payload["taskId"])
                && task(&payload["updates"])
                && payload["taskId"] == payload["updates"]["id"]
        }
        Some("task:deleted") => object(payload, &["taskId"], &[]) && id(&payload["taskId"]),
        Some("project:changed") => {
            object(payload, &["projectId", "kind"], &[])
                && id(&payload["projectId"])
                && member(
                    &payload["kind"],
                    &[
                        "created",
                        "updated",
                        "archived",
                        "restored",
                        "repos",
                        "resources",
                    ],
                )
        }
        Some("transcript:changed") => {
            object(payload, &["taskId", "parts", "maxRev"], &["reloadRequired"])
                && id(&payload["taskId"])
                && array(&payload["parts"], part)
                && payload["parts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|part| part["taskId"] == payload["taskId"])
                && cursor(&payload["maxRev"])
                && payload["parts"].as_array().unwrap().iter().all(|part| {
                    part["rev"].as_u64().unwrap() <= payload["maxRev"].as_u64().unwrap()
                })
                && payload.get("reloadRequired").is_none_or(|value| {
                    value == true && payload["parts"].as_array().is_some_and(Vec::is_empty)
                })
        }
        _ => {
            if super::configuration_desktop::valid_event(frame) {
                return true;
            }
            #[cfg(feature = "synthetic-agent")]
            {
                return super::agent_desktop::valid_event(frame);
            }
            #[cfg(not(feature = "synthetic-agent"))]
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn transcript_pages_bound_requests_and_preserve_distinct_sequence_and_revision_cursors() {
        let request =
            json!({"taskId":"task-1","page":{"version":1,"mode":"snapshot","after":0,"limit":64}});
        assert!(valid_request("agentSession:getTranscriptPage", &request));
        for bad in [
            json!({"version":2,"mode":"snapshot","after":0}),
            json!({"version":1,"mode":"snapshot","after":0,"limit":65}),
            json!({"version":1,"mode":"snapshot","after":0,"watermark":null}),
            json!({"version":1,"mode":"delta","after":2,"watermark":1}),
            json!({"version":1,"mode":"snapshot","after":0,"workspace":"private"}),
        ] {
            assert!(!valid_request(
                "agentSession:getTranscriptPage",
                &json!({"taskId":"task-1","page":bad})
            ));
        }
        let part = json!({"taskId":"task-1","partId":"part-1","seq":20,"role":"assistant","content":"preview","createdAt":1,"updatedAt":1,"rev":1});
        let value = json!({"version":1,"taskId":"task-1","mode":"snapshot","after":0,"parts":[part],"cursor":20,"watermark":1,"hasMore":false});
        assert!(valid_result(
            "agentSession:getTranscriptPage",
            &json!({"defined":true,"value":value})
        ));
        let response = json!({"defined":true,"value":value});
        assert!(valid_page_for_request(&request, &response));
        let mut other = request.clone();
        other["taskId"] = json!("foreign");
        assert!(!valid_page_for_request(&other, &response));
        other = request.clone();
        other["page"]["watermark"] = json!(0);
        assert!(!valid_page_for_request(&other, &response));
        let mut malformed = value.clone();
        malformed["parts"][0]["taskId"] = json!("foreign");
        assert!(!page_result(&malformed));
        malformed = value.clone();
        malformed["cursor"] = json!(0);
        assert!(!page_result(&malformed));
        malformed = value.clone();
        malformed["parts"] = json!([]);
        malformed["hasMore"] = json!(true);
        assert!(!page_result(&malformed));
        let delta = json!({"version":1,"taskId":"task-1","mode":"delta","after":1,"parts":[],"cursor":3,"watermark":3,"hasMore":false});
        assert!(page_result(&delta));
        let mut regression = delta;
        regression["cursor"] = json!(1);
        assert!(!page_result(&regression));
    }

    #[test]
    fn transcript_page_byte_budget_is_tighter_than_the_pipe_frame_limit() {
        let parts: Vec<Value> = (1..=16)
            .map(|n| {
                json!({"taskId":"task-1","partId":format!("part-{n}"),"seq":n,"role":"assistant",
            "content":"🚀".repeat(8192),"createdAt":1,"updatedAt":1,"rev":n})
            })
            .collect();
        let value = json!({"version":1,"taskId":"task-1","mode":"snapshot","after":0,"parts":parts,"cursor":16,"watermark":16,"hasMore":false});
        assert!(!page_result(&value));
    }
    #[cfg(feature = "synthetic-agent")]
    #[test]
    fn agent_fixture_delegation_keeps_database_authority_bounds() {
        assert!(known_operation("agent:getAll"));
        assert!(valid_request("agent:getAll", &json!({})));
        assert!(valid_request(
            "agentSession:stop",
            &json!({"sessionId":"session-1"})
        ));
        assert!(!valid_request(
            "agentSession:approve",
            &json!({"sessionId":"session-1","approved":true})
        ));
        assert!(!valid_request(
            "db:updateTask",
            &json!({"id":"task-1","data":{"status":"completed"}})
        ));
        assert!(valid_event(
            &json!({"operation":"agent:status","payload":{"sessionId":"session-1","agentId":"agent-1","taskId":"task-1","status":"working","epoch":"fixture:1","seq":1,"heartbeat":true}})
        ));
        assert!(!valid_event(
            &json!({"operation":"agent:status","payload":{"sessionId":"session-1","agentId":"agent-1","taskId":"task-1","status":"working","api_keys":{}}})
        ));
        assert!(!valid_event(
            &json!({"operation":"agent:unknownCriticalEvent","payload":{}})
        ));
    }
    #[test]
    fn synthetic_inputs_cannot_start_agents_or_change_lifecycle() {
        assert!(valid_request(
            "db:createTask",
            &json!({"data":{"title":"synthetic task", "auto_start_agent":false}})
        ));
        for payload in [
            json!({"data":{"title":"synthetic", "auto_start_agent":true}}),
            json!({"data":{"title":"synthetic", "agent_id":"private-agent"}}),
            json!({"data":{"title":"synthetic", "status":"agent_working"}}),
        ] {
            assert!(!valid_request("db:createTask", &payload));
        }
        assert!(!valid_request(
            "db:updateTask",
            &json!({"id":"task-1", "data":{"status":"completed"}})
        ));
        #[cfg(not(feature = "synthetic-agent"))]
        assert!(!known_operation("agentSession:approve"));
        assert!(!known_operation("fixture.transcriptUpsert"));
        assert!(!valid_request(
            "settings:set",
            &json!({"key":"secret", "value":"private"})
        ));
    }
    #[test]
    fn task_events_cannot_forward_private_columns_or_change_target_id() {
        let mut record = serde_json::Map::new();
        for key in TASK_STRINGS {
            record.insert((*key).into(), json!(""));
        }
        for key in TASK_NULLABLE {
            record.insert((*key).into(), Value::Null);
        }
        for key in TASK_BOOLEANS {
            record.insert((*key).into(), json!(false));
        }
        for key in TASK_OTHER {
            record.insert(
                (*key).into(),
                match *key {
                    "labels" | "attachments" | "repos" | "output_fields" | "next_subtask_ids" => {
                        json!([])
                    }
                    "sort_order" => json!(0),
                    _ => Value::Null,
                },
            );
        }
        let mut public = Value::Object(record);
        for (key, value) in [
            ("id", "task-1"),
            ("project_id", "default"),
            ("type", "general"),
            ("priority", "medium"),
            ("status", "not_started"),
        ] {
            public[key] = json!(value);
        }
        assert!(task(&public));
        let mut event =
            json!({"operation":"task:updated","payload":{"taskId":"task-2","updates":public}});
        assert!(!valid_event(&event));
        event["payload"]["taskId"] = json!("task-1");
        assert!(valid_event(&event));
        event["payload"]["updates"]["mcp_scope_nonce"] = json!("must-not-forward");
        assert!(!valid_event(&event));
    }

    #[test]
    fn internal_projection_result_does_not_expose_renderer_ingress() {
        assert!(!known_operation("fixture.transcriptUpsert"));
        assert!(valid_internal_result(
            "fixture.transcriptUpsert",
            &json!({"maxRev":1,"changedPartIds":["part-1"]})
        ));
        assert!(!valid_internal_result(
            "fixture.transcriptUpsert",
            &json!({"maxRev":1,"changedPartIds":["part-1"],"private":"must-not-forward"})
        ));
        assert!(!valid_internal_result(
            "fixture.transcriptUpsert",
            &json!({"maxRev":1,"changedPartIds":vec!["part";33]})
        ));
    }

    #[test]
    fn transcript_revisions_are_bounded_by_delta_or_event_cursor() {
        let part = json!({"taskId":"task-1","partId":"part-1","seq":1,"role":"assistant",
            "content":"fixture","createdAt":1,"updatedAt":1,"rev":2});
        let mut event = json!({"operation":"transcript:changed","payload":{"taskId":"task-1","parts":[part],"maxRev":1}});
        assert!(!valid_event(&event));
        assert!(!delta(&json!({"parts":[part],"maxRev":1})));
        event["payload"]["maxRev"] = json!(2);
        assert!(valid_event(&event));
        assert!(nonempty(&json!("\u{0085}"), 512));
        assert!(!nonempty(&json!("\u{feff}\u{00a0}"), 512));
    }

    #[test]
    fn optional_result_preserves_missing_and_rejects_extra_keys() {
        assert!(valid_result("db:getTask", &json!({"defined":false})));
        assert!(!valid_result(
            "db:getTask",
            &json!({"defined":false,"value":null})
        ));
        assert!(valid_result(
            "settings:get",
            &json!({"defined":true,"value":null})
        ));
        assert!(!valid_result(
            "settings:set",
            &json!({"defined":true,"value":null})
        ));
        assert!(!valid_result(
            "settings:get",
            &json!({"defined":true,"value":"safe","private":true})
        ));
    }
    #[test]
    fn events_reject_foreign_fields_and_unsafe_sequence_values() {
        let mut event = json!({"kind":"event","protocolVersion":1,"engineEpoch":"epoch-1","operation":"task:deleted","sequence":1,"payload":{"taskId":"task-1"}});
        assert!(valid_event_envelope(&event) && valid_event(&event));
        event["payload"]["private_scope"] = json!("must-not-forward");
        assert!(!valid_event(&event));
        event["sequence"] = json!(MAX_SAFE_INTEGER + 1);
        assert!(!valid_event_envelope(&event));
    }
}
