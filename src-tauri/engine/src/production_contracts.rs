//! Finite production ingress/egress policy, independent of diagnostic grants.
//! Native bounds/outer DTO checks complement the service's exact domain codecs.
use serde_json::Value;

pub const COMMANDS: &[&str] = &[
    "db:getTasks",
    "db:getTask",
    "db:createTask",
    "db:updateTask",
    "db:deleteTask",
    "db:getSubtasks",
    "db:reorderSubtasks",
    "project:moveTask",
    "tasks:getCoordinatorTaskId",
    "plugin:executeAction",
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
    "skills:getAll",
    "skills:create",
    "skills:update",
    "skills:delete",
    "skills:setProject",
    "project:update",
    "project:archive",
    "project:reorder",
    "projectRepo:list",
    "projectRepo:add",
    "projectRepo:update",
    "projectRepo:remove",
    "projectRepo:reorder",
    "projectResource:list",
    "projectResource:add",
    "projectResource:update",
    "projectResource:remove",
    "projectResource:reorder",
    "agent:getAll",
    "agent:create",
    "agent:update",
    "agent:delete",
    "agentConfig:getProviders",
    "agentConfig:listModels",
    "agentSession:start",
    "agentSession:startTask",
    "agentSession:resume",
    "agentSession:send",
    "agentSession:sendByTaskId",
    "agentSession:abort",
    "agentSession:stop",
    "agentSession:stopByTaskId",
    "agentSession:switchAgent",
    "agentSession:approve",
    "agent:getStartQueue",
    "agent:getStartRecoveryState",
    "agentSession:getRawTranscript",
    "captainRuntime:get",
    "captainRuntime:switch",
    "captainRuntime:retry",
    "captainRuntime:rollback",
    "commander:listSessions",
    "commander:createSession",
    "commander:renameSession",
    "commander:archiveSession",
    "commander:listMessages",
    "commander:markRead",
    "commander:setActiveSession",
    "commander:send",
    "commander:getImage",
    "commander:cancel",
    "commander:undoAction",
    "commander:getActivity",
    "chat:start",
    "chat:cancel",
    "secrets:getAll",
    "secrets:create",
    "secrets:update",
    "secrets:delete",
    "env:get",
    "terminal:create",
    "terminal:write",
    "terminal:resize",
    "terminal:kill",
    "terminal:getCwd",
    "terminal:getBuffer",
];
pub const EVENTS: &[&str] = &[
    "task:created",
    "task:updated",
    "task:deleted",
    "task:subtasks-reordered",
    "tasks:refresh",
    "project:changed",
    "skills:changed",
    "transcript:changed",
    "agent:status",
    "agent:startQueueChanged",
    "project:statusChanged",
    "concurrency:changed",
    "agent:recoveryStateChanged",
    "commander:event",
    "chat:event",
    "terminal:data",
    "terminal:exit",
];
pub(crate) fn object(value: &Value, required: &[&str], optional: &[&str]) -> bool {
    value.as_object().is_some_and(|map| {
        required.iter().all(|key| map.contains_key(*key))
            && map
                .keys()
                .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
    })
}
pub(crate) fn text(value: &Value, limit: usize) -> bool {
    value
        .as_str()
        .is_some_and(|s| !s.contains('\0') && s.encode_utf16().count() <= limit)
}
pub(crate) fn id(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 128
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
    })
}
pub(crate) fn integer(value: &Value) -> bool {
    value.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991)
}
fn ids(value: &Value) -> bool {
    value.as_array().is_some_and(|items| {
        items.len() <= 128
            && items.iter().all(id)
            && items
                .iter()
                .filter_map(Value::as_str)
                .collect::<std::collections::HashSet<_>>()
                .len()
                == items.len()
    })
}
fn bounded(value: &Value, depth: usize, nodes: &mut usize, maximum: usize) -> bool {
    *nodes += 1;
    // Generic task output JSON uses the shared depth-64 codec, unlike the
    // narrower Commander/agent domains. The final byte cap bounds materialized
    // values; do not impose smaller map/array limits on valid task output data.
    if depth > 64 || *nodes > 600_000 {
        return false;
    }
    match value {
        Value::String(s) => s.len() <= maximum,
        Value::Array(items) => items
            .iter()
            .all(|item| bounded(item, depth + 1, nodes, maximum)),
        Value::Object(map) => map
            .iter()
            .all(|(key, item)| key.len() <= maximum && bounded(item, depth + 1, nodes, maximum)),
        _ => true,
    }
}
fn bounded_bytes(value: &Value, maximum: usize) -> bool {
    bounded(value, 0, &mut 0, maximum)
        && serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= maximum)
}
pub fn valid_bounded(value: &Value) -> bool {
    bounded_bytes(value, 900_000)
}
fn fields(operation: &str) -> Option<(&'static [&'static str], &'static [&'static str])> {
    Some(match operation {
        "db:getTasks" | "tasks:getCoordinatorTaskId" => (&[], &["projectId"]),
        "db:getTask"
        | "db:deleteTask"
        | "project:get"
        | "skills:delete"
        | "agent:delete"
        | "projectRepo:remove"
        | "projectResource:remove"
        | "commander:getImage" => (&["id"], &[]),
        "db:createTask" | "project:create" | "skills:create" | "agent:create" => (&["data"], &[]),
        "db:updateTask"
        | "project:update"
        | "skills:update"
        | "agent:update"
        | "projectRepo:update"
        | "projectResource:update" => (&["id", "data"], &[]),
        "db:getSubtasks" => (&["parentId"], &[]),
        "db:reorderSubtasks" => (&["parentId", "orderedIds"], &[]),
        "project:moveTask" => (&["taskId", "projectId"], &[]),
        "plugin:executeAction" => (&["actionId", "taskId", "sourceId"], &["input"]),
        "project:getAll" => (&[], &["includeArchived"]),
        "project:getDefault"
        | "settings:getAll"
        | "skills:getAll"
        | "agent:getAll"
        | "agent:getStartQueue" => (&[], &[]),
        "settings:get" => (&["key"], &[]),
        "settings:set" => (&["key", "value"], &[]),
        "agentSession:getTranscriptSnapshot" => (&["taskId"], &["sinceSeq"]),
        "agentSession:getTranscriptDelta" => (&["taskId", "sinceRev"], &[]),
        "agentSession:getTranscriptPage" => (&["taskId", "page"], &[]),
        "skills:setProject" => (&["id", "projectId"], &[]),
        "project:archive" => (&["id"], &["archived"]),
        "project:reorder" => (&["orderedIds"], &[]),
        "projectRepo:list"
        | "projectResource:list"
        | "captainRuntime:get"
        | "captainRuntime:retry"
        | "captainRuntime:rollback" => (&["projectId"], &[]),
        "projectRepo:add" | "projectResource:add" => (&["projectId", "data"], &[]),
        "projectRepo:reorder" | "projectResource:reorder" => (&["projectId", "orderedIds"], &[]),
        "agentConfig:getProviders" => (&[], &["serverUrl", "backendType"]),
        "agentConfig:listModels" => (&["backendType"], &[]),
        "agentSession:start" => (&["agentId", "taskId"], &["skipInitialPrompt"]),
        "agentSession:startTask"
        | "agent:getStartRecoveryState"
        | "agentSession:getRawTranscript"
        | "agentSession:stopByTaskId" => (&["taskId"], &[]),
        "agentSession:resume" => (&["agentId", "taskId", "sessionId"], &[]),
        "agentSession:send" => (
            &["sessionId", "message"],
            &["taskId", "agentId", "attachments", "deliveryId"],
        ),
        "agentSession:sendByTaskId" => (&["taskId", "message"], &["attachments", "deliveryId"]),
        "agentSession:abort"
        | "agentSession:stop"
        | "commander:listMessages"
        | "commander:markRead"
        | "commander:setActiveSession"
        | "commander:cancel"
        | "commander:getActivity" => (&["sessionId"], &[]),
        "agentSession:switchAgent" => (&["taskId", "newAgentId"], &[]),
        "agentSession:approve" => (
            &["sessionId", "approved", "requestId"],
            &["message", "responseType"],
        ),
        "captainRuntime:switch" => (&["projectId", "agentId"], &[]),
        "commander:listSessions" => (&[], &["search", "includeArchived"]),
        "commander:createSession" => (&[], &["title"]),
        "commander:renameSession" => (&["id", "title"], &[]),
        "commander:archiveSession" => (&["id", "archived"], &[]),
        "commander:send" => (&["sessionId", "text"], &["images"]),
        "commander:undoAction" => (&["sessionId", "actionId"], &[]),
        "chat:start" => (&["messages"], &["system", "maxToolCalls"]),
        "chat:cancel" => (&["turnId"], &[]),
        "secrets:getAll" => (&[], &[]),
        "secrets:create" => (&["data"], &[]),
        "secrets:update" => (&["id", "data"], &[]),
        "secrets:delete" => (&["id"], &[]),
        "env:get" => (&["key"], &[]),
        "terminal:create" => (&["id", "cols", "rows"], &["cwd"]),
        "terminal:write" => (&["id", "data"], &[]),
        "terminal:resize" => (&["id", "cols", "rows"], &[]),
        "terminal:kill" | "terminal:getCwd" => (&["id"], &["expectedPid"]),
        "terminal:getBuffer" => (&["id"], &["lines"]),
        _ => return None,
    })
}
fn data_fields(operation: &str, value: &Value) -> bool {
    let allowed: &[&str] = match operation {
        "db:createTask" => &[
            "title",
            "description",
            "type",
            "priority",
            "status",
            "assignee",
            "due_date",
            "labels",
            "attachments",
            "repos",
            "output_fields",
            "is_recurring",
            "recurrence_pattern",
            "auto_start_agent",
            "auto_complete_without_review",
            "complete_at_source",
            "parent_task_id",
            "next_subtask_ids",
            "recurrence_parent_id",
            "project_id",
        ],
        "db:updateTask" => &[
            "title",
            "description",
            "type",
            "priority",
            "status",
            "assignee",
            "due_date",
            "labels",
            "attachments",
            "repos",
            "output_fields",
            "is_recurring",
            "recurrence_pattern",
            "auto_start_agent",
            "auto_complete_without_review",
            "complete_at_source",
            "parent_task_id",
            "next_subtask_ids",
            "agent_id",
            "skill_ids",
            "snoozed_until",
            "resolution",
            "feedback_rating",
            "feedback_comment",
            "last_occurrence_at",
            "next_occurrence_at",
            "heartbeat_enabled",
            "heartbeat_interval_minutes",
            "heartbeat_last_check_at",
            "heartbeat_next_check_at",
            "sort_order",
        ],
        "agent:create" | "agent:update" => &["name", "server_url", "config", "is_default"],
        "skills:create" => &[
            "name",
            "description",
            "content",
            "confidence",
            "uses",
            "last_used",
            "tags",
            "preferred_model",
            "project_id",
        ],
        "skills:update" => &[
            "name",
            "description",
            "content",
            "confidence",
            "uses",
            "last_used",
            "tags",
            "preferred_model",
            "expected_version",
        ],
        "project:create" => &["name", "description"],
        "project:update" => &["name", "description", "git_provider", "git_org"],
        "projectRepo:add" | "projectRepo:update" => &["name", "provider", "org", "default_branch"],
        "projectResource:add" | "projectResource:update" => &["label", "url", "notes"],
        "secrets:create" | "secrets:update" => &["name", "description", "env_var_name", "value"],
        _ => return false,
    };
    object(value, &[], allowed)
        && value.get("config").is_none_or(|config| {
            object(
                config,
                &[],
                &[
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
                ],
            )
        })
}
fn image(value: &Value) -> bool {
    if !object(
        value,
        &["name", "mimeType", "encoding", "byteLength", "data"],
        &[],
    ) || !text(&value["name"], 256)
        || value["encoding"] != "base64"
        || !matches!(
            value["mimeType"].as_str(),
            Some("image/png" | "image/jpeg" | "image/webp" | "image/gif")
        )
    {
        return false;
    }
    let Some(length) = value["byteLength"].as_u64() else {
        return false;
    };
    let Some(data) = value["data"].as_str() else {
        return false;
    };
    if length == 0 || length > 192 * 1024 || data.len() != (length as usize).div_ceil(3) * 4 {
        return false;
    }
    let padding = (3 - (length as usize) % 3) % 3;
    let bytes = data.as_bytes();
    bytes[..bytes.len() - padding]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || matches!(*b, b'+' | b'/'))
        && bytes[bytes.len() - padding..].iter().all(|b| *b == b'=')
}
pub fn images(value: &Value) -> bool {
    object(value, &["version", "images"], &[])
        && value["version"] == 1
        && value["images"].as_array().is_some_and(|items| {
            items.len() <= 5
                && items.iter().all(image)
                && items
                    .iter()
                    .filter_map(|i| i["byteLength"].as_u64())
                    .sum::<u64>()
                    <= 384 * 1024
        })
}
pub fn valid_request(operation: &str, value: &Value) -> bool {
    let Some((required, optional)) = fields(operation) else {
        return false;
    };
    // Some exact configuration-input codecs have only the protocol frame cap.
    // The writer includes envelope overhead before any request reaches Node.
    if !object(value, required, optional) || !bounded_bytes(value, 1024 * 1024) {
        return false;
    }
    if operation.starts_with("terminal:") {
        return terminal_request(operation, value);
    }
    value
        .as_object()
        .unwrap()
        .iter()
        .all(|(key, item)| match key.as_str() {
            "sessionId" if operation == "commander:setActiveSession" => item.is_null() || id(item),
            "sessionId" if operation == "agentSession:send" => item == "" || id(item),
            "projectId" if operation == "skills:setProject" => item.is_null() || id(item),
            "id" | "sessionId" | "projectId" | "parentId" | "agentId" | "newAgentId" | "taskId"
            | "sourceId" => id(item),
            "requestId" | "deliveryId" | "actionId" | "turnId" => {
                text(item, 512) && item.as_str().is_some_and(|s| !s.trim().is_empty())
            }
            "approved" | "archived" | "includeArchived" | "skipInitialPrompt" => item.is_boolean(),
            "orderedIds" => ids(item),
            "images" => images(item),
            "data" => data_fields(operation, item),
            "page" => transcript_page_request(item),
            "responseType" => matches!(item.as_str(), Some("permission" | "question")),
            "backendType" => matches!(
                item.as_str(),
                Some("opencode" | "claude-code" | "codex" | "cursor" | "pi")
            ),
            "serverUrl" => {
                text(item, 4096)
                    && item.as_str().is_some_and(|s| {
                        url::Url::parse(s).is_ok_and(|u| {
                            matches!(u.scheme(), "http" | "https")
                                && u.host().is_some()
                                && u.username().is_empty()
                                && u.password().is_none()
                                && u.query().is_none()
                                && u.fragment().is_none()
                        })
                    })
            }
            "sinceSeq" | "sinceRev" | "beforeSeq" | "limit" | "byteBudget" | "maxToolCalls" => {
                integer(item)
            }
            "attachments" => item.as_array().is_some_and(|items| {
                items.len() <= 16
                    && items.iter().all(|i| {
                        object(i, &["id", "filename", "size", "mime_type"], &[])
                            && id(&i["id"])
                            && integer(&i["size"])
                            && text(&i["filename"], 256)
                            && text(&i["mime_type"], 128)
                    })
            }),
            "messages" => item
                .as_array()
                .is_some_and(|items| items.len() <= 128 && items.iter().all(chat_message)),
            "title" => text(item, 500),
            "search" => text(item, 200),
            "key" => {
                if operation == "env:get" {
                    matches!(
                        item.as_str(),
                        Some("OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "CURSOR_API_KEY")
                    )
                } else {
                    setting_key(item)
                }
            }
            "value" => text(item, 800000),
            "message" | "text" | "system" | "input" => text(item, 65536),
            _ => false,
        })
}
pub fn valid_result(operation: &str, value: &Value) -> bool {
    if !COMMANDS.contains(&operation)
        || !bounded_bytes(value, 1024 * 1024)
        || !object(value, &["defined"], &["value"])
    {
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
                    | "agent:update"
                    | "skills:update"
                    | "skills:setProject"
                    | "project:reorder"
                    | "projectRepo:add"
                    | "projectRepo:update"
                    | "projectRepo:reorder"
                    | "projectResource:add"
                    | "projectResource:update"
                    | "projectResource:reorder"
                    | "commander:setActiveSession"
                    | "secrets:update"
                    | "terminal:write"
                    | "terminal:resize"
                    | "terminal:kill"
            );
    }
    if value["defined"] != true || value.get("value").is_none() {
        return false;
    }
    let result = &value["value"];
    match operation {
        "db:deleteTask"
        | "db:reorderSubtasks"
        | "agent:delete"
        | "skills:delete"
        | "projectRepo:remove"
        | "projectResource:remove" => result.is_boolean(),
        "agentSession:abort" | "agentSession:stop" | "agentSession:approve" => {
            object(result, &["success"], &[]) && result["success"].is_boolean()
        }
        "agentSession:stopByTaskId" => {
            object(result, &["success", "sessionId"], &[])
                && result["success"].is_boolean()
                && (result["sessionId"].is_null() || id(&result["sessionId"]))
        }
        "agentSession:send" => {
            object(result, &["success"], &["newSessionId"]) && result["success"].is_boolean()
        }
        "agentSession:sendByTaskId" => {
            object(result, &["success", "sessionId"], &["newSessionId"])
                && result["success"].is_boolean()
        }
        "agentSession:start" | "agentSession:resume" | "agentSession:switchAgent" => {
            object(
                result,
                &["sessionId"],
                &["queued", "queuePosition", "queueReason", "ended"],
            ) && text(&result["sessionId"], 128)
        }
        "agentSession:startTask" => object(
            result,
            &["action"],
            &[
                "sessionId",
                "startedTaskId",
                "agentId",
                "queuePosition",
                "queueReason",
            ],
        ),
        "commander:cancel" | "chat:cancel" => {
            object(result, &["cancelled"], &[]) && result["cancelled"].is_boolean()
        }
        "commander:send" => object(result, &["turnId", "message"], &[]),
        "commander:listMessages" => object(result, &["messages", "activeTurnId"], &[]),
        "commander:undoAction" => {
            object(result, &["alreadyUndone", "message"], &[])
                && result["alreadyUndone"].is_boolean()
        }
        "chat:start" => object(result, &["turnId", "provider", "model"], &[]),
        "commander:getImage" => {
            result.is_null()
                || object(
                    result,
                    &[
                        "version",
                        "id",
                        "name",
                        "mimeType",
                        "encoding",
                        "byteLength",
                        "data",
                    ],
                    &[],
                ) && {
                    let mut image = result.clone();
                    image.as_object_mut().unwrap().remove("version");
                    image.as_object_mut().unwrap().remove("id");
                    result["version"] == 1 && self::image(&image)
                }
        }
        "db:getTasks"
        | "db:getSubtasks"
        | "project:getAll"
        | "skills:getAll"
        | "agent:getAll"
        | "projectRepo:list"
        | "projectResource:list"
        | "commander:listSessions"
        | "agent:getStartQueue"
        | "agentSession:getRawTranscript"
        | "agentSession:getTranscriptSnapshot" => result.is_array(),
        "project:moveTask" | "agentConfig:listModels" => result.is_null() || result.is_array(),
        "tasks:getCoordinatorTaskId" => result.is_null() || id(result),
        "settings:get" => result.is_null() || text(result, 800000),
        "settings:set" => false,
        "settings:getAll" => result.as_object().is_some_and(|map| {
            map.len() <= 512
                && map.iter().all(|(key, item)| {
                    setting_key(&Value::String(key.clone()))
                        && text(item, 800000)
                        && (!credential_setting(key) || item == "" || item == "__21x_api_key_set__")
                })
        }),
        "env:get" => result.is_null() || result == "" || result == "__21x_api_key_set__",
        "secrets:getAll" => result
            .as_array()
            .is_some_and(|items| items.len() <= 128 && items.iter().all(secret_metadata)),
        "secrets:create" | "secrets:update" => secret_metadata(result),
        "secrets:delete" => result.is_boolean(),
        "terminal:create" => {
            object(result, &["pid"], &[])
                && integer(&result["pid"])
                && result["pid"].as_u64().is_some_and(|n| n > 0)
        }
        "terminal:getCwd" => {
            object(result, &["cwd"], &[]) && (result["cwd"].is_null() || text(&result["cwd"], 4096))
        }
        "terminal:getBuffer" => {
            object(result, &["lines"], &[])
                && result["lines"].as_array().is_some_and(|items| {
                    items.len() <= 500
                        && items
                            .iter()
                            .all(|line| line.as_str().is_some_and(|s| s.len() <= 512 * 1024))
                })
                && serde_json::to_vec(result).is_ok_and(|bytes| bytes.len() <= 512 * 1024)
        }
        _ => result.is_object() || result.is_null(),
    }
}
fn transcript_page_request(value: &Value) -> bool {
    object(
        value,
        &["version", "mode", "after"],
        &["watermark", "limit"],
    ) && value["version"] == 1
        && matches!(value["mode"].as_str(), Some("snapshot" | "delta"))
        && integer(&value["after"])
        && value.get("watermark").is_none_or(integer)
        && value
            .get("limit")
            .is_none_or(|limit| limit.as_u64().is_some_and(|n| n >= 1 && n <= 64))
        && (value["mode"] != "delta"
            || value.get("watermark").is_none()
            || value["after"].as_u64() <= value["watermark"].as_u64())
}
pub fn valid_event(operation: &str, value: &Value) -> bool {
    if !EVENTS.contains(&operation) || !bounded_bytes(value, 1024 * 1024) {
        return false;
    }
    match operation {
        "tasks:refresh" => object(value, &[], &[]),
        "task:created" => object(value, &["task"], &[]),
        "task:updated" => {
            object(value, &["taskId", "updates"], &[])
                && id(&value["taskId"])
                && value["updates"].is_object()
        }
        "task:deleted" => object(value, &["taskId"], &[]) && id(&value["taskId"]),
        "task:subtasks-reordered" => {
            object(value, &["parentId", "orderedIds"], &[])
                && id(&value["parentId"])
                && ids(&value["orderedIds"])
        }
        "transcript:changed" => {
            object(value, &["taskId", "parts", "maxRev"], &["reloadRequired"])
                && id(&value["taskId"])
                && value["parts"].is_array()
                && integer(&value["maxRev"])
        }
        "project:changed" => object(value, &["projectId", "kind"], &[]) && id(&value["projectId"]),
        "skills:changed" => {
            object(value, &["skillId", "kind"], &["projectId"]) && id(&value["skillId"])
        }
        "agent:status" => {
            object(
                value,
                &["sessionId", "agentId", "taskId", "status"],
                &["epoch", "seq", "heartbeat", "activityOutcome"],
            ) && ["sessionId", "agentId", "taskId"]
                .iter()
                .all(|key| id(&value[*key]))
                && matches!(
                    value["status"].as_str(),
                    Some("working" | "idle" | "waiting_approval" | "error")
                )
        }
        "agent:startQueueChanged" => {
            object(value, &["queue"], &["failed"])
                && value["queue"]
                    .as_array()
                    .is_some_and(|items| items.len() <= 512)
        }
        "project:statusChanged" | "concurrency:changed" => {
            object(value, &["projectId"], &[]) && id(&value["projectId"])
        }
        "agent:recoveryStateChanged" => {
            object(
                value,
                &["taskId", "cause", "action", "result", "error"],
                &[],
            ) && id(&value["taskId"])
        }
        "chat:event" => {
            object(value, &["turnId", "event"], &[])
                && text(&value["turnId"], 512)
                && runtime_event(&value["event"], true)
        }
        "commander:event" => commander_event(value),
        "terminal:data" => {
            object(value, &["id", "data"], &[])
                && terminal_id(&value["id"])
                && value["data"].as_str().is_some_and(|s| s.len() <= 16 * 1024)
        }
        "terminal:exit" => object(value, &["id"], &[]) && terminal_id(&value["id"]),
        _ => false,
    }
}
const SETTINGS: &[&str] = &[
    "theme",
    "sidebar_collapsed",
    "github_org",
    "git_provider",
    "forgejo_login",
    "repo_providers",
    "current_user_email",
    "current_project_id",
    "default_agent_id",
    "setup_completed_version",
    "max_concurrent_agent_sessions",
    "all_projects_paused",
    "captain_prewarm",
    "commander_briefing",
    "heartbeat_enabled_global",
    "heartbeat_default_interval",
    "heartbeat_active_hours_start",
    "heartbeat_active_hours_end",
    "heartbeat_global_instructions",
    "workspace_autocleanup_enabled",
    "workspace_autocleanup_days",
    "workspace_nodemodules_gc_enabled",
    "workspace_nodemodules_gc_days",
    "sessions.ledger",
    "sessions.captain_managed",
    "sessions.commander_managed",
    "sessions.task_managed",
    "sessions.rollover",
    "sessions.rollover_thresholds",
    "canvas_state",
    "drawing_state",
    "canvas_state_migrated_to_projects",
    "drawing_state_migrated_to_projects",
    "OPENCODE_BINARY_PATH",
    "minimize_to_tray",
    "anthropic_api_key",
    "openai_api_key",
    "google_api_key",
    "cursor_api_key",
    "chat_agent_id",
    "chat_provider",
    "chat_model",
    "chat_base_url",
    "chat_reasoning_effort",
    "voice_enabled",
    "voice_model_id",
    "voice_quick_create",
    "voice_global_shortcut",
    "voice_input_device_id",
    "voice_custom_model_dir",
    "voice_conversation",
    "voice_endpoint_silence",
    "voice_advanced_stt",
    "voice_advanced_tts",
    "voice_tts_enabled",
    "voice_tts_engine",
    "voice_tts_model_id",
    "voice_tts_voice_id",
    "voice_tts_speed",
    "voice_tts_max_chars",
    "voice_tts_speak_results",
    "voice_tts_only_voice_turns",
    "elevenlabs_api_key",
    "voice_tts_elevenlabs_voice_id",
    "voice_tts_elevenlabs_model_id",
    "voice_tts_elevenlabs_disclosure",
];
fn setting_key(value: &Value) -> bool {
    value.as_str().is_some_and(|key| {
        key.len() <= 256
            && (SETTINGS.contains(&key)
                || key
                    .strip_prefix("canvas_state:")
                    .or_else(|| key.strip_prefix("drawing_state:"))
                    .is_some_and(|id_value| id(&Value::String(id_value.to_owned()))))
    })
}
fn credential_setting(key: &str) -> bool {
    matches!(
        key,
        "anthropic_api_key"
            | "openai_api_key"
            | "google_api_key"
            | "cursor_api_key"
            | "elevenlabs_api_key"
    )
}
fn secret_metadata(value: &Value) -> bool {
    object(
        value,
        &[
            "id",
            "name",
            "description",
            "env_var_name",
            "created_at",
            "updated_at",
        ],
        &[],
    ) && id(&value["id"])
        && text(&value["name"], 512)
        && text(&value["description"], 65536)
        && text(&value["env_var_name"], 128)
        && text(&value["created_at"], 128)
        && text(&value["updated_at"], 128)
}
fn terminal_id(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 256
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
    })
}
fn terminal_request(operation: &str, value: &Value) -> bool {
    if !terminal_id(&value["id"]) {
        return false;
    }
    match operation {
        "terminal:create" | "terminal:resize" => {
            ["cols", "rows"]
                .iter()
                .all(|key| value[*key].as_u64().is_some_and(|n| n > 0 && n <= 4096))
                && value
                    .get("cwd")
                    .is_none_or(|cwd| text(cwd, 4096) && cwd != "")
        }
        "terminal:write" => value["data"].as_str().is_some_and(|s| s.len() <= 65536),
        "terminal:kill" | "terminal:getCwd" => value
            .get("expectedPid")
            .is_none_or(|pid| integer(pid) && pid.as_u64().is_some_and(|n| n > 0)),
        "terminal:getBuffer" => value
            .get("lines")
            .is_none_or(|lines| lines.as_u64().is_some_and(|n| n > 0 && n <= 500)),
        _ => false,
    }
}
fn chat_message(value: &Value) -> bool {
    match value["role"].as_str() {
        Some("user") => {
            object(value, &["role", "content"], &["images"])
                && text(&value["content"], 65536)
                && value.get("images").is_none_or(images)
        }
        Some("assistant") => {
            object(value, &["role", "content"], &["toolCalls"]) && text(&value["content"], 65536)
        }
        Some("tool") => {
            object(
                value,
                &["role", "toolCallId", "name", "content"],
                &["isError"],
            ) && text(&value["content"], 65536)
        }
        _ => false,
    }
}
fn runtime_event(value: &Value, full_done: bool) -> bool {
    match value["type"].as_str() {
        Some("text_delta") => object(value, &["type", "text"], &[]) && text(&value["text"], 65536),
        Some("done") => {
            if full_done {
                object(value, &["type", "stopReason", "messages", "usage"], &[])
                    && value["messages"]
                        .as_array()
                        .is_some_and(|items| items.len() <= 128 && items.iter().all(chat_message))
                    && object(&value["usage"], &["inputTokens", "outputTokens"], &[])
                    && integer(&value["usage"]["inputTokens"])
                    && integer(&value["usage"]["outputTokens"])
            } else {
                object(value, &["type", "stopReason"], &[])
            }
        }
        Some("error") => object(value, &["type", "message"], &[]),
        Some("tool_call_start") => object(value, &["type", "id", "name", "input"], &[]),
        Some("tool_call_result") => {
            object(value, &["type", "id", "name", "content", "isError"], &[])
        }
        _ => false,
    }
}
fn commander_event(value: &Value) -> bool {
    match value["type"].as_str() {
        Some("session_updated") => object(value, &["type", "session"], &["activity"]),
        Some("messages_appended") => object(
            value,
            &["type", "sessionId", "messages"],
            &["activity", "turnId"],
        ),
        Some("turn_started") => object(value, &["type", "sessionId", "turnId"], &["activity"]),
        Some("turn_event") => {
            object(
                value,
                &["type", "sessionId", "turnId", "event"],
                &["activity"],
            ) && runtime_event(&value["event"], false)
        }
        _ => false,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn production_names_and_scopes_are_finite() {
        assert_eq!(COMMANDS.len(), 86);
        assert!(valid_request(
            "agentSession:approve",
            &json!({"sessionId":"s","approved":false,"requestId":"native/request","responseType":"question"})
        ));
        for value in [
            json!({"sessionId":"s","approved":true}),
            json!({"agentId":"a","taskId":"t","workspaceDir":"/private"}),
        ] {
            assert!(!valid_request("agentSession:start", &value));
        }
        assert!(!valid_request("fixture.agentStart", &json!({})));
        assert!(!valid_request("host.production.prepare", &json!({})));
        assert!(!valid_request(
            "db:updateTask",
            &json!({"id":"t","data":{"session_id":"foreign"}})
        ));
    }
    #[test]
    fn optional_results_and_binary_envelopes_remain_explicit() {
        assert!(valid_result(
            "commander:setActiveSession",
            &json!({"defined":false})
        ));
        assert!(!valid_result(
            "commander:setActiveSession",
            &json!({"defined":false,"value":null})
        ));
        assert!(valid_request(
            "commander:send",
            &json!({"sessionId":"s","text":"","images":{"version":1,"images":[{"name":"a.png","mimeType":"image/png","encoding":"base64","byteLength":1,"data":"AQ=="}]}})
        ));
        assert!(!valid_request(
            "commander:send",
            &json!({"sessionId":"s","text":"","images":{"version":1,"images":[{"name":"a.png","mimeType":"image/png","encoding":"base64","byteLength":1,"data":[1]}]}})
        ));
        assert!(!valid_event("tasks:refresh", &json!({"authority":true})));
        assert!(!valid_event("native:arbitrary", &json!({})));
    }
    #[test]
    fn settings_credentials_return_only_metadata_and_markers() {
        assert!(valid_request("env:get", &json!({"key":"OPENAI_API_KEY"})));
        assert!(!valid_request("env:get", &json!({"key":"HOME"})));
        assert!(!valid_request(
            "settings:get",
            &json!({"key":"unreviewed_setting"})
        ));
        assert!(valid_result(
            "env:get",
            &json!({"defined":true,"value":"__21x_api_key_set__"})
        ));
        assert!(!valid_result(
            "env:get",
            &json!({"defined":true,"value":"plaintext-secret"})
        ));
        assert!(valid_result(
            "settings:getAll",
            &json!({"defined":true,"value":{"openai_api_key":"__21x_api_key_set__","theme":"dark"}})
        ));
        assert!(!valid_result(
            "settings:getAll",
            &json!({"defined":true,"value":{"openai_api_key":"plaintext-secret"}})
        ));
        let metadata = json!({"id":"secret","name":"Fixture","description":"","env_var_name":"FIXTURE_KEY","created_at":"fixture","updated_at":"fixture"});
        assert!(valid_result(
            "secrets:create",
            &json!({"defined":true,"value":metadata})
        ));
        let mut private = metadata;
        private["value"] = json!("plaintext-secret");
        assert!(!valid_result(
            "secrets:create",
            &json!({"defined":true,"value":private})
        ));
    }
    #[test]
    fn terminal_control_bytes_are_data_and_pid_is_only_an_exact_terminal_receipt_guard() {
        assert!(valid_request(
            "terminal:write",
            &json!({"id":"terminal:fixture","data":"\u{001b}[31m\u{0000}"})
        ));
        assert!(valid_request(
            "terminal:kill",
            &json!({"id":"terminal:fixture","expectedPid":42})
        ));
        assert!(!valid_request("terminal:kill", &json!({"pid":42})));
        assert!(!valid_request(
            "terminal:kill",
            &json!({"id":"terminal:fixture","expectedPid":42,"processName":"sh"})
        ));
        assert!(!valid_request(
            "terminal:create",
            &json!({"id":"terminal:fixture","cols":0,"rows":24})
        ));
        assert!(!valid_event(
            "terminal:data",
            &json!({"id":"terminal:fixture","data":"x".repeat(16385)})
        ));
        assert!(valid_event(
            "chat:event",
            &json!({"turnId":"turn","event":{"type":"done","stopReason":"end_turn","messages":[{"role":"user","content":"image","images":{"version":1,"images":[{"name":"a.png","mimeType":"image/png","encoding":"base64","byteLength":1,"data":"AQ=="}]}}],"usage":{"inputTokens":1,"outputTokens":1}}})
        ));
    }
    #[test]
    fn transcript_pages_use_the_current_nested_versioned_cursor_contract() {
        for page in [
            json!({"version":1,"mode":"snapshot","after":0}),
            json!({"version":1,"mode":"snapshot","after":10,"watermark":100,"limit":64}),
            json!({"version":1,"mode":"delta","after":10,"watermark":100,"limit":1}),
        ] {
            assert!(valid_request(
                "agentSession:getTranscriptPage",
                &json!({"taskId":"task_fixture","page":page})
            ));
        }
        for payload in [
            json!({"taskId":"task_fixture","beforeSeq":1}),
            json!({"taskId":"task_fixture","page":{"version":1,"mode":"delta","after":11,"watermark":10}}),
            json!({"taskId":"task_fixture","page":{"version":1,"mode":"snapshot","after":0,"limit":65}}),
        ] {
            assert!(!valid_request("agentSession:getTranscriptPage", &payload));
        }
        assert!(valid_request(
            "project:update",
            &json!({"id":"project_fixture","data":{"git_provider":null,"git_org":null}})
        ));
        assert!(valid_request(
            "skills:update",
            &json!({"id":"skill_fixture","data":{"confidence":0.5,"uses":3,"last_used":null,"expected_version":1}})
        ));
    }
    #[test]
    fn generic_input_uses_the_protocol_ceiling_without_shrinking_domain_json() {
        let tools = (0..120)
            .map(|index| json!(format!("tool_{index}_{}", "x".repeat(240))))
            .collect::<Vec<_>>();
        let servers = (0..30)
            .map(|index| json!({"serverId":format!("server_{index}"),"enabledTools":tools}))
            .collect::<Vec<_>>();
        let payload = json!({"id":"agent_fixture","data":{"config":{"coding_agent":"pi","mcp_servers":servers}}});
        let bytes = serde_json::to_vec(&payload).unwrap().len();
        assert!(bytes > 900000 && bytes < 1024 * 1024 - 1024);
        assert!(valid_request("agent:update", &payload));
        let mut deep = json!("leaf");
        for _ in 0..40 {
            deep = json!({"child":deep});
        }
        assert!(valid_request(
            "db:updateTask",
            &json!({"id":"task_fixture","data":{"output_fields":[{"id":"output_fixture","name":"Deep","type":"json","value":deep}]}})
        ));
    }
    /// Coordinator emits this artifact through actual TS encodeArguments after
    /// all workers freeze; source-only runs without the artifact make no parity claim.
    #[test]
    fn actual_typescript_golden_requests_are_accepted_without_payload_grants() {
        let Some(path) = std::env::var_os("TWENTYONEX_PRODUCTION_CONTRACTS_CORPUS") else {
            return;
        };
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .expect("open coordinator corpus")
            .take(32 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .expect("read coordinator corpus");
        assert!(bytes.len() <= 32 * 1024 * 1024);
        let corpus: Value = serde_json::from_slice(&bytes).expect("strict corpus JSON");
        assert!(object(&corpus, &["version", "operations", "requests"], &[]));
        assert_eq!(corpus["version"], 1);
        let operations = corpus["operations"].as_array().expect("finite operations");
        let supplied = operations
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<std::collections::HashSet<_>>();
        let expected = COMMANDS
            .iter()
            .copied()
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(operations.len(), COMMANDS.len());
        assert_eq!(supplied, expected);
        let rows = corpus["requests"]
            .as_array()
            .expect("finite request fixtures");
        assert!(rows.len() >= COMMANDS.len() && rows.len() <= 4096);
        let mut observed = std::collections::HashSet::new();
        for row in rows {
            assert!(object(row, &["operation", "case", "payload"], &[]));
            let operation = row["operation"].as_str().expect("operation");
            let case = row["case"].as_str().expect("case");
            assert!(expected.contains(operation));
            assert!(
                valid_request(operation, &row["payload"]),
                "rejected actual TypeScript fixture: {operation}/{case}"
            );
            observed.insert(operation);
            let mut grant = row["payload"].clone();
            grant
                .as_object_mut()
                .expect("request object")
                .insert("authority".into(), json!({"namespace":"*"}));
            assert!(
                !valid_request(operation, &grant),
                "accepted extra authority: {operation}/{case}"
            );
        }
        assert_eq!(observed, expected);
        assert!(!valid_request("fixture.agentStart", &json!({})));
        assert!(!valid_request("host.production.prepare", &json!({})));
    }
}
