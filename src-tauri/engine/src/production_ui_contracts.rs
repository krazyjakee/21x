//! Finite UI intents and passive snapshots. No element, window, path or caller grants.
use super::production::contracts::{id, object, text};
use serde_json::Value;
use std::collections::HashSet;

pub const MAX_BYTES: usize = 256 * 1024;
const VIEWS: &[&str] = &["dashboard", "tasks", "canvas", "skills", "settings"];
const STATE_VIEWS: &[&str] = &[
    "dashboard",
    "tasks",
    "canvas",
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
fn number(value: &Value, min: f64, max: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|v| v.is_finite() && v >= min && v <= max)
}
fn coordinate(value: &Value) -> bool {
    number(value, -10_000_000., 10_000_000.)
}
fn dimension(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|v| v.is_finite() && v > 0. && v <= 1_000_000.)
}
fn zoom(value: &Value) -> bool {
    number(value, 0.1, 3.)
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
                "canvas",
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
    if tasks.len() > 50
        || !tasks.iter().all(id)
        || tasks
            .iter()
            .filter_map(Value::as_str)
            .collect::<HashSet<_>>()
            .len()
            != tasks.len()
    {
        return false;
    }
    let canvas = &value["canvas"];
    let viewport = &canvas["viewport"];
    if !object(canvas, &["viewport", "panels"], &[])
        || !object(viewport, &["x", "y", "zoom"], &[])
        || !coordinate(&viewport["x"])
        || !coordinate(&viewport["y"])
        || !zoom(&viewport["zoom"])
    {
        return false;
    }
    let Some(panels) = canvas["panels"].as_array() else {
        return false;
    };
    panels.len() <= 50
        && panels.iter().all(|panel| {
            object(
                panel,
                &[
                    "panelId", "type", "taskId", "title", "x", "y", "width", "height",
                ],
                &[],
            ) && identifier(&panel["panelId"], 256)
                && member(
                    &panel["type"],
                    &[
                        "task",
                        "transcript",
                        "terminal",
                        "placeholder",
                        "webpage",
                        "browser",
                    ],
                )
                && nullable_id(&panel["taskId"])
                && text(&panel["title"], 4096)
                && coordinate(&panel["x"])
                && coordinate(&panel["y"])
                && dimension(&panel["width"])
                && dimension(&panel["height"])
        })
        && panels
            .iter()
            .filter_map(|p| p["panelId"].as_str())
            .collect::<HashSet<_>>()
            .len()
            == panels.len()
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
                && member(&value["where"], &["workspace", "canvas", "modal"])
        }
        Some("move_task_panel") => {
            object(value, &["kind", "taskId", "x", "y"], &[])
                && id(&value["taskId"])
                && coordinate(&value["x"])
                && coordinate(&value["y"])
        }
        Some("close_task_panel") => object(value, &["kind", "taskId"], &[]) && id(&value["taskId"]),
        Some("set_canvas_view") => {
            object(value, &["kind", "mode"], &["zoom"])
                && if value["mode"] == "zoom" {
                    zoom(&value["zoom"])
                } else {
                    member(&value["mode"], &["fit_all", "reset"]) && value.get("zoom").is_none()
                }
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
        json!({"view":"canvas","projectId":"project_1","modal":null,"selectedTaskId":"task_1","selectedTaskTitle":"Title\nnext","dashboardPreviewTaskId":null,"captainOpen":true,"settingsTab":null,"waitingForYou":false,"visibleTaskIds":["task_1"],"canvas":{"viewport":{"x":-1,"y":2,"zoom":0.1},"panels":[{"panelId":"panel:1","type":"task","taskId":"task_1","title":"Task","x":0,"y":0,"width":100,"height":200}]}})
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
        let mut duplicate = fixture();
        let panel = duplicate["canvas"]["panels"][0].clone();
        duplicate["canvas"]["panels"]
            .as_array_mut()
            .unwrap()
            .push(panel);
        assert!(!state(&duplicate));
        let mut bound = fixture();
        bound["canvas"]["viewport"]["zoom"] = json!(3.0001);
        assert!(!state(&bound));
        let mut inert = fixture();
        inert["canvas"]["panels"][0]["type"] = json!("browser");
        assert!(state(&inert));
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
        let mut aggregate = fixture();
        aggregate["canvas"]["panels"]=Value::Array((0..50).map(|index| json!({"panelId":format!("panel:{index}"),"type":"task","taskId":"task","title":"🧭".repeat(2048),"x":0,"y":0,"width":100,"height":200})).collect());
        assert!(!state(&aggregate));
    }
    #[test]
    fn finite_commands_cannot_grant_elements_paths_or_browser_control() {
        let cases = [
            json!({"kind":"navigate","view":"settings","settingsTab":"voice"}),
            json!({"kind":"switch_project","projectId":"project"}),
            json!({"kind":"open_task","taskId":"task","where":"modal"}),
            json!({"kind":"move_task_panel","taskId":"task","x":-10000000,"y":10000000}),
            json!({"kind":"close_task_panel","taskId":"task"}),
            json!({"kind":"set_canvas_view","mode":"zoom","zoom":3}),
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
            json!({"kind":"set_canvas_view","mode":"reset","zoom":1}),
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
        let command = json!({"kind":"close_task_panel","taskId":"task"});
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
            &json!({"kind":"close_task_panel","taskId":"task"})
        ));
        assert!(void_result(&json!({"defined":false})));
        assert!(!void_result(&json!({"defined":true,"value":null})));
    }
}
