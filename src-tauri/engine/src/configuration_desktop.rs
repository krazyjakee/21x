//! Content-only synthetic profile policy. Agent CRUD and lifecycle settings
//! remain unbound. Keep aligned with configuration-desktop-codecs.ts.
use super::desktop::{array, cursor, id, member, nonempty, object, project, text};
use serde_json::Value;
use std::collections::HashSet;

const OPERATIONS: &[&str] = &[
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
];
fn nullable(value: &Value, check: fn(&Value) -> bool) -> bool {
    value.is_null() || check(value)
}
fn unique_ids(value: &Value) -> bool {
    array(value, id)
        && value.as_array().is_some_and(|items| {
            let mut seen = HashSet::new();
            items.iter().all(|item| seen.insert(item.as_str().unwrap()))
        })
}
fn positive(value: &Value) -> bool {
    cursor(value) && value.as_u64().unwrap() > 0
}
fn tags(value: &Value) -> bool {
    array(value, |item| text(item, 256))
}
fn confidence(value: &Value) -> bool {
    value.as_f64().is_some_and(|n| (0.0..=1.0).contains(&n))
}
fn skill_input(value: &Value, create: bool) -> bool {
    object(
        value,
        if create {
            &["name", "description", "content"]
        } else {
            &[]
        },
        if create {
            &[
                "name",
                "description",
                "content",
                "confidence",
                "uses",
                "last_used",
                "tags",
                "preferred_model",
                "project_id",
            ]
        } else {
            &[
                "name",
                "description",
                "content",
                "confidence",
                "uses",
                "last_used",
                "tags",
                "preferred_model",
                "expected_version",
            ]
        },
    ) && value
        .as_object()
        .unwrap()
        .iter()
        .all(|(key, item)| match key.as_str() {
            "name" => nonempty(item, 512),
            "description" => text(item, 65_536),
            "content" => text(item, 131_072),
            "confidence" => confidence(item),
            "uses" => cursor(item),
            "last_used" => nullable(item, |v| text(v, 128)),
            "tags" => tags(item),
            "preferred_model" => nullable(item, |v| text(v, 256)),
            "project_id" => nullable(item, id),
            "expected_version" => positive(item),
            _ => false,
        })
}
fn skill(value: &Value) -> bool {
    object(
        value,
        &[
            "id",
            "name",
            "description",
            "content",
            "version",
            "confidence",
            "uses",
            "last_used",
            "tags",
            "preferred_model",
            "project_id",
            "created_at",
            "updated_at",
        ],
        &[],
    ) && id(&value["id"])
        && nonempty(&value["name"], 512)
        && text(&value["description"], 65_536)
        && text(&value["content"], 131_072)
        && positive(&value["version"])
        && confidence(&value["confidence"])
        && cursor(&value["uses"])
        && nullable(&value["last_used"], |v| text(v, 128))
        && tags(&value["tags"])
        && nullable(&value["preferred_model"], |v| text(v, 256))
        && nullable(&value["project_id"], id)
        && text(&value["created_at"], 128)
        && text(&value["updated_at"], 128)
}
fn provider(value: &Value) -> bool {
    member(value, &["github", "gitlab", "forgejo"])
}
fn project_input(value: &Value) -> bool {
    object(
        value,
        &[],
        &["name", "description", "git_provider", "git_org"],
    ) && value
        .as_object()
        .unwrap()
        .iter()
        .all(|(key, item)| match key.as_str() {
            "name" => nonempty(item, 512),
            "description" => text(item, 65_536),
            "git_provider" => nullable(item, provider),
            "git_org" => nullable(item, |v| text(v, 512)),
            _ => false,
        })
}
fn repo_input(value: &Value, create: bool) -> bool {
    object(
        value,
        if create { &["name"] } else { &[] },
        &["name", "provider", "org", "default_branch"],
    ) && value
        .as_object()
        .unwrap()
        .iter()
        .all(|(key, item)| match key.as_str() {
            "name" => nonempty(item, 512),
            "provider" => provider(item),
            "org" => text(item, 512),
            "default_branch" => nullable(item, |v| text(v, 512)),
            _ => false,
        })
}
fn repo(value: &Value) -> bool {
    object(
        value,
        &[
            "id",
            "project_id",
            "name",
            "provider",
            "org",
            "default_branch",
            "sort_order",
            "created_at",
        ],
        &[],
    ) && id(&value["id"])
        && id(&value["project_id"])
        && nonempty(&value["name"], 512)
        && provider(&value["provider"])
        && text(&value["org"], 512)
        && nullable(&value["default_branch"], |v| text(v, 512))
        && cursor(&value["sort_order"])
        && text(&value["created_at"], 128)
}
fn resource_input(value: &Value, create: bool) -> bool {
    object(
        value,
        if create { &["label"] } else { &[] },
        &["label", "url", "notes"],
    ) && value
        .as_object()
        .unwrap()
        .iter()
        .all(|(key, item)| match key.as_str() {
            "label" => nonempty(item, 512),
            "url" => nullable(item, |v| text(v, 4096)),
            "notes" => text(item, 65_536),
            _ => false,
        })
}
fn resource(value: &Value) -> bool {
    object(
        value,
        &[
            "id",
            "project_id",
            "label",
            "url",
            "notes",
            "sort_order",
            "created_at",
        ],
        &[],
    ) && id(&value["id"])
        && id(&value["project_id"])
        && nonempty(&value["label"], 512)
        && nullable(&value["url"], |v| text(v, 4096))
        && text(&value["notes"], 65_536)
        && cursor(&value["sort_order"])
        && text(&value["created_at"], 128)
}
fn private_fields(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(private_fields),
        Value::Object(map) => map.iter().any(|(key, child)| {
            key == "api_keys"
                || key == "mcp_scope_nonce"
                || key.ends_with("_api_key")
                || private_fields(child)
        }),
        _ => false,
    }
}
pub(super) fn known_operation(operation: &str) -> bool {
    OPERATIONS.contains(&operation)
}
pub(super) fn valid_request(operation: &str, value: &Value) -> bool {
    match operation {
        "skills:getAll" => object(value, &[], &[]),
        "skills:create" => object(value, &["data"], &[]) && skill_input(&value["data"], true),
        "skills:update" => {
            object(value, &["id", "data"], &[])
                && id(&value["id"])
                && skill_input(&value["data"], false)
        }
        "skills:delete" | "projectRepo:remove" | "projectResource:remove" => {
            object(value, &["id"], &[]) && id(&value["id"])
        }
        "skills:setProject" => {
            object(value, &["id", "projectId"], &[])
                && id(&value["id"])
                && nullable(&value["projectId"], id)
        }
        "project:update" => {
            object(value, &["id", "data"], &[]) && id(&value["id"]) && project_input(&value["data"])
        }
        "project:archive" => {
            object(value, &["id"], &["archived"])
                && id(&value["id"])
                && value.get("archived").is_none_or(Value::is_boolean)
        }
        "project:reorder" => {
            object(value, &["orderedIds"], &[]) && unique_ids(&value["orderedIds"])
        }
        "projectRepo:list" | "projectResource:list" => {
            object(value, &["projectId"], &[]) && id(&value["projectId"])
        }
        "projectRepo:add" => {
            object(value, &["projectId", "data"], &[])
                && id(&value["projectId"])
                && repo_input(&value["data"], true)
        }
        "projectResource:add" => {
            object(value, &["projectId", "data"], &[])
                && id(&value["projectId"])
                && resource_input(&value["data"], true)
        }
        "projectRepo:update" => {
            object(value, &["id", "data"], &[])
                && id(&value["id"])
                && repo_input(&value["data"], false)
        }
        "projectResource:update" => {
            object(value, &["id", "data"], &[])
                && id(&value["id"])
                && resource_input(&value["data"], false)
        }
        "projectRepo:reorder" | "projectResource:reorder" => {
            object(value, &["projectId", "orderedIds"], &[])
                && id(&value["projectId"])
                && unique_ids(&value["orderedIds"])
        }
        _ => false,
    }
}
pub(super) fn valid_result(operation: &str, value: &Value) -> bool {
    if !known_operation(operation) || !object(value, &["defined"], &["value"]) {
        return false;
    }
    if value["defined"] == false {
        return value.get("value").is_none()
            && matches!(
                operation,
                "skills:update"
                    | "skills:setProject"
                    | "project:reorder"
                    | "projectRepo:add"
                    | "projectRepo:update"
                    | "projectRepo:reorder"
                    | "projectResource:add"
                    | "projectResource:update"
                    | "projectResource:reorder"
            );
    }
    if value["defined"] != true || value.get("value").is_none() {
        return false;
    }
    let result = &value["value"];
    match operation {
        "skills:getAll" => array(result, skill),
        "skills:create" | "skills:update" | "skills:setProject" => skill(result),
        "skills:delete" | "projectRepo:remove" | "projectResource:remove" => result.is_boolean(),
        "project:update" | "project:archive" => project(result) && !private_fields(result),
        "projectRepo:list" => array(result, repo),
        "projectRepo:add" | "projectRepo:update" => repo(result),
        "projectResource:list" => array(result, resource),
        "projectResource:add" | "projectResource:update" => resource(result),
        _ => false,
    }
}
pub(super) fn valid_event(frame: &Value) -> bool {
    frame["operation"] == "skills:changed"
        && object(&frame["payload"], &["skillId", "kind"], &[])
        && id(&frame["payload"]["skillId"])
        && member(
            &frame["payload"]["kind"],
            &["created", "updated", "removed", "scope"],
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn content_requests_reject_lifecycle_credentials_and_foreign_fields() {
        assert_eq!(OPERATIONS.len(), 18);
        assert!(!known_operation("agent:create"));
        assert!(valid_request(
            "skills:create",
            &json!({"data":{"name":"Fixture", "description":"", "content":"instructions"}})
        ));
        for bad in [
            json!({"settings":{}}),
            json!({"captain_agent_id":"agent"}),
            json!({"api_keys":{}}),
            json!({"name":"\u{00a0}"}),
        ] {
            assert!(!valid_request(
                "project:update",
                &json!({"id":"project", "data":bad})
            ));
        }
        assert!(!valid_request(
            "skills:update",
            &json!({"id":"skill", "data":{"project_id":"other"}})
        ));
        assert!(!valid_request(
            "skills:update",
            &json!({"id":"skill", "data":{"expected_version":0}})
        ));
        assert!(!valid_request(
            "projectRepo:reorder",
            &json!({"projectId":"project", "orderedIds":["repo", "repo"]})
        ));
        assert!(!valid_request(
            "projectResource:add",
            &json!({"projectId":"project", "data":{"label":"Fixture", "path":"/private"}})
        ));
        assert!(!valid_request(
            "projectResource:add",
            &json!({"projectId":"project", "data":{"label":"🚀".repeat(257)}})
        ));
    }
    #[test]
    fn content_results_preserve_void_and_missing_and_bound_public_records() {
        for operation in [
            "project:reorder",
            "skills:update",
            "projectRepo:update",
            "projectResource:reorder",
        ] {
            assert!(valid_result(operation, &json!({"defined":false})));
            assert!(!valid_result(
                operation,
                &json!({"defined":false, "value":null})
            ));
        }
        assert!(!valid_result("skills:create", &json!({"defined":false})));
        let repo = json!({"id":"repo", "project_id":"project", "name":"fixture", "provider":"github", "org":"test", "default_branch":null, "sort_order":0, "created_at":"now"});
        assert!(valid_result(
            "projectRepo:add",
            &json!({"defined":true, "value":repo})
        ));
        let mut private = repo;
        private["credential"] = json!("forbidden");
        assert!(!valid_result(
            "projectRepo:add",
            &json!({"defined":true, "value":private})
        ));
        assert!(valid_event(
            &json!({"operation":"skills:changed", "payload":{"skillId":"skill", "kind":"scope"}})
        ));
        assert!(!valid_event(
            &json!({"operation":"skills:changed", "payload":{"skillId":"skill", "kind":"scope", "content":"private"}})
        ));
    }
}
