//! Fixed CLI installer wire policy. Native ingress never chooses a program,
//! argument, destination, credential, environment, profile or document grant.
use super::{bounded_bytes, detection_result, object, DETECTION_KEYS};
use crate::production_ui_contracts;
use serde_json::Value;

pub const OPERATION: &str = "agent-installer:install";
pub const EVENT: &str = "agent-installer:progress";
const ERRORS: &[&str] = &[
    "CLI installation is unavailable in this desktop host.",
    "This CLI does not have a portable installation plan.",
    "CLI installation failed.",
    "The installed CLI could not be verified.",
    "The installed Pi CLI is unsupported.",
    "The Pi MCP adapter could not be verified.",
];
fn name(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|name| DETECTION_KEYS.contains(&name))
}
pub fn request(value: &Value) -> bool {
    object(value, &["agentName"], &[]) && name(&value["agentName"])
}
pub fn private_request(value: &Value) -> bool {
    object(value, &["agentName", "leaseId"], &[])
        && name(&value["agentName"])
        && production_ui_contracts::lease_id(&value["leaseId"])
}
fn install_result(value: &Value) -> bool {
    object(value, &["success", "error", "newStatus"], &[])
        && value["success"].as_bool().is_some_and(|success| {
            if success {
                value["error"].is_null()
            } else {
                value["error"]
                    .as_str()
                    .is_some_and(|error| ERRORS.contains(&error))
            }
        })
        && detection_result(&value["newStatus"])
        && bounded_bytes(value, 8192)
}
pub fn result(value: &Value) -> bool {
    object(value, &["defined", "value"], &[])
        && value["defined"] == true
        && install_result(&value["value"])
}
pub fn progress(value: &Value) -> bool {
    if !object(value, &["agentName", "stage", "output", "percent"], &[])
        || !name(&value["agentName"])
        || !bounded_bytes(value, 1024)
    {
        return false;
    }
    let (output, percent) = match value["stage"].as_str() {
        Some("starting") => ("Preparing CLI installation.", 5.),
        Some("installing") => ("Installing the selected CLI.", 50.),
        Some("verifying") => ("Checking the installed CLI.", 90.),
        Some("complete") => ("CLI installation complete.", 100.),
        Some("error") => ("CLI installation failed.", 100.),
        _ => return false,
    };
    value["output"] == output && value["percent"].as_f64() == Some(percent)
}
pub fn progress_request(value: &Value) -> bool {
    object(value, &["progress", "leaseId"], &[])
        && progress(&value["progress"])
        && production_ui_contracts::lease_id(&value["leaseId"])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn detection() -> Value {
        let mut value = serde_json::Map::new();
        for key in DETECTION_KEYS {
            value.insert((*key).to_owned(), json!({"installed":false,"version":null}));
        }
        value.insert("pi".into(),json!({"installed":false,"version":null,"supported":false,"reason":"Pi CLI is not installed."}));
        value.insert("rtk".into(),json!({"installed":false,"version":null,"configured":false,"integrations":{"claudeCode":false,"opencode":false,"codex":false,"cursor":false,"pi":false}}));
        Value::Object(value)
    }
    #[test]
    fn finite_installer_requests_never_accept_programs_paths_or_public_leases() {
        for key in DETECTION_KEYS {
            assert!(request(&json!({"agentName":key})));
        }
        for value in [
            json!({"agentName":"claude-code"}),
            json!({"agentName":"codex;echo private"}),
            json!({"agentName":"codex","command":"npm"}),
            json!({"agentName":"codex","leaseId":"ui:1"}),
            json!({"agentName":"codex","profileRoot":"/tmp/foreign"}),
            json!({"agentName":"codex","environment":{}}),
        ] {
            assert!(!request(&value));
        }
        assert!(private_request(
            &json!({"agentName":"codex","leaseId":"ui:1"})
        ));
        assert!(!private_request(
            &json!({"agentName":"codex","leaseId":"../other"})
        ));
        assert!(!crate::production::contracts::COMMANDS.contains(&"engine.agent.install"));
        assert!(!crate::production::contracts::valid_request(
            "engine.agent.install",
            &json!({"agentName":"codex","leaseId":"ui:1"})
        ));
    }
    #[test]
    fn installation_results_keep_real_detection_and_fixed_errors_without_raw_output() {
        assert!(result(
            &json!({"defined":true,"value":{"success":true,"error":null,"newStatus":detection()}})
        ));
        for error in ERRORS {
            assert!(result(
                &json!({"defined":true,"value":{"success":false,"error":error,"newStatus":detection()}})
            ));
        }
        for error in ["private stdout", "unknown CLI error", "token=private"] {
            assert!(!result(
                &json!({"defined":true,"value":{"success":false,"error":error,"newStatus":detection()}})
            ));
        }
        assert!(!result(&json!({"defined":false})));
        assert!(!result(
            &json!({"defined":true,"value":{"success":true,"error":"CLI installation failed.","newStatus":detection()}})
        ));
        let mut bad = detection();
        bad["codex"]["path"] = json!("/private/bin/codex");
        assert!(!result(
            &json!({"defined":true,"value":{"success":true,"error":null,"newStatus":bad}})
        ));
        let mut bad = detection();
        bad["pi"] = json!({"installed":true,"version":"0.80.4","supported":true,"reason":null});
        assert!(!result(
            &json!({"defined":true,"value":{"success":true,"error":null,"newStatus":bad}})
        ));
    }
    #[test]
    fn progress_is_only_finite_redacted_status_not_arbitrary_log_transport() {
        for (stage, output, percent) in [
            ("starting", "Preparing CLI installation.", 5),
            ("installing", "Installing the selected CLI.", 50),
            ("verifying", "Checking the installed CLI.", 90),
            ("complete", "CLI installation complete.", 100),
            ("error", "CLI installation failed.", 100),
        ] {
            let good = json!({"agentName":"codex","stage":stage,"output":output,"percent":percent});
            assert!(progress(&good));
            assert!(crate::production::contracts::valid_event(EVENT, &good));
            assert!(progress_request(&json!({"progress":good,"leaseId":"ui:1"})));
            let mut bad = good.clone();
            bad["output"] = json!("private install output");
            assert!(!progress(&bad));
            let mut bad = good.clone();
            bad["percent"] = json!(101);
            assert!(!progress(&bad));
            let mut bad = good;
            bad["caller"] = json!("main");
            assert!(!progress(&bad));
        }
        assert!(!progress(
            &json!({"agentName":"codex","stage":"stdout","output":"token=secret","percent":50})
        ));
        assert!(!progress_request(
            &json!({"progress":{"agentName":"codex","stage":"starting","output":"Preparing CLI installation.","percent":5},"leaseId":"ui:1","window":"main"})
        ));
    }
}
