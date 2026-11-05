//! Finite UI intents and passive snapshots. No element, window, path or caller grants.
use super::production::contracts::{id, object, text};
use serde_json::Value;
use std::collections::HashSet;

pub const MAX_BYTES: usize = 256 * 1024;
const VIEWS: &[&str] = &["dashboard", "tasks", "skills", "settings"];
const STATE_VIEWS: &[&str] = &[
    "dashboard",
    "tasks",
    "skills",
    "settings",
    "commander",
    "overview",
];
const TABS: &[&str] = &[
    "general",
    "projects",
    "agents",
    "tools-mcp",
    "secrets",
    "voice",
    "integrations",
    "plugins",
    "advanced",
];
fn member(value: &Value, values: &[&str]) -> bool {
    value.as_str().is_some_and(|s| values.contains(&s))
}
fn bounded(value: &Value) -> bool {
    serde_json::to_vec(value).is_ok_and(|v| v.len() <= MAX_BYTES)
}
fn identifier(value: &Value, limit: usize) -> bool {
    text(value, limit)
        && value
            .as_str()
            .is_some_and(|s| !s.is_empty() && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}'))
}
fn nullable_id(value: &Value) -> bool {
    value.is_null() || id(value)
}
pub fn lease_id(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 128
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b':' | b'-'))
    })
}
pub fn state(value: &Value) -> bool {
    if !bounded(value)
        || !object(
            value,
            &[
                "view",
                "projectId",
                "modal",
                "selectedTaskId",
                "selectedTaskTitle",
                "dashboardPreviewTaskId",
                "captainOpen",
                "settingsTab",
                "waitingForYou",
                "visibleTaskIds",
            ],
            &[],
        )
        || !member(&value["view"], STATE_VIEWS)
        || !id(&value["projectId"])
        || !(value["modal"].is_null()
            || member(
                &value["modal"],
                &[
                    "create",
                    "edit",
                    "delete",
                    "settings",
                    "repo-selector",
                    "gh-setup",
                ],
            ))
        || !nullable_id(&value["selectedTaskId"])
        || !(value["selectedTaskTitle"].is_null() || text(&value["selectedTaskTitle"], 4096))
        || !nullable_id(&value["dashboardPreviewTaskId"])
        || !value["captainOpen"].is_boolean()
        || !value["waitingForYou"].is_boolean()
        || !(value["settingsTab"].is_null() || member(&value["settingsTab"], TABS))
    {
        return false;
    }
    let Some(tasks) = value["visibleTaskIds"].as_array() else {
        return false;
    };
    tasks.len() <= 50
        && tasks.iter().all(id)
        && tasks
            .iter()
            .filter_map(Value::as_str)
            .collect::<HashSet<_>>()
            .len()
            == tasks.len()
}
pub fn command(value: &Value) -> bool {
    if !bounded(value) {
        return false;
    }
    match value["kind"].as_str() {
        Some("navigate") => {
            object(value, &["kind", "view"], &["settingsTab"])
                && member(&value["view"], VIEWS)
                && value.get("settingsTab").is_none_or(|v| member(v, TABS))
        }
        Some("switch_project") => {
            object(value, &["kind", "projectId"], &[]) && id(&value["projectId"])
        }
        Some("open_task") => {
            object(value, &["kind", "taskId", "where"], &[])
                && id(&value["taskId"])
                && member(&value["where"], &["workspace", "modal"])
        }
        Some("open_artifact") => {
            object(value, &["kind", "taskId", "artifactId"], &[])
                && id(&value["taskId"])
                && identifier(&value["artifactId"], 128)
        }
        _ => false,
    }
}
pub fn publish_request(value: &Value) -> bool {
    object(value, &["state"], &[]) && bounded(value) && state(&value["state"])
}
pub fn void_result(value: &Value) -> bool {
    object(value, &["defined"], &[]) && value["defined"] == false
}
pub fn private_publish_request(value: &Value) -> bool {
    object(value, &["state", "leaseId"], &[])
        && state(&value["state"])
        && lease_id(&value["leaseId"])
}
pub fn snapshot_request(value: &Value) -> bool {
    object(value, &[], &[])
}
pub fn snapshot_result(value: &Value) -> bool {
    (object(value, &["available"], &[]) && value["available"] == false)
        || (object(value, &["available", "leaseId"], &[])
            && value["available"] == true
            && lease_id(&value["leaseId"]))
}
pub fn command_request(value: &Value) -> bool {
    object(value, &["command", "leaseId"], &[])
        && command(&value["command"])
        && lease_id(&value["leaseId"])
}
pub fn command_result(value: &Value) -> bool {
    (object(value, &["ok", "leaseId"], &[]) && value["ok"] == true && lease_id(&value["leaseId"]))
        || (object(value, &["ok", "detail"], &[])
            && value["ok"] == false
            && text(&value["detail"], 256))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    pub(crate) fn fixture() -> Value {
        json!({"view":"dashboard","projectId":"project_1","modal":null,"selectedTaskId":"task_1","selectedTaskTitle":"Title\nnext","dashboardPreviewTaskId":null,"captainOpen":true,"settingsTab":null,"waitingForYou":false,"visibleTaskIds":["task_1"]})
    }
    #[test]
    fn full_snapshot_is_passive_exact_and_bounded() {
        let good = fixture();
        assert!(state(&good));
        assert!(publish_request(&json!({"state":good})));
        for key in ["caller", "window", "path", "leaseId"] {
            let mut bad = fixture();
            bad[key] = json!("grant");
            assert!(!state(&bad));
        }
        let mut duplicate = fixture();
        duplicate["visibleTaskIds"] = json!(["task_1", "task_1"]);
        assert!(!state(&duplicate));
        let mut oversized = fixture();
        oversized["selectedTaskTitle"] = json!("x".repeat(4097));
        assert!(!state(&oversized));
        let mut nul = fixture();
        nul["selectedTaskTitle"] = json!("a\u{0000}b");
        assert!(!state(&nul));
        let mut unicode = fixture();
        unicode["selectedTaskTitle"] = json!("🧭".repeat(2048));
        assert!(state(&unicode));
        unicode["selectedTaskTitle"] = json!("🧭".repeat(2049));
        assert!(!state(&unicode));
    }
    #[test]
    fn finite_commands_cannot_grant_elements_paths_or_browser_control() {
        let cases = [
            json!({"kind":"navigate","view":"settings","settingsTab":"voice"}),
            json!({"kind":"switch_project","projectId":"project"}),
            json!({"kind":"open_task","taskId":"task","where":"modal"}),
            json!({"kind":"open_artifact","taskId":"task","artifactId":"artifact:1"}),
        ];
        for good in cases {
            assert!(command(&good));
            let mut bad = good;
            bad["caller"] = json!("main");
            assert!(!command(&bad));
        }
        for bad in [
            json!({"kind":"navigate","view":"commander"}),
            json!({"kind":"open_task","taskId":"task","where":"auto"}),
            json!({"kind":"set_canvas_view","mode":"reset"}),
            json!({"kind":"move_task_panel","taskId":"task","x":0,"y":0}),
            json!({"kind":"close_task_panel","taskId":"task"}),
            json!({"kind":"open_task","taskId":"task","where":"canvas"}),
            json!({"kind":"navigate","view":"canvas"}),
            json!({"kind":"open_browser","url":"https://example.com"}),
            json!({"kind":"open_artifact","taskId":"task","artifactId":"a\n"}),
        ] {
            assert!(!command(&bad));
        }
    }
    #[test]
    fn private_leases_and_results_do_not_expand_public_ingress() {
        assert!(snapshot_request(&json!({})));
        assert!(!snapshot_request(&json!({"caller":"main"})));
        assert!(snapshot_result(&json!({"available":false})));
        assert!(snapshot_result(&json!({"available":true,"leaseId":"ui:1"})));
        assert!(!snapshot_result(
            &json!({"available":false,"leaseId":"ui:1"})
        ));
        let command = json!({"kind":"open_task","taskId":"task","where":"workspace"});
        assert!(command_request(
            &json!({"command":command,"leaseId":"ui:1"})
        ));
        assert!(!command_request(
            &json!({"command":command,"leaseId":"../foreign"})
        ));
        assert!(command_result(&json!({"ok":true,"leaseId":"ui:1"})));
        assert!(command_result(&json!({"ok":false,"detail":"Unavailable"})));
        assert!(!command_result(
            &json!({"ok":true,"leaseId":"ui:1","applied":true})
        ));
        assert!(!command_result(
            &json!({"ok":false,"detail":"x".repeat(257)})
        ));
        assert!(private_publish_request(
            &json!({"state":fixture(),"leaseId":"ui:1"})
        ));
        assert!(!publish_request(
            &json!({"state":fixture(),"leaseId":"ui:1"})
        ));
        assert!(!crate::production::contracts::COMMANDS.contains(&"engine.ui.publish"));
        assert!(!crate::production::contracts::valid_request(
            "engine.ui.publish",
            &json!({"state":fixture(),"leaseId":"ui:1"})
        ));
        assert!(crate::production::contracts::valid_request(
            "ui:publishState",
            &json!({"state":fixture()})
        ));
        assert!(crate::production::contracts::valid_event(
            "ui:command",
            &json!({"kind":"open_task","taskId":"task","where":"workspace"})
        ));
        assert!(void_result(&json!({"defined":false})));
        assert!(!void_result(&json!({"defined":true,"value":null})));
    }
}
