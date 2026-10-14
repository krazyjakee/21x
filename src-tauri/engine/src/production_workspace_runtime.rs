//! Finite heartbeat/worktree DTOs. Actual effects remain with retained service owners.
use super::{
    bounded_bytes, git_address, git_organization, git_repository, id, integer, object,
    workspace_file_path,
};
use serde_json::Value;
pub const COMMANDS: &[&str] = &[
    "heartbeat:enable",
    "heartbeat:disable",
    "heartbeat:runNow",
    "heartbeat:getLogs",
    "heartbeat:getStatus",
    "heartbeat:updateInterval",
    "heartbeat:readFile",
    "heartbeat:writeFile",
    "worktree:setup",
    "worktree:changes",
    "worktree:files",
    "worktree:readFile",
    "worktree:cleanup",
    "workspace:runCleanupNow",
];
pub const EVENTS: &[&str] = &[
    "heartbeat:alert",
    "heartbeat:disabled",
    "worktree:progress",
    "workspace:cleanup-progress",
    "workspace:cleanup-complete",
];
const WORKTREE_ERROR: &str = "The worktree operation could not be completed.";
const CLEANUP_ERROR: &str = "The workspace cleanup could not be completed.";
fn choice(v: &Value, values: &[&str]) -> bool {
    v.as_str().is_some_and(|s| values.contains(&s))
}
fn optional(v: &Value, key: &str, check: impl Fn(&Value) -> bool) -> bool {
    v.get(key).is_none_or(check)
}
fn text(v: &Value, max: usize, no_nul: bool) -> bool {
    v.as_str()
        .is_some_and(|s| s.len() <= max && (!no_nul || !s.contains('\0')))
}
fn utf16_text(v: &Value, max: usize) -> bool {
    v.as_str()
        .is_some_and(|s| s.encode_utf16().count() <= max && !s.contains('\0'))
}
fn label(v: &Value, max: usize) -> bool {
    v.as_str()
        .is_some_and(|s| s.len() <= max && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}'))
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
            .collect::<std::collections::HashSet<_>>()
            .len()
            == a.len()
    })
}
fn interval(v: &Value) -> bool {
    v.as_u64().is_some_and(|n| (1..=525600).contains(&n))
}
fn date(v: &Value) -> bool {
    label(v, 128) && v.as_str().is_some_and(|s| !s.is_empty())
}
fn nullable(v: &Value, check: impl Fn(&Value) -> bool) -> bool {
    v.is_null() || check(v)
}
fn branch(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        label(v, 1024)
            && !s.is_empty()
            && !s.starts_with(['-', '/'])
            && !s.chars().any(|c| " ~^:?*[\\".contains(c))
            && !s.contains("..")
            && !s.contains("@{")
            && !s.contains("//")
            && s.split('/').all(|p| {
                !p.is_empty() && !p.starts_with('.') && !p.ends_with('.') && !p.ends_with(".lock")
            })
    })
}
fn file(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        let p = s.replace('\\', "/");
        let p = p.strip_prefix("./").unwrap_or(&p);
        label(v, 4096)
            && !s.is_empty()
            && !s.starts_with(['/', '\\'])
            && !(s.as_bytes().get(1) == Some(&b':') && s.as_bytes()[0].is_ascii_alphabetic())
            && p.split('/').count() <= 64
            && p.split('/').all(|p| !p.is_empty() && p != "." && p != "..")
    })
}
fn repos(v: &Value, setup: bool) -> bool {
    list(v, 128, |r| {
        object(
            r,
            if setup {
                &["fullName", "defaultBranch"]
            } else {
                &["fullName"]
            },
            &[],
        ) && git_repository(&r["fullName"])
            && (!setup || branch(&r["defaultBranch"]))
    }) && unique(v, Some("fullName"))
        && v.as_array().is_some_and(|a| {
            a.iter()
                .filter_map(|r| r["fullName"].as_str())
                .filter_map(|s| s.rsplit('/').next())
                .collect::<std::collections::HashSet<_>>()
                .len()
                == a.len()
        })
}
pub fn request(op: &str, v: &Value) -> bool {
    if !bounded_bytes(v, 890000) {
        return false;
    }
    match op {
        "heartbeat:enable" => {
            object(v, &["taskId"], &["intervalMinutes"])
                && id(&v["taskId"])
                && optional(v, "intervalMinutes", interval)
        }
        "heartbeat:updateInterval" => {
            object(v, &["taskId", "intervalMinutes"], &[])
                && id(&v["taskId"])
                && interval(&v["intervalMinutes"])
        }
        "heartbeat:getLogs" => {
            object(v, &["taskId"], &["limit"])
                && id(&v["taskId"])
                && optional(v, "limit", |x| {
                    x.as_u64().is_some_and(|n| (1..=128).contains(&n))
                })
        }
        "heartbeat:writeFile" => {
            object(v, &["taskId", "content"], &[])
                && id(&v["taskId"])
                && text(&v["content"], 131072, true)
        }
        "heartbeat:disable" | "heartbeat:runNow" | "heartbeat:getStatus" | "heartbeat:readFile" => {
            object(v, &["taskId"], &[]) && id(&v["taskId"])
        }
        "workspace:runCleanupNow" => object(v, &[], &[]),
        "worktree:readFile" => {
            object(v, &["taskId", "repoFullName", "filePath"], &[])
                && id(&v["taskId"])
                && nullable(&v["repoFullName"], git_repository)
                && file(&v["filePath"])
        }
        "worktree:changes" | "worktree:files" => {
            object(v, &["taskId", "repos"], &[]) && id(&v["taskId"]) && repos(&v["repos"], false)
        }
        "worktree:setup" => {
            object(v, &["taskId", "repos", "org"], &["provider"])
                && id(&v["taskId"])
                && repos(&v["repos"], true)
                && (v["org"] == "" || git_organization(&v["org"]))
                && optional(v, "provider", |x| {
                    choice(x, &["github", "gitlab", "forgejo"])
                })
        }
        "worktree:cleanup" => {
            object(v, &["taskId", "repos", "org"], &["removeTaskDir"])
                && id(&v["taskId"])
                && repos(&v["repos"], false)
                && (v["org"] == "" || git_organization(&v["org"]))
                && optional(v, "removeTaskDir", Value::is_boolean)
        }
        _ => false,
    }
}
fn log(v: &Value) -> bool {
    object(
        v,
        &[
            "id",
            "task_id",
            "status",
            "summary",
            "session_id",
            "created_at",
        ],
        &[],
    ) && id(&v["id"])
        && id(&v["task_id"])
        && choice(&v["status"], &["ok", "info", "attention_needed", "error"])
        && nullable(&v["summary"], |x| {
            text(x, 16000, true) && x.as_str().is_some_and(|s| s.encode_utf16().count() <= 4000)
        })
        && nullable(&v["session_id"], |x| {
            text(x, 2048, true) && x.as_str().is_some_and(|s| s.encode_utf16().count() <= 512)
        })
        && date(&v["created_at"])
}
fn errors(v: &Value, busy: bool) -> bool {
    list(v, 128, |x| {
        x == CLEANUP_ERROR || busy && x == "Cleanup is already in progress"
    })
}
fn row(v: &Value, diff: bool) -> bool {
    object(
        v,
        if diff {
            &["repo", "diff"]
        } else {
            &["repo", "allFiles"]
        },
        if diff {
            &[
                "allFiles",
                "workspace",
                "error",
                "noWorktree",
                "path",
                "branch",
                "pushed",
                "prNumber",
                "prUrl",
                "prState",
                "prTitle",
                "ciStatus",
            ]
        } else {
            &["workspace", "error", "noWorktree", "path"]
        },
    ) && (git_repository(&v["repo"]) || v["repo"] == "Task workspace" && v["workspace"] == true)
        && (!diff || text(&v["diff"], 131072, false))
        && optional(v, "allFiles", |x| list(x, 4096, file) && unique(x, None))
        && ["workspace", "noWorktree", "pushed"]
            .iter()
            .all(|k| optional(v, k, Value::is_boolean))
        && optional(v, "error", |x| x == WORKTREE_ERROR)
        && optional(v, "path", workspace_file_path)
        && optional(v, "branch", branch)
        && optional(v, "prNumber", |x| integer(x) && x != 0)
        && optional(v, "prUrl", git_address)
        && optional(v, "prState", |x| {
            choice(
                x,
                &[
                    "OPEN", "CLOSED", "MERGED", "open", "closed", "merged", "locked",
                ],
            )
        })
        && optional(v, "prTitle", |x| label(x, 4096))
        && optional(v, "ciStatus", |x| {
            choice(x, &["passing", "failing", "pending", "none"])
        })
}
pub fn result(op: &str, wire: &Value) -> bool {
    if !bounded_bytes(wire, 900000) {
        return false;
    }
    if op == "worktree:cleanup" {
        return object(wire, &["defined"], &[]) && wire["defined"] == false;
    }
    if matches!(
        op,
        "heartbeat:enable" | "heartbeat:disable" | "heartbeat:updateInterval"
    ) && wire["defined"] == false
    {
        return object(wire, &["defined"], &[]);
    }
    if !object(wire, &["defined", "value"], &[]) || wire["defined"] != true {
        return false;
    }
    let v = &wire["value"];
    match op {
        "heartbeat:enable" | "heartbeat:disable" | "heartbeat:updateInterval" => {
            super::project_groups::task(v)
        }
        "heartbeat:runNow" => choice(v, &["sent", "no_file", "no_agent", "in_progress", "error"]),
        "heartbeat:getLogs" => list(v, 128, log),
        "heartbeat:readFile" => nullable(v, |x| text(x, 131072, true)),
        "heartbeat:getStatus" => {
            v.is_null()
                || object(
                    v,
                    &[
                        "enabled",
                        "intervalMinutes",
                        "lastCheckAt",
                        "nextCheckAt",
                        "hasHeartbeatFile",
                    ],
                    &[],
                ) && v["enabled"].is_boolean()
                    && nullable(&v["intervalMinutes"], interval)
                    && nullable(&v["lastCheckAt"], date)
                    && nullable(&v["nextCheckAt"], date)
                    && v["hasHeartbeatFile"].is_boolean()
        }
        "heartbeat:writeFile" => v.is_boolean(),
        "worktree:setup" => workspace_file_path(v),
        "worktree:readFile" => {
            v.is_null()
                || object(v, &["content", "size", "binary", "truncated"], &[])
                    && text(&v["content"], 131072, false)
                    && integer(&v["size"])
                    && v["binary"].is_boolean()
                    && v["truncated"].is_boolean()
                    && (v["binary"] != true || v["content"] == "")
        }
        "worktree:changes" | "worktree:files" => {
            bounded_bytes(wire, 889999)
                && list(v, 129, |x| row(x, op == "worktree:changes"))
                && unique(v, Some("repo"))
        }
        "workspace:runCleanupNow" => {
            object(v, &["cleaned", "errors", "nodeModulesCleaned"], &[])
                && integer(&v["cleaned"])
                && integer(&v["nodeModulesCleaned"])
                && errors(&v["errors"], true)
        }
        _ => false,
    }
}
pub fn event(op: &str, v: &Value) -> bool {
    if !bounded_bytes(v, 889999) {
        return false;
    }
    match op {
        "heartbeat:alert" => {
            object(v, &["taskId", "title", "summary"], &[])
                && id(&v["taskId"])
                && utf16_text(&v["title"], 4096)
                && utf16_text(&v["summary"], 500)
        }
        "heartbeat:disabled" => {
            object(v, &["taskId", "reason"], &[])
                && id(&v["taskId"])
                && utf16_text(&v["reason"], 128)
        }
        "worktree:progress" => {
            object(v, &["taskId", "repo", "step", "done"], &["error"])
                && id(&v["taskId"])
                && label(&v["repo"], 512)
                && choice(
                    &v["step"],
                    &["cloning", "fetching", "creating worktree", "done", "error"],
                )
                && v["done"].is_boolean()
                && optional(v, "error", |x| x == WORKTREE_ERROR)
        }
        "workspace:cleanup-complete" => {
            object(v, &["cleaned", "errors"], &[])
                && integer(&v["cleaned"])
                && errors(&v["errors"], false)
        }
        "workspace:cleanup-progress" => {
            object(
                v,
                &["phase", "current", "total"],
                &["message", "cleaned", "nodeModulesCleaned", "errors"],
            ) && choice(
                &v["phase"],
                &["starting", "scanning", "cleaning", "pruning", "done"],
            ) && integer(&v["current"])
                && integer(&v["total"])
                && optional(v, "message", |x| label(x, 4096))
                && ["cleaned", "nodeModulesCleaned"]
                    .iter()
                    .all(|k| optional(v, k, integer))
                && optional(v, "errors", |x| errors(x, false))
        }
        _ => false,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn finite_requests_refuse_authority_and_escape_paths() {
        for op in COMMANDS {
            assert!(
                !request(op, &json!({"taskId":"task_fixture","nativeGrant":true})),
                "{op}"
            );
        }
        assert!(request(
            "heartbeat:writeFile",
            &json!({"taskId":"task_fixture","content":"Check local state 🌱"})
        ));
        assert!(!request(
            "heartbeat:enable",
            &json!({"taskId":"task_fixture","intervalMinutes":0})
        ));
        for path in [
            "../escape",
            "/absolute",
            "C:\\escape",
            "safe/../escape",
            "a//b",
        ] {
            assert!(!request(
                "worktree:readFile",
                &json!({"taskId":"task_fixture","repoFullName":null,"filePath":path})
            ));
        }
        assert!(request(
            "worktree:setup",
            &json!({"taskId":"task_fixture","repos":[{"fullName":"fixture/repo","defaultBranch":"main"}],"org":"fixture","provider":"github"})
        ));
    }
    #[test]
    fn finite_results_and_existing_events_preserve_shapes() {
        assert!(result(
            "worktree:readFile",
            &json!({"defined":true,"value":{"content":"","size":3,"binary":true,"truncated":false}})
        ));
        assert!(!result(
            "worktree:readFile",
            &json!({"defined":true,"value":{"content":"decoded binary","size":3,"binary":true,"truncated":false}})
        ));
        assert!(result(
            "workspace:runCleanupNow",
            &json!({"defined":true,"value":{"cleaned":0,"errors":[],"nodeModulesCleaned":0}})
        ));
        assert!(result("heartbeat:disable", &json!({"defined":false})));
        assert!(!result(
            "heartbeat:runNow",
            &json!({"defined":true,"value":"uncertain"})
        ));
        assert!(event(
            "worktree:progress",
            &json!({"taskId":"task_fixture","repo":"fixture/repo","step":"done","done":true})
        ));
        assert!(!event(
            "workspace:cleanup-complete",
            &json!({"cleaned":0,"errors":["raw credential stderr"]})
        ));
    }
    #[test]
    fn actual_owned_results_have_finite_outer_dtos() {
        let Ok(path) = std::env::var("TWENTYONEX_WORKSPACE_RUNTIME_RESULTS") else {
            return;
        };
        let bytes = std::fs::read(path).unwrap();
        assert!(bytes.len() < 16000000);
        let corpus: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(corpus["version"], 1);
        let rows = corpus["responses"].as_array().unwrap();
        assert_eq!(rows.len(), COMMANDS.len());
        for row in rows {
            let op = row["operation"].as_str().unwrap();
            assert!(COMMANDS.contains(&op));
            assert!(result(op, &row["wire"]), "{op}: {}", row["wire"]);
        }
    }
}
