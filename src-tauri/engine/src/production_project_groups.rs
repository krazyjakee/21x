//! Narrow native outer DTO policy; the service also validates full domain DTOs.
use super::{bounded_bytes, id, integer, object, text, workspace_file_path};
use serde_json::Value;
pub const COMMANDS: &[&str] = &[
    "taskGroups:list",
    "taskGroups:get",
    "taskGroups:history",
    "taskGroups:create",
    "taskGroups:add",
    "taskGroups:remove",
    "taskGroups:dissolve",
    "taskGroups:move",
    "taskGroups:review",
    "project:getStatus",
    "project:getAllStatuses",
    "project:getStatusHistory",
    "project:getCaptainMemory",
    "projectLimits:getState",
    "projectLimits:isAllPaused",
    "projectLimits:pauseAll",
    "concurrency:getState",
    "concurrency:setCaptainControl",
    "concurrency:pin",
];
fn list(v: &Value, n: usize, check: impl Fn(&Value) -> bool) -> bool {
    v.as_array()
        .is_some_and(|a| a.len() <= n && a.iter().all(check))
}
fn ids(v: &Value, n: usize, min: usize) -> bool {
    v.as_array().is_some_and(|a| {
        a.len() >= min
            && a.len() <= n
            && a.iter().all(id)
            && a.iter()
                .filter_map(Value::as_str)
                .collect::<std::collections::HashSet<_>>()
                .len()
                == a.len()
    })
}
fn optional(v: &Value, key: &str, check: impl Fn(&Value) -> bool) -> bool {
    v.get(key).is_none_or(check)
}
fn choice(v: &Value, values: &[&str]) -> bool {
    v.as_str().is_some_and(|s| values.contains(&s))
}
fn bytes(v: &Value, max: usize) -> bool {
    v.as_str().is_some_and(|s| s.len() <= max)
}
fn label(v: &Value, max: usize) -> bool {
    v.as_str()
        .is_some_and(|s| s.len() <= max && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}'))
}
fn nullable_num(v: &Value) -> bool {
    v.is_null() || integer(v)
}
fn date(v: &Value) -> bool {
    v.is_null() || label(v, 64)
}
fn title(v: &Value) -> bool {
    text(v,400) && v.as_str().is_some_and(|s| {
 let s=s.trim_matches(|c| matches!(c, '\u{9}'..='\u{d}'|' '| '\u{a0}'| '\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'));
 !s.is_empty() && s.encode_utf16().count()<=200
})
}
fn pin(v: &Value) -> bool {
    v.is_null() || v.as_u64().is_some_and(|n| (1..=10).contains(&n))
}
pub fn request(op: &str, v: &Value) -> bool {
    if !bounded_bytes(v, 32768) {
        return false;
    }
    match op {
        "taskGroups:list" => {
            object(v, &["projectId"], &["includeDissolved"])
                && id(&v["projectId"])
                && optional(v, "includeDissolved", Value::is_boolean)
        }
        "taskGroups:get" | "taskGroups:dissolve" => object(v, &["id"], &[]) && id(&v["id"]),
        "taskGroups:history" => object(v, &["taskId"], &[]) && id(&v["taskId"]),
        "taskGroups:create" => {
            object(v, &["data"], &[])
                && object(&v["data"], &["title", "task_ids"], &["agent_id"])
                && title(&v["data"]["title"])
                && ids(&v["data"]["task_ids"], 10, 2)
                && optional(&v["data"], "agent_id", id)
        }
        "taskGroups:add" => {
            object(v, &["id", "taskIds"], &[]) && id(&v["id"]) && ids(&v["taskIds"], 10, 1)
        }
        "taskGroups:remove" => {
            object(v, &["id", "taskId"], &[]) && id(&v["id"]) && id(&v["taskId"])
        }
        "taskGroups:move" => {
            object(v, &["id", "status"], &[])
                && id(&v["id"])
                && choice(
                    &v["status"],
                    &[
                        "not_started",
                        "agent_working",
                        "ready_for_review",
                        "completed",
                    ],
                )
        }
        "taskGroups:review" => {
            object(v, &["data"], &[])
                && object(
                    &v["data"],
                    &["group_id", "action"],
                    &["task_ids", "message", "complete_at_source"],
                )
                && id(&v["data"]["group_id"])
                && choice(&v["data"]["action"], &["approve", "send_back"])
                && optional(&v["data"], "task_ids", |a| ids(a, 10, 1))
                && optional(&v["data"], "message", |s| text(s, 4000))
                && optional(&v["data"], "complete_at_source", Value::is_boolean)
        }
        "project:getAllStatuses" | "projectLimits:isAllPaused" => object(v, &[], &[]),
        "projectLimits:pauseAll" => object(v, &["paused"], &[]) && v["paused"].is_boolean(),
        "project:getStatusHistory" => {
            object(v, &["projectId"], &["query"])
                && id(&v["projectId"])
                && optional(v, "query", |q| {
                    object(q, &[], &["limit", "cursor"])
                        && optional(q, "limit", |n| n.as_f64().is_some_and(f64::is_finite))
                        && optional(q, "cursor", |s| s.is_null() || label(s, 300))
                })
        }
        "concurrency:setCaptainControl" => {
            object(v, &["projectId", "enabled"], &[])
                && id(&v["projectId"])
                && v["enabled"].is_boolean()
        }
        "concurrency:pin" => {
            object(v, &["projectId", "agentId", "level"], &[])
                && id(&v["projectId"])
                && id(&v["agentId"])
                && pin(&v["level"])
        }
        "project:getStatus"
        | "project:getCaptainMemory"
        | "projectLimits:getState"
        | "concurrency:getState" => object(v, &["projectId"], &[]) && id(&v["projectId"]),
        _ => false,
    }
}
fn group(v: &Value) -> bool {
    object(
        v,
        &[
            "id",
            "title",
            "project_id",
            "agent_id",
            "execution_task_id",
            "state",
            "status",
            "task_ids",
            "former_task_ids",
            "progress",
            "created_at",
            "updated_at",
        ],
        &[],
    ) && ["id", "project_id", "agent_id", "execution_task_id"]
        .iter()
        .all(|k| id(&v[*k]))
        && title(&v["title"])
        && choice(&v["state"], &["active", "dissolved"])
        && choice(
            &v["status"],
            &[
                "not_started",
                "triaging",
                "agent_working",
                "ready_for_review",
                "agent_learning",
                "completed",
            ],
        )
        && ids(&v["task_ids"], 10, 0)
        && ids(&v["former_task_ids"], 128, 0)
        && v["task_ids"].as_array().is_some_and(|ids| {
            ids.iter().all(|id| {
                !v["former_task_ids"]
                    .as_array()
                    .is_some_and(|a| a.contains(id))
            })
        })
        && list(&v["progress"], 128, |p| {
            object(p, &["task_id", "state", "message", "updated_at"], &[])
                && id(&p["task_id"])
                && choice(&p["state"], &["pending", "working", "done", "blocked"])
                && text(&p["message"], 4000)
                && text(&p["updated_at"], 128)
                && ["task_ids", "former_task_ids"]
                    .iter()
                    .any(|k| v[*k].as_array().is_some_and(|a| a.contains(&p["task_id"])))
        })
        && v["progress"].as_array().is_some_and(|a| {
            a.iter()
                .filter_map(|p| p["task_id"].as_str())
                .collect::<std::collections::HashSet<_>>()
                .len()
                == a.len()
        })
        && text(&v["created_at"], 128)
        && text(&v["updated_at"], 128)
        && bounded_bytes(v, 900000)
}
// Native outer task projection rejects private fields. The service and renderer
// additionally validate every existing lifecycle field and date semantic.
fn task(v: &Value) -> bool {
    let required = &[
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
        "id",
        "project_id",
        "source",
        "external_id",
        "source_id",
        "session_id",
        "recurrence_parent_id",
        "role",
        "created_at",
        "updated_at",
    ];
    object(v, required, &["last_activity_at", "group_id"])
        && id(&v["id"])
        && id(&v["project_id"])
        && choice(&v["role"], &["task", "captain", "task_group"])
        && [
            "title",
            "description",
            "assignee",
            "source",
            "created_at",
            "updated_at",
        ]
        .iter()
        .all(|k| text(&v[*k], 65536))
        && [
            "agent_id",
            "source_id",
            "parent_task_id",
            "recurrence_parent_id",
        ]
        .iter()
        .all(|k| v[*k].is_null() || id(&v[*k]))
        && [
            "attachments",
            "labels",
            "repos",
            "output_fields",
            "next_subtask_ids",
        ]
        .iter()
        .all(|k| list(&v[*k], 128, |_| true))
        && optional(v, "group_id", |x| x.is_null() || id(x))
        && bounded_bytes(v, 898976)
}
fn reason(v: &Value) -> bool {
    v.is_null()
        || choice(
            v,
            &[
                "project_limit",
                "project_daily_cap",
                "project_paused",
                "global_pause",
            ],
        )
}
fn limits(v: &Value) -> bool {
    object(
        v,
        &[
            "projectId",
            "paused",
            "allProjectsPaused",
            "maxConcurrentAgents",
            "runningAgents",
            "dailySessionCap",
            "sessionsStartedToday",
            "dailyTokenCap",
            "tokensToday",
            "queued",
            "blockedBy",
        ],
        &[],
    ) && id(&v["projectId"])
        && v["paused"].is_boolean()
        && v["allProjectsPaused"].is_boolean()
        && ["maxConcurrentAgents", "dailySessionCap", "dailyTokenCap"]
            .iter()
            .all(|k| nullable_num(&v[*k]))
        && ["runningAgents", "sessionsStartedToday", "tokensToday"]
            .iter()
            .all(|k| integer(&v[*k]))
        && reason(&v["blockedBy"])
        && list(&v["queued"], 256, |q| {
            object(
                q,
                &["taskId", "agentId", "reason", "queuedAt", "position"],
                &[],
            ) && id(&q["taskId"])
                && id(&q["agentId"])
                && label(&q["reason"], 2048)
                && label(&q["queuedAt"], 64)
                && integer(&q["position"])
        })
}
fn status(v: &Value) -> bool {
    object(
        v,
        &[
            "project_id",
            "counts",
            "summary",
            "top_blockers",
            "updated_at",
        ],
        &["limits"],
    ) && id(&v["project_id"])
        && object(
            &v["counts"],
            &[
                "running",
                "queued",
                "awaiting_review",
                "awaiting_approval",
                "blocked",
            ],
            &[],
        )
        && v["counts"]
            .as_object()
            .is_some_and(|m| m.values().all(integer))
        && bytes(&v["summary"], 8000)
        && list(&v["top_blockers"], 16, |s| bytes(s, 1600))
        && date(&v["updated_at"])
        && optional(v, "limits", limits)
}
fn overview(v: &Value) -> bool {
    object(
        v,
        &[
            "project_id",
            "name",
            "brief",
            "is_default",
            "sort_order",
            "status",
            "pending_approvals",
            "running_agents",
            "paused",
            "all_projects_paused",
            "blocked_by",
            "last_activity_at",
            "needs_attention",
        ],
        &[],
    ) && id(&v["project_id"])
        && label(&v["name"], 1024)
        && bytes(&v["brief"], 16384)
        && status(&v["status"])
        && v["status"]["project_id"] == v["project_id"]
        && [
            "is_default",
            "paused",
            "all_projects_paused",
            "needs_attention",
        ]
        .iter()
        .all(|k| v[*k].is_boolean())
        && ["sort_order", "pending_approvals", "running_agents"]
            .iter()
            .all(|k| integer(&v[*k]))
        && reason(&v["blocked_by"])
        && date(&v["last_activity_at"])
}
fn history(v: &Value) -> bool {
    object(v, &["entries", "has_more", "next_cursor"], &[])
        && v["has_more"].is_boolean()
        && (v["next_cursor"].is_null() || label(&v["next_cursor"], 300))
        && list(&v["entries"], 20, |e| {
            object(
                e,
                &[
                    "id",
                    "project_id",
                    "summary",
                    "completed",
                    "blockers",
                    "decisions",
                    "next_steps",
                    "source",
                    "correlation_id",
                    "created_at",
                ],
                &[],
            ) && id(&e["id"])
                && id(&e["project_id"])
                && bytes(&e["summary"], 8000)
                && ["completed", "blockers", "decisions", "next_steps"]
                    .iter()
                    .all(|k| list(&e[*k], 16, |s| bytes(s, 1600)))
                && choice(&e["source"], &["captain", "system_recovery", "compaction"])
                && (e["correlation_id"].is_null() || label(&e["correlation_id"], 512))
                && label(&e["created_at"], 64)
        })
}
fn concurrency(v: &Value) -> bool {
    object(
        v,
        &[
            "projectId",
            "captainControl",
            "agents",
            "pressure",
            "recentChanges",
        ],
        &[],
    ) && id(&v["projectId"])
        && v["captainControl"].is_boolean()
        && list(&v["agents"], 128, |a| {
            object(
                a,
                &[
                    "agentId",
                    "agentName",
                    "cap",
                    "level",
                    "source",
                    "runningInProject",
                    "runningTotal",
                    "queuedInProject",
                    "recommendation",
                ],
                &[],
            ) && id(&a["agentId"])
                && label(&a["agentName"], 1024)
                && a["cap"].as_u64().is_some_and(|n| (1..=10).contains(&n))
                && a["level"]
                    .as_u64()
                    .is_some_and(|n| n >= 1 && n <= a["cap"].as_u64().unwrap_or(0))
                && choice(&a["source"], &["captain", "pinned", "cap"])
                && ["runningInProject", "runningTotal", "queuedInProject"]
                    .iter()
                    .all(|k| integer(&a[*k]))
                && object(&a["recommendation"], &["level", "why"], &[])
                && integer(&a["recommendation"]["level"])
                && label(&a["recommendation"]["why"], 2048)
        })
        && (v["pressure"].is_null()
            || object(
                &v["pressure"],
                &["underPressure", "reasons", "freeMemRatio", "loadPerCpu"],
                &[],
            ) && v["pressure"]["underPressure"].is_boolean()
                && list(&v["pressure"]["reasons"], 16, |s| label(s, 2048))
                && ["freeMemRatio", "loadPerCpu"].iter().all(|k| {
                    v["pressure"][*k]
                        .as_f64()
                        .is_some_and(|n| n.is_finite() && n >= 0.0)
                }))
        && list(&v["recentChanges"], 20, |a| {
            object(
                a,
                &[
                    "id",
                    "project_id",
                    "agent_id",
                    "kind",
                    "previous_level",
                    "level",
                    "cap",
                    "actor",
                    "reason",
                    "created_at",
                ],
                &[],
            ) && id(&a["id"])
                && id(&a["project_id"])
                && (a["agent_id"] == "" || id(&a["agent_id"]))
                && choice(
                    &a["kind"],
                    &["level", "pin", "unpin", "control_on", "control_off"],
                )
                && nullable_num(&a["previous_level"])
                && nullable_num(&a["level"])
                && integer(&a["cap"])
                && choice(&a["actor"], &["captain", "user", "system"])
                && bytes(&a["reason"], 4096)
                && label(&a["created_at"], 64)
        })
}
pub fn result(op: &str, wire: &Value) -> bool {
    if !object(wire, &["defined", "value"], &[]) || wire["defined"] != true {
        return false;
    }
    let v = &wire["value"];
    if op.starts_with("taskGroups:") {
        if !bounded_bytes(wire, 900064) || !bounded_bytes(v, 900000) {
            return false;
        }
        return match op {
            "taskGroups:list" | "taskGroups:history" => list(v, 256, group),
            "taskGroups:get" => {
                object(v, &["group", "task", "members"], &[])
                    && group(&v["group"])
                    && task(&v["task"])
                    && list(&v["members"], 128, task)
                    && v["task"]["id"] == v["group"]["execution_task_id"]
                    && v["members"].as_array().is_some_and(|members| {
                        members
                            .iter()
                            .filter_map(|member| member["id"].as_str())
                            .collect::<std::collections::HashSet<_>>()
                            .len()
                            == members.len()
                            && members.iter().all(|member| {
                                ["task_ids", "former_task_ids"].iter().any(|key| {
                                    v["group"][*key]
                                        .as_array()
                                        .is_some_and(|ids| ids.contains(&member["id"]))
                                })
                            })
                    })
            }
            "taskGroups:review" => {
                object(v, &["group", "completed_task_ids", "failures"], &[])
                    && group(&v["group"])
                    && ids(&v["completed_task_ids"], 10, 0)
                    && list(&v["failures"], 10, |f| {
                        object(f, &["task_id", "message"], &[])
                            && id(&f["task_id"])
                            && text(&f["message"], 4000)
                    })
            }
            _ => group(v),
        };
    }
    if !bounded_bytes(wire, 889999) {
        return false;
    }
    match op {
        "project:getStatus" => status(v),
        "project:getAllStatuses" => list(v, 128, overview),
        "project:getStatusHistory" => history(v),
        "project:getCaptainMemory" => {
            v.is_null()
                || object(v, &["path", "content", "truncated"], &[])
                    && workspace_file_path(&v["path"])
                    && bytes(&v["content"], 48000)
                    && v["content"]
                        .as_str()
                        .is_some_and(|s| s.encode_utf16().count() <= 12000)
                    && v["truncated"].is_boolean()
        }
        "projectLimits:getState" => limits(v),
        "projectLimits:isAllPaused" | "projectLimits:pauseAll" => v.is_boolean(),
        "concurrency:getState" => concurrency(v),
        "concurrency:setCaptainControl" | "concurrency:pin" => {
            object(v, &["success"], &[]) && v["success"] == true
                || object(v, &["error"], &[]) && label(&v["error"], 2048)
        }
        _ => false,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn actual_owned_results_have_finite_outer_dtos() {
        let Ok(path) = std::env::var("TWENTYONEX_PROJECT_GROUP_RESULTS") else {
            return;
        };
        let data = std::fs::read(path).expect("read actual protected-profile result corpus");
        assert!(data.len() <= 32 * 1024 * 1024);
        let corpus: Value = serde_json::from_slice(&data).expect("strict result corpus");
        assert!(object(&corpus, &["version", "responses"], &[]));
        assert_eq!(corpus["version"], 1);
        let responses = corpus["responses"]
            .as_array()
            .expect("finite actual responses");
        assert!(responses.len() >= COMMANDS.len() && responses.len() <= 128);
        let mut observed = std::collections::HashSet::new();
        for response in responses {
            assert!(object(response, &["operation", "wire"], &[]));
            let op = response["operation"]
                .as_str()
                .expect("finite result operation");
            assert!(COMMANDS.contains(&op));
            assert!(
                result(op, &response["wire"]),
                "rejected actual response: {op}"
            );
            let mut extra = response["wire"].clone();
            extra
                .as_object_mut()
                .unwrap()
                .insert("authority".into(), json!("*"));
            assert!(!result(op, &extra));
            observed.insert(op);
        }
        assert_eq!(observed, COMMANDS.iter().copied().collect());
    }
    #[test]
    fn exact_requests_refuse_overrides_and_preserve_utf16_title_feedback() {
        assert!(request(
            "taskGroups:create",
            &json!({"data":{"title":"\u{feff}🌱\u{feff}","task_ids":["task_a","task_b"]}})
        ));
        assert!(!request(
            "taskGroups:create",
            &json!({"data":{"title":"Batch","task_ids":["task_a","task_a"]}})
        ));
        assert!(!request(
            "taskGroups:move",
            &json!({"id":"group_a","status":"agent_learning"})
        ));
        assert!(!request(
            "taskGroups:review",
            &json!({"data":{"group_id":"group_a","action":"approve","root":"/private"}})
        ));
        assert!(request(
            "project:getStatusHistory",
            &json!({"projectId":"project_a","query":{"limit":20,"cursor":null}})
        ));
        assert!(!request(
            "concurrency:pin",
            &json!({"projectId":"project_a","agentId":"agent_a","level":11})
        ));
        assert!(!request(
            "projectLimits:pauseAll",
            &json!({"paused":true,"projectId":"foreign"})
        ));
    }
    #[test]
    fn result_envelopes_and_memory_capacity_are_finite() {
        assert!(result(
            "project:getCaptainMemory",
            &json!({"defined":true,"value":{"path":"/workspace/captain/MEMORY.md","content":"🌱".repeat(6000),"truncated":true}})
        ));
        assert!(!result(
            "project:getCaptainMemory",
            &json!({"defined":true,"value":{"path":"/workspace/captain/MEMORY.md","content":"🌱".repeat(6001),"truncated":true}})
        ));
        assert!(!result("projectLimits:pauseAll", &json!({"defined":false})));
        assert!(!result(
            "concurrency:pin",
            &json!({"defined":true,"value":{"success":true,"private_token":"foreign"}})
        ));
    }
}
