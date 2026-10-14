//! Finite preference DTOs. Native window/tray ownership selects effects.
use crate::production::contracts::object;
use crate::production_ui_contracts::lease_id;
use serde_json::Value;
pub const COMMANDS: &[&str] = &["app:getMinimizeToTray", "app:setMinimizeToTray"];
pub fn request(operation: &str, value: &Value) -> bool {
    match operation {
        "app:getMinimizeToTray" => object(value, &[], &[]),
        "app:setMinimizeToTray" => {
            object(value, &["enabled"], &[]) && value["enabled"].is_boolean()
        }
        _ => false,
    }
}
pub fn result(value: &Value) -> bool {
    object(value, &["defined", "value"], &[])
        && value["defined"] == true
        && value["value"].is_boolean()
}
pub fn preference(value: &Value) -> bool {
    object(value, &["enabled"], &[]) && value["enabled"].is_boolean()
}
pub fn private_command(value: &Value) -> bool {
    object(value, &["operation", "payload", "leaseId"], &[])
        && lease_id(&value["leaseId"])
        && value["operation"]
            .as_str()
            .is_some_and(|op| request(op, &value["payload"]))
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn only_boolean_preferences_cross_the_exact_current_document_envelope() {
        assert!(request(COMMANDS[0], &json!({})));
        for enabled in [true, false] {
            assert!(request(COMMANDS[1], &json!({"enabled":enabled})));
            assert!(result(&json!({"defined":true,"value":enabled})));
            assert!(private_command(
                &json!({"operation":COMMANDS[1],"payload":{"enabled":enabled},"leaseId":"ui_fixture"})
            ));
        }
        for value in [
            json!({"enabled":"true"}),
            json!({"enabled":true,"action":"quit"}),
            json!({"enabled":true,"path":"/private"}),
        ] {
            assert!(!request(COMMANDS[1], &value));
        }
        assert!(!private_command(
            &json!({"operation":"app:quit","payload":{},"leaseId":"ui_fixture"})
        ));
        assert!(!private_command(
            &json!({"operation":COMMANDS[0],"payload":{},"leaseId":"\n"})
        ));
        assert!(!result(&json!({"defined":false})));
        assert!(!preference(&json!({"enabled":true,"action":"hide"})));
    }
}
