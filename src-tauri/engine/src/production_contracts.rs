//! Finite production ingress/egress policy, independent of diagnostic grants.
//! Native bounds/outer DTO checks complement the service's exact domain codecs.
use serde_json::Value;

pub const COMMANDS: &[&str] = &[
    "tasks:getWorkspaceDir",
    "shell:readTextFile",
    "shell:openPath",
    "shell:showItemInFolder",
    "github:checkCli",
    "github:fetchOrgs",
    "github:fetchOrgRepos",
    "github:fetchUserRepos",
    "github:fetchPullRequestDetails",
    "gitlab:checkCli",
    "gitlab:fetchOrgs",
    "gitlab:fetchOrgRepos",
    "gitlab:fetchUserRepos",
    "forgejo:checkCli",
    "forgejo:setLogin",
    "forgejo:fetchOrgs",
    "forgejo:fetchOrgRepos",
    "forgejo:fetchUserRepos",
    "git:recordRepoProviders",
    "voice:getSnapshot",
    "voice:setEnabled",
    "voice:getRuntime",
    "voice:installRuntime",
    "voice:removeRuntime",
    "voice:installModel",
    "voice:removeModel",
    "voice:removeAllModels",
    "voice:selectModel",
    "voice:setEndpointSilence",
    "voice:tts:getSnapshot",
    "voice:tts:setEnabled",
    "voice:tts:setEngine",
    "voice:tts:setVoice",
    "voice:tts:setSpeed",
    "voice:tts:setMaxChars",
    "voice:tts:setSpeakActionResults",
    "voice:tts:setOnlyVoiceTurns",
    "voice:tts:installModel",
    "voice:tts:selectModel",
    "voice:tts:removeModel",
    "agent-installer:detect",
    "artifacts:scan",
    "artifacts:read",
    "mobile:getInfo",
    "mobile:setAccess",
    "mobile:startTunnel",
    "mobile:stopTunnel",
    "mobile:setCustomUrl",
    "mobile:clearCustomUrl",
    "mobile:getPendingPin",
    "mobile:getSessions",
    "mobile:revokeSession",
    "mobile:revokeAllSessions",
    "sessionContext:getSnapshot",
    "sessionContext:setPolicy",
    "claudePlugin:getMarketplaceSources",
    "claudePlugin:addMarketplaceSource",
    "claudePlugin:removeMarketplaceSource",
    "claudePlugin:fetchCatalog",
    "claudePlugin:discoverPlugins",
    "claudePlugin:getInstalledPlugins",
    "claudePlugin:installPlugin",
    "claudePlugin:uninstallPlugin",
    "claudePlugin:enablePlugin",
    "claudePlugin:disablePlugin",
    "claudePlugin:getPluginResources",
    "connectors:bridgePieces",
    "connectors:ensureInstance",
    "connectors:credentialStatus",
    "connectors:setCredentials",
    "connectors:clearCredentials",
    "connectors:oauthConnect",
    "connectors:syncStatus",
    "plugin:list",
    "plugin:getDocumentation",
    "plugin:resolveOptions",
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
    "mcp:getAll",
    "mcp:create",
    "mcp:update",
    "mcp:delete",
    "mcp:testConnection",
    "mcp:startOAuthFlow",
    "mcp:getOAuthStatus",
    "mcp:revokeOAuthToken",
    "mcp:probeForAuth",
    "mcp:submitManualClientId",
    "taskSource:getAll",
    "taskSource:create",
    "taskSource:update",
    "taskSource:delete",
    "taskSource:sync",
    "taskSource:exportUpdate",
    "taskSource:getUsers",
    "taskSource:reassign",
];
pub const EVENTS: &[&str] = &[
    "voice:status",
    "voice:runtimeProgress",
    "voice:tts:status",
    "voice:tts:modelProgress",
    "mobile:pairing-initiated",
    "mobile:device-connected",
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
const MCP_COMMANDS: &[&str] = &[
    "mcp:getAll",
    "mcp:create",
    "mcp:update",
    "mcp:delete",
    "mcp:testConnection",
    "mcp:startOAuthFlow",
    "mcp:getOAuthStatus",
    "mcp:revokeOAuthToken",
    "mcp:probeForAuth",
    "mcp:submitManualClientId",
];
const SOURCE_COMMANDS: &[&str] = &[
    "taskSource:getAll",
    "taskSource:create",
    "taskSource:update",
    "taskSource:delete",
    "taskSource:sync",
    "taskSource:exportUpdate",
    "taskSource:getUsers",
    "taskSource:reassign",
];
const CONNECTOR_COMMANDS: &[&str] = &[
    "connectors:bridgePieces",
    "connectors:ensureInstance",
    "connectors:credentialStatus",
    "connectors:setCredentials",
    "connectors:clearCredentials",
    "connectors:oauthConnect",
    "connectors:syncStatus",
];
const PLUGIN_COMMANDS: &[&str] = &[
    "plugin:list",
    "plugin:getDocumentation",
    "plugin:resolveOptions",
];
const CONTEXT_COMMANDS: &[&str] = &["sessionContext:getSnapshot", "sessionContext:setPolicy"];
const MOBILE_COMMANDS: &[&str] = &[
    "mobile:getInfo",
    "mobile:setAccess",
    "mobile:startTunnel",
    "mobile:stopTunnel",
    "mobile:setCustomUrl",
    "mobile:clearCustomUrl",
    "mobile:getPendingPin",
    "mobile:getSessions",
    "mobile:revokeSession",
    "mobile:revokeAllSessions",
];
fn mobile_days(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n.is_finite() && n > 0.0 && n <= 365.0)
}
fn mobile_address(value: &Value, paired: bool) -> bool {
    mcp_text(value, 2048)
        && value.as_str().is_some_and(|s| {
            s == js_trim(s)
                && url::Url::parse(s).is_ok_and(|u| {
                    matches!(u.scheme(), "http" | "https")
                        && u.username().is_empty()
                        && u.password().is_none_or(str::is_empty)
                        && u.fragment().is_none_or(str::is_empty)
                        && if paired {
                            let pairs: Vec<_> = u.query_pairs().collect();
                            u.path().ends_with("/pair")
                                && pairs.len() == 1
                                && pairs[0].0 == "code"
                                && mcp_id(&Value::String(pairs[0].1.to_string()))
                        } else {
                            u.query().is_none_or(str::is_empty)
                        }
                })
        })
}
fn mobile_pin(value: &Value) -> bool {
    object(value, &["pin", "pairCodeId", "expiresAt"], &[])
        && value["pin"]
            .as_str()
            .is_some_and(|s| s.len() == 6 && s.bytes().all(|c| c.is_ascii_digit()))
        && mcp_id(&value["pairCodeId"])
        && integer(&value["expiresAt"])
}
fn mobile_session(value: &Value) -> bool {
    object(value, &["id", "device_name", "paired_at", "last_seen"], &[])
        && mcp_id(&value["id"])
        && mcp_text(&value["device_name"], 256)
        && integer(&value["paired_at"])
        && integer(&value["last_seen"])
}
fn mobile_request(operation: &str, value: &Value) -> bool {
    match operation {
        "mobile:setAccess" => {
            object(value, &["options"], &[])
                && object(
                    &value["options"],
                    &[],
                    &["enabled", "lanAccess", "sessionIdleDays"],
                )
                && value["options"].as_object().is_some_and(|map| {
                    !map.is_empty()
                        && map.iter().all(|(key, entry)| {
                            if key == "sessionIdleDays" {
                                mobile_days(entry)
                            } else {
                                entry.is_boolean()
                            }
                        })
                })
        }
        "mobile:setCustomUrl" => {
            object(value, &["url"], &[]) && mobile_address(&value["url"], false)
        }
        "mobile:revokeSession" => object(value, &["sessionId"], &[]) && mcp_id(&value["sessionId"]),
        _ => object(value, &[], &[]),
    }
}
fn mobile_result(operation: &str, value: &Value) -> bool {
    match operation {
        "mobile:getInfo" => {
            object(
                value,
                &[
                    "enabled",
                    "lanAccess",
                    "sessionIdleDays",
                    "url",
                    "port",
                    "lanUrl",
                    "tunnelUrl",
                    "tunnelActive",
                    "remoteMode",
                    "customUrl",
                ],
                &[],
            ) && value["enabled"].is_boolean()
                && value["lanAccess"].is_boolean()
                && mobile_days(&value["sessionIdleDays"])
                && mobile_address(&value["url"], true)
                && value["port"]
                    .as_u64()
                    .is_some_and(|n| (1..=65535).contains(&n))
                && ["lanUrl", "tunnelUrl"]
                    .iter()
                    .all(|key| value[*key].is_null() || mobile_address(&value[*key], true))
                && value["tunnelActive"].is_boolean()
                && (value["remoteMode"] == "quick" || value["remoteMode"] == "custom")
                && (value["customUrl"].is_null() || mobile_address(&value["customUrl"], false))
        }
        "mobile:setAccess" => {
            object(
                value,
                &["enabled", "lanAccess", "sessionIdleDays", "listening"],
                &[],
            ) && value["enabled"].is_boolean()
                && value["lanAccess"].is_boolean()
                && mobile_days(&value["sessionIdleDays"])
                && value["listening"].is_boolean()
        }
        "mobile:startTunnel" => {
            object(value, &["tunnelUrl"], &[]) && mobile_address(&value["tunnelUrl"], true)
        }
        "mobile:setCustomUrl" => {
            object(value, &["url"], &[]) && mobile_address(&value["url"], true)
        }
        "mobile:getPendingPin" => value.is_null() || mobile_pin(value),
        "mobile:getSessions" => value.as_array().is_some_and(|items| {
            items.len() <= 128
                && items.iter().all(mobile_session)
                && items
                    .iter()
                    .filter_map(|row| row["id"].as_str())
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    == items.len()
        }),
        _ => object(value, &["success"], &[]) && value["success"].is_boolean(),
    }
}
const CLAUDE_COMMANDS: &[&str] = &[
    "claudePlugin:getMarketplaceSources",
    "claudePlugin:addMarketplaceSource",
    "claudePlugin:removeMarketplaceSource",
    "claudePlugin:fetchCatalog",
    "claudePlugin:discoverPlugins",
    "claudePlugin:getInstalledPlugins",
    "claudePlugin:installPlugin",
    "claudePlugin:uninstallPlugin",
    "claudePlugin:enablePlugin",
    "claudePlugin:disablePlugin",
    "claudePlugin:getPluginResources",
];
fn context_scope(value: &Value) -> bool {
    object(value, &["kind", "ownerId"], &[])
        && (value["kind"] == "captain" || value["kind"] == "commander")
        && id(&value["ownerId"])
}
fn context_policy(value: &Value) -> bool {
    object(
        value,
        &[
            "mode",
            "contextRatio",
            "compactions",
            "wakeups",
            "turns",
            "maxAgeDays",
        ],
        &[],
    ) && value["mode"]
        .as_str()
        .is_some_and(|s| ["off", "observe", "on"].contains(&s))
        && value["contextRatio"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n > 0.0 && n <= 1.0)
        && value["maxAgeDays"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n > 0.0 && n <= 3650.0)
        && ["compactions", "wakeups", "turns"].iter().all(|key| {
            value[*key]
                .as_u64()
                .is_some_and(|n| (1..=1_000_000).contains(&n))
        })
}
fn context_reference(value: &Value) -> bool {
    mcp_text(value, 4096) && value.as_str().is_some_and(|s| !s.is_empty())
}
fn context_nullable(value: &Value, check: fn(&Value) -> bool) -> bool {
    value.is_null() || check(value)
}
fn context_snapshot(value: &Value) -> bool {
    if !object(
        value,
        &[
            "scope",
            "generation",
            "usage",
            "counters",
            "policy",
            "reasons",
            "warnings",
            "summaries",
        ],
        &["handoff"],
    ) || !context_scope(&value["scope"])
        || !context_policy(&value["policy"])
    {
        return false;
    }
    let generation = &value["generation"];
    if !generation.is_null()
        && !(object(
            generation,
            &["id", "key", "engine", "state", "createdAt", "backendId"],
            &[],
        ) && context_reference(&generation["id"])
            && context_reference(&generation["key"])
            && (generation["engine"] == "chat" || generation["engine"] == "adapter")
            && generation["state"]
                .as_str()
                .is_some_and(|s| ["open", "running", "closed", "interrupted"].contains(&s))
            && integer(&generation["createdAt"])
            && context_nullable(&generation["backendId"], context_reference))
    {
        return false;
    }
    let usage = &value["usage"];
    if !object(
        usage,
        &["tokens", "source", "contextWindow", "model", "observedAt"],
        &[],
    ) || !context_nullable(&usage["tokens"], integer)
        || !usage["source"]
            .as_str()
            .is_some_and(|s| ["reported", "estimated", "unknown"].contains(&s))
        || !(usage["contextWindow"].is_null()
            || integer(&usage["contextWindow"])
                && usage["contextWindow"].as_u64().is_some_and(|n| n > 0))
        || !(usage["model"].is_null() || mcp_text(&usage["model"], 4096))
        || !context_nullable(&usage["observedAt"], integer)
        || (if usage["source"] == "unknown" {
            !usage["tokens"].is_null() || !usage["observedAt"].is_null()
        } else {
            usage["tokens"].is_null()
        })
    {
        return false;
    }
    object(
        &value["counters"],
        &["compactions", "wakeups", "turns", "ageMs"],
        &[],
    ) && value["counters"]
        .as_object()
        .is_some_and(|map| map.values().all(integer))
        && value["reasons"].as_array().is_some_and(|items| {
            items.len() <= 5
                && items.iter().all(|entry| {
                    entry.as_str().is_some_and(|s| {
                        ["context", "compactions", "wakeups", "turns", "age"].contains(&s)
                    })
                })
                && items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    == items.len()
        })
        && value["warnings"].as_array().is_some_and(|items| {
            items.len() <= 4 && items.iter().all(|entry| plugin_text(entry, 4096))
        })
        && value["summaries"].as_array().is_some_and(|items| {
            items.len() <= 10
                && items.iter().all(|item| {
                    object(item, &["id", "content", "kind", "createdAt", "source"], &[])
                        && context_reference(&item["id"])
                        && plugin_text(&item["content"], 65_536)
                        && item["kind"]
                            .as_str()
                            .is_some_and(|s| ["summary", "rollover", "recovery"].contains(&s))
                        && integer(&item["createdAt"])
                        && (item["source"].is_null()
                            || item["source"] == "model"
                            || item["source"] == "fallback")
                })
        })
        && value.get("handoff").is_none_or(|handoff| {
            handoff.is_null()
                || object(handoff, &["id", "state"], &[])
                    && context_reference(&handoff["id"])
                    && handoff["state"].as_str().is_some_and(|s| {
                        [
                            "pending",
                            "summary",
                            "memory",
                            "creating",
                            "created",
                            "creation_unconfirmed",
                            "completed",
                        ]
                        .contains(&s)
                    })
        })
}
fn claude_reserved(value: &str) -> bool {
    let name = value.split('.').next().unwrap_or("").to_ascii_lowercase();
    ["con", "prn", "aux", "nul"].contains(&name.as_str())
        || name.len() == 4
            && (name.starts_with("com") || name.starts_with("lpt"))
            && matches!(name.as_bytes()[3], b'1'..=b'9')
}
fn claude_name(value: &Value) -> bool {
    mcp_text(value, 128)
        && value.as_str().is_some_and(|s| {
            s.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
                && !s.ends_with('.')
                && !claude_reserved(s)
        })
}
fn claude_relative(value: &Value) -> bool {
    mcp_text(value, 4096)
        && value.as_str().is_some_and(|s| {
            !s.starts_with('/') && !s.contains('\\') && {
                let path = s.strip_prefix("./").unwrap_or(s);
                path.is_empty()
                    || path.split('/').all(|part| {
                        !part.is_empty()
                            && part != "."
                            && part != ".."
                            && !part.contains(':')
                            && !part.contains('%')
                            && !part.ends_with('.')
                            && !part.ends_with(' ')
                            && !claude_reserved(part)
                    })
            }
        })
}
fn claude_repo(value: &Value) -> bool {
    mcp_text(value, 4096)
        && value.as_str().is_some_and(|s| {
            let mut components = s.split('#');
            let slug = components.next().unwrap_or("");
            let reference = components.next();
            let parts: Vec<_> = slug.split('/').collect();
            components.next().is_none()
                && parts.len() == 2
                && parts
                    .iter()
                    .all(|part| claude_name(&Value::String((*part).to_owned())))
                && reference.is_none_or(|part| {
                    !part.is_empty() && claude_relative(&Value::String(part.to_owned()))
                })
        })
}
fn claude_source(value: &Value, relative: bool) -> bool {
    if value.is_string() {
        return relative && claude_relative(value);
    }
    object(
        value,
        &[],
        &["source", "repo", "url", "ref", "sha", "path", "version"],
    ) && value.as_object().is_some_and(|map| {
        map.iter().all(|(key, entry)| match key.as_str() {
            "source" => entry == "github" || entry == "url" || entry == "local",
            "repo" => claude_repo(entry),
            "url" => host_url(entry, true),
            "ref" | "path" => claude_relative(entry),
            _ => mcp_text(entry, 256),
        })
    })
}
fn claude_market_input(value: &Value) -> bool {
    object(
        value,
        &["name", "source_url"],
        &["source_type", "auto_update"],
    ) && mcp_text(&value["name"], 256)
        && value["name"]
            .as_str()
            .is_some_and(|s| !js_trim(s).is_empty())
        && value.get("auto_update").is_none_or(Value::is_boolean)
        && (match value
            .get("source_type")
            .and_then(Value::as_str)
            .unwrap_or("github")
        {
            "github" => claude_repo(&value["source_url"]),
            "url" => host_url(&value["source_url"], true),
            "local" => {
                mcp_text(&value["source_url"], 4096)
                    && value["source_url"]
                        .as_str()
                        .is_some_and(|s| !s.is_empty() && s != "__21x_local_source__")
            }
            _ => false,
        })
        && value.get("source_type").is_none_or(Value::is_string)
}
fn claude_request(operation: &str, value: &Value) -> bool {
    match operation {
        "claudePlugin:getMarketplaceSources" | "claudePlugin:getInstalledPlugins" => {
            object(value, &[], &[])
        }
        "claudePlugin:addMarketplaceSource" => {
            object(value, &["data"], &[]) && claude_market_input(&value["data"])
        }
        "claudePlugin:removeMarketplaceSource" => {
            object(value, &["id"], &[]) && mcp_id(&value["id"])
        }
        "claudePlugin:fetchCatalog" => {
            object(value, &["sourceId"], &[]) && mcp_id(&value["sourceId"])
        }
        "claudePlugin:discoverPlugins" => {
            object(value, &[], &["searchQuery"])
                && value
                    .get("searchQuery")
                    .is_none_or(|entry| mcp_text(entry, 256))
        }
        "claudePlugin:installPlugin" => {
            object(value, &["pluginName", "marketplaceId"], &["scope"])
                && claude_name(&value["pluginName"])
                && mcp_id(&value["marketplaceId"])
                && value.get("scope").is_none_or(|entry| entry == "user")
        }
        _ => object(value, &["pluginId"], &[]) && mcp_id(&value["pluginId"]),
    }
}
fn claude_strings(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.len() <= 64 && items.iter().all(|entry| mcp_text(entry, 256)))
}
fn claude_author(value: &Value) -> bool {
    object(value, &["name"], &[]) && mcp_text(&value["name"], 256)
}
fn claude_link(value: &Value) -> bool {
    value == "" || host_url(value, true)
}
fn claude_manifest(value: &Value) -> bool {
    object(
        value,
        &["name"],
        &[
            "version",
            "description",
            "author",
            "homepage",
            "repository",
            "license",
            "keywords",
        ],
    ) && claude_name(&value["name"])
        && value.as_object().is_some_and(|map| {
            map.iter().all(|(key, entry)| match key.as_str() {
                "name" => true,
                "description" => mcp_text(entry, 8192),
                "author" => claude_author(entry),
                "homepage" | "repository" => claude_link(entry),
                "keywords" => claude_strings(entry),
                _ => mcp_text(entry, 256),
            })
        })
}
fn claude_market_row(value: &Value) -> bool {
    object(
        value,
        &[
            "id",
            "name",
            "source_type",
            "source_url",
            "metadata",
            "auto_update",
            "created_at",
            "updated_at",
        ],
        &[],
    ) && mcp_id(&value["id"])
        && mcp_text(&value["name"], 256)
        && value["name"]
            .as_str()
            .is_some_and(|s| !js_trim(s).is_empty())
        && (match value["source_type"].as_str() {
            Some("local") => value["source_url"] == "__21x_local_source__",
            Some("github") => claude_repo(&value["source_url"]),
            Some("url") => host_url(&value["source_url"], true),
            _ => false,
        })
        && object(&value["metadata"], &[], &[])
        && value["auto_update"].is_boolean()
        && mcp_text(&value["created_at"], 32)
        && mcp_text(&value["updated_at"], 32)
}
fn claude_installed(value: &Value) -> bool {
    object(
        value,
        &[
            "id",
            "name",
            "marketplace_id",
            "manifest",
            "source",
            "scope",
            "enabled",
            "version",
            "installed_at",
            "updated_at",
        ],
        &[],
    ) && mcp_id(&value["id"])
        && claude_name(&value["name"])
        && (value["marketplace_id"].is_null() || mcp_id(&value["marketplace_id"]))
        && claude_manifest(&value["manifest"])
        && claude_source(&value["source"], false)
        && value["scope"] == "user"
        && value["enabled"].is_boolean()
        && mcp_text(&value["version"], 256)
        && mcp_text(&value["installed_at"], 32)
        && mcp_text(&value["updated_at"], 32)
}
fn claude_entry(value: &Value) -> bool {
    object(
        value,
        &["name", "source"],
        &[
            "description",
            "version",
            "category",
            "license",
            "author",
            "homepage",
            "repository",
            "tags",
            "keywords",
        ],
    ) && claude_name(&value["name"])
        && claude_source(&value["source"], true)
        && value.as_object().is_some_and(|map| {
            map.iter().all(|(key, entry)| match key.as_str() {
                "name" | "source" => true,
                "description" => mcp_text(entry, 8192),
                "author" => claude_author(entry),
                "homepage" | "repository" => claude_link(entry),
                "tags" | "keywords" => claude_strings(entry),
                _ => mcp_text(entry, 256),
            })
        })
}
fn claude_catalog(value: &Value) -> bool {
    value.is_null()
        || object(value, &["name", "owner", "plugins"], &["metadata"])
            && mcp_text(&value["name"], 256)
            && claude_author(&value["owner"])
            && value["plugins"]
                .as_array()
                .is_some_and(|items| items.len() <= 512 && items.iter().all(claude_entry))
            && value.get("metadata").is_none_or(|metadata| {
                object(metadata, &[], &["description", "version"])
                    && metadata.as_object().is_some_and(|map| {
                        map.iter().all(|(key, entry)| {
                            mcp_text(entry, if key == "description" { 8192 } else { 256 })
                        })
                    })
            })
}
fn claude_discovery(value: &Value) -> bool {
    object(
        value,
        &[
            "name",
            "description",
            "version",
            "author",
            "category",
            "tags",
            "homepage",
            "repository",
            "license",
            "marketplace_id",
            "marketplace_name",
            "source",
            "installed",
        ],
        &["installed_plugin_id", "enabled"],
    ) && claude_name(&value["name"])
        && mcp_text(&value["description"], 8192)
        && [
            "version",
            "author",
            "category",
            "license",
            "marketplace_name",
        ]
        .iter()
        .all(|key| mcp_text(&value[*key], 256))
        && claude_strings(&value["tags"])
        && claude_link(&value["homepage"])
        && claude_link(&value["repository"])
        && mcp_id(&value["marketplace_id"])
        && claude_source(&value["source"], true)
        && value["installed"].is_boolean()
        && value.get("installed_plugin_id").is_none_or(mcp_id)
        && value.get("enabled").is_none_or(Value::is_boolean)
}
fn claude_resources(value: &Value) -> bool {
    object(value, &["skills", "mcpServers", "agents", "commands"], &[])
        && ["skills", "mcpServers", "agents"].iter().all(|kind| {
            value[*kind].as_array().is_some_and(|items| {
                items.len() <= 256
                    && items.iter().all(|item| {
                        mcp_id(&item["id"])
                            && mcp_text(&item["name"], 256)
                            && if *kind == "mcpServers" {
                                object(item, &["id", "name", "command", "args"], &[])
                                    && item["command"] == ""
                                    && item["args"].as_array().is_some_and(Vec::is_empty)
                            } else {
                                object(item, &["id", "name", "description"], &[])
                                    && if *kind == "agents" {
                                        item["description"] == ""
                                    } else {
                                        mcp_text(&item["description"], 8192)
                                    }
                            }
                    })
            })
        })
        && value["commands"]
            .as_array()
            .is_some_and(|items| items.len() <= 256 && items.iter().all(claude_relative))
}
fn claude_result(operation: &str, value: &Value) -> bool {
    match operation {
        "claudePlugin:getMarketplaceSources" => value
            .as_array()
            .is_some_and(|items| items.len() <= 128 && items.iter().all(claude_market_row)),
        "claudePlugin:addMarketplaceSource" => claude_market_row(value),
        "claudePlugin:removeMarketplaceSource" | "claudePlugin:uninstallPlugin" => {
            value.is_boolean()
        }
        "claudePlugin:fetchCatalog" => claude_catalog(value),
        "claudePlugin:discoverPlugins" => value
            .as_array()
            .is_some_and(|items| items.len() <= 512 && items.iter().all(claude_discovery)),
        "claudePlugin:getInstalledPlugins" => value
            .as_array()
            .is_some_and(|items| items.len() <= 128 && items.iter().all(claude_installed)),
        "claudePlugin:installPlugin"
        | "claudePlugin:enablePlugin"
        | "claudePlugin:disablePlugin" => claude_installed(value),
        "claudePlugin:getPluginResources" => claude_resources(value),
        _ => false,
    }
}
fn js_trim(value: &str) -> &str {
    value.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}
fn plugin_resolver(plugin: &str, resolver: &str) -> bool {
    match plugin {
        "linear" => resolver == "users",
        "hubspot" => ["owners", "pipelines"].contains(&resolver),
        "github-issues" => ["owners", "repos"].contains(&resolver),
        "forgejo-issues" => ["logins", "owners", "repos"].contains(&resolver),
        "notion" => {
            ["data_sources", "status_options", "data_source_properties"].contains(&resolver)
        }
        "youtrack" => ["projects", "users", "states", "priorities", "types"].contains(&resolver),
        "connector-bridge" => resolver == "pieces",
        _ => false,
    }
}
fn plugin_request(operation: &str, value: &Value) -> bool {
    match operation {
        "plugin:list" => object(value, &[], &[]),
        "plugin:getDocumentation" => {
            object(value, &["pluginId"], &[]) && source_plugin(&value["pluginId"])
        }
        "plugin:resolveOptions" => {
            object(
                value,
                &["pluginId", "resolverKey", "config"],
                &["mcpServerId", "sourceId"],
            ) && value["pluginId"].as_str().is_some_and(|plugin| {
                value["resolverKey"]
                    .as_str()
                    .is_some_and(|resolver| plugin_resolver(plugin, resolver))
                    && source_config(plugin, &value["config"], true)
            }) && value.get("mcpServerId").is_none_or(id)
                && value.get("sourceId").is_none_or(id)
        }
        _ => false,
    }
}
fn plugin_text(value: &Value, limit: usize) -> bool {
    text(value, limit) && value.as_str().is_some_and(|s| s.len() <= limit)
}
fn plugin_result(operation: &str, value: &Value) -> bool {
    match operation {
        "plugin:list" => value.as_array().is_some_and(|items| {
            items.len() <= 7
                && items.iter().all(|item| {
                    object(item, &["id", "displayName", "description", "icon"], &[])
                        && source_plugin(&item["id"])
                        && plugin_text(&item["displayName"], 512)
                        && item["displayName"]
                            .as_str()
                            .is_some_and(|s| !js_trim(s).is_empty())
                        && plugin_text(&item["description"], 8192)
                        && plugin_text(&item["icon"], 128)
                })
                && items
                    .iter()
                    .filter_map(|item| item["id"].as_str())
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    == items.len()
        }),
        "plugin:getDocumentation" => value.is_null() || plugin_text(value, 128_000),
        "plugin:resolveOptions" => value.as_array().is_some_and(|items| {
            items.len() <= 512
                && items.iter().all(|item| {
                    object(item, &["value", "label"], &[])
                        && plugin_text(&item["value"], 65_536)
                        && plugin_text(&item["label"], 4096)
                })
        }),
        _ => false,
    }
}
fn connector_piece(value: &Value) -> bool {
    value == "@activepieces/piece-trello" || value == "@activepieces/piece-todoist"
}
fn connector_storage(value: &Value) -> bool {
    value == "persistent" || value == "session"
}
fn connector_time(value: &Value) -> bool {
    value.is_null() || integer(value)
}
fn connector_request(operation: &str, value: &Value) -> bool {
    match operation {
        "connectors:bridgePieces" => object(value, &[], &[]),
        "connectors:ensureInstance" => {
            object(value, &["pieceName"], &["instanceId"])
                && connector_piece(&value["pieceName"])
                && value.get("instanceId").is_none_or(mcp_id)
        }
        "connectors:setCredentials" | "connectors:oauthConnect" => {
            let fields: &[&str] = if operation == "connectors:oauthConnect" {
                &["clientId", "clientSecret"]
            } else {
                &["username", "password", "secret"]
            };
            object(value, &["instanceId", "input"], &["storage"])
                && mcp_id(&value["instanceId"])
                && value.get("storage").is_none_or(connector_storage)
                && object(&value["input"], &[], fields)
                && value["input"].as_object().is_some_and(|map| {
                    map.values().all(|entry| {
                        mcp_text(entry, 4096)
                            && entry.as_str().is_some_and(|s| {
                                !js_trim(s).is_empty()
                                    && js_trim(s) != "__21x_api_key_set__"
                                    && js_trim(s) != "__21x_mcp_secret_set__"
                            })
                    })
                })
        }
        _ => object(value, &["instanceId"], &[]) && mcp_id(&value["instanceId"]),
    }
}
fn connector_piece_row(value: &Value) -> bool {
    object(
        value,
        &[
            "pieceName",
            "label",
            "authType",
            "authLabels",
            "configProps",
        ],
        &["authHelp", "oauth"],
    ) && connector_piece(&value["pieceName"])
        && mcp_text(&value["label"], 256)
        && value["authType"]
            .as_str()
            .is_some_and(|s| ["basic", "secret_text", "oauth2"].contains(&s))
        && value["authLabels"].as_object().is_some_and(|map| {
            map.len() <= 3
                && map.iter().all(|(key, entry)| {
                    ["username", "password", "secret", "clientId", "clientSecret"]
                        .contains(&key.as_str())
                        && mcp_text(entry, 256)
                })
        })
        && value
            .get("authHelp")
            .is_none_or(|entry| mcp_text(entry, 4096))
        && value["configProps"].as_array().is_some_and(|items| {
            items.len() <= 32
                && items.iter().all(|item| {
                    object(
                        item,
                        &["key", "label"],
                        &["required", "description", "placeholder"],
                    ) && mcp_text(&item["key"], 128)
                        && mcp_text(&item["label"], 256)
                        && item.get("required").is_none_or(Value::is_boolean)
                        && item
                            .get("description")
                            .is_none_or(|entry| mcp_text(entry, 4096))
                        && item
                            .get("placeholder")
                            .is_none_or(|entry| mcp_text(entry, 4096))
                })
        })
        && value.get("oauth").is_none_or(|oauth| {
            object(
                oauth,
                &[
                    "mode",
                    "pkce",
                    "clientSecretRequired",
                    "scopes",
                    "redirectUriHint",
                ],
                &[],
            ) && (oauth["mode"] == "registered" || oauth["mode"] == "user-supplied")
                && oauth["pkce"].is_boolean()
                && oauth["clientSecretRequired"].is_boolean()
                && oauth["scopes"].as_array().is_some_and(|items| {
                    items.len() <= 32 && items.iter().all(|entry| mcp_text(entry, 256))
                })
                && mcp_text(&oauth["redirectUriHint"], 1024)
        })
}
fn connector_write_result(value: &Value) -> bool {
    if value["ok"] == true {
        return object(value, &["ok", "storage"], &[]) && connector_storage(&value["storage"]);
    }
    object(value, &["ok", "error"], &["remediation", "sessionOnlyAvailable"]) && value["ok"] == false && value["error"] == "Connector credentials could not be saved." && value.get("remediation").is_none_or(|entry| entry == "Secure persistent storage is unavailable. Use session storage or restore secure storage.") && value.get("sessionOnlyAvailable").is_none_or(Value::is_boolean)
}
fn connector_result(operation: &str, value: &Value) -> bool {
    match operation {
        "connectors:bridgePieces" => value.as_array().is_some_and(|items| {
            items.len() <= 2
                && items.iter().all(connector_piece_row)
                && items
                    .iter()
                    .filter_map(|entry| entry["pieceName"].as_str())
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    == items.len()
        }),
        "connectors:ensureInstance" => {
            object(value, &["instanceId", "pieceName"], &[])
                && mcp_id(&value["instanceId"])
                && connector_piece(&value["pieceName"])
        }
        "connectors:credentialStatus" => {
            object(value, &["storage", "persistentAvailable"], &["oauth"])
                && (value["storage"].is_null() || connector_storage(&value["storage"]))
                && value["persistentAvailable"].is_boolean()
                && value.get("oauth").is_none_or(|oauth| {
                    object(oauth, &["state", "expiresAt"], &[])
                        && oauth["state"]
                            .as_str()
                            .is_some_and(|s| ["none", "connected", "revoked"].contains(&s))
                        && connector_time(&oauth["expiresAt"])
                })
        }
        "connectors:setCredentials" | "connectors:oauthConnect" => connector_write_result(value),
        "connectors:syncStatus" => {
            object(
                value,
                &[
                    "lastError",
                    "lastSyncedAt",
                    "attemptCount",
                    "nextRetryAt",
                    "deadLetterCount",
                ],
                &[],
            ) && (value["lastError"].is_null()
                || value["lastError"] == "Connector sync failed. Open the task source for details.")
                && connector_time(&value["lastSyncedAt"])
                && integer(&value["attemptCount"])
                && connector_time(&value["nextRetryAt"])
                && integer(&value["deadLetterCount"])
        }
        _ => false,
    }
}
const SOURCE_PLUGINS: &[&str] = &[
    "linear",
    "hubspot",
    "github-issues",
    "forgejo-issues",
    "notion",
    "youtrack",
    "connector-bridge",
];
fn clean_text(value: &Value, limit: usize) -> bool {
    text(value, limit)
        && value
            .as_str()
            .is_some_and(|s| !s.chars().any(|c| c <= '\u{001f}' || c == '\u{007f}'))
}
fn mcp_text(value: &Value, limit: usize) -> bool {
    clean_text(value, limit) && value.as_str().is_some_and(|s| s.len() <= limit)
}
fn named(value: &Value, limit: usize) -> bool {
    clean_text(value, limit) && value.as_str().is_some_and(|s| !s.trim().is_empty())
}
fn mcp_id(value: &Value) -> bool {
    mcp_text(value, 128)
        && value.as_str().is_some_and(|s| {
            s.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b':' | b'-'))
        })
}
fn host_url(value: &Value, byte_limit: bool) -> bool {
    (if byte_limit {
        mcp_text(value, 4096)
    } else {
        clean_text(value, 4096)
    }) && value.as_str().is_some_and(|s| {
        url::Url::parse(s).is_ok_and(|u| {
            matches!(u.scheme(), "http" | "https")
                && u.host_str().is_some()
                && u.username().is_empty()
                && u.password().is_none()
                && u.query().is_none()
                && u.fragment().is_none()
        })
    })
}
fn mcp_dictionary(value: &Value, environment: bool, masked: bool) -> bool {
    value.as_object().is_some_and(|map| {
        map.len() <= 64
            && map.iter().all(|(key, entry)| {
                let valid_key = if environment {
                    key.as_bytes()
                        .first()
                        .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_')
                        && key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
                } else {
                    !key.is_empty()
                        && key
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&c))
                };
                key.len() <= 256
                    && valid_key
                    && !["__proto__", "prototype", "constructor"].contains(&key.as_str())
                    && mcp_text(entry, 8192)
                    && (!masked || entry == "" || entry == "__21x_mcp_secret_set__")
            })
    })
}
fn mcp_data(value: &Value, create: bool, probe: bool) -> bool {
    let mut optional = vec!["type", "command", "args", "url", "headers", "environment"];
    if !create {
        optional.push("name");
    }
    if probe {
        optional.push("id");
    }
    object(value, if create { &["name"] } else { &[] }, &optional)
        && bounded_bytes(value, 128 * 1024)
        && value.as_object().is_some_and(|map| {
            map.iter().all(|(key, entry)| match key.as_str() {
                "name" => {
                    mcp_text(entry, 256) && entry.as_str().is_some_and(|s| !s.trim().is_empty())
                }
                "type" => entry == "local" || entry == "remote",
                "command" => mcp_text(entry, 4096),
                "args" => entry.as_array().is_some_and(|items| {
                    items.len() <= 128 && items.iter().all(|item| mcp_text(item, 8192))
                }),
                "url" => entry == "" || host_url(entry, true),
                "headers" => mcp_dictionary(entry, false, false),
                "environment" => mcp_dictionary(entry, true, false),
                "id" => probe && mcp_id(entry),
                _ => false,
            })
        })
}
fn mcp_tools(value: &Value) -> bool {
    value.as_array().is_some_and(|items| {
        items.len() <= 256
            && items.iter().all(|item| {
                object(item, &["name", "description"], &[])
                    && mcp_text(&item["name"], 256)
                    && item["name"].as_str().is_some_and(|s| !s.is_empty())
                    && text(&item["description"], 8192)
                    && item["description"]
                        .as_str()
                        .is_some_and(|s| s.len() <= 8192)
            })
    })
}
fn mcp_metadata(value: &Value) -> bool {
    object(
        value,
        &[],
        &[
            "resource_url",
            "authorization_server_url",
            "authorization_endpoint",
            "token_endpoint",
            "registration_endpoint",
            "revocation_endpoint",
            "scopes",
            "code_challenge_methods_supported",
            "client_id",
            "client_secret",
            "registration_method",
            "discovered_at",
        ],
    ) && value.as_object().is_some_and(|map| {
        map.iter().all(|(key, entry)| match key.as_str() {
            "client_secret" => entry == "" || entry == "__21x_mcp_secret_set__",
            "code_challenge_methods_supported" => entry.as_array().is_some_and(|items| {
                items.len() <= 16 && items.iter().all(|item| mcp_text(item, 64))
            }),
            _ => mcp_text(
                entry,
                if key.ends_with("_url") || key.ends_with("_endpoint") {
                    4096
                } else {
                    8192
                },
            ),
        })
    })
}
fn mcp_row(value: &Value) -> bool {
    let fields = [
        "name",
        "type",
        "command",
        "args",
        "url",
        "headers",
        "environment",
    ];
    let data = Value::Object(
        fields
            .iter()
            .map(|key| ((*key).to_owned(), value[*key].clone()))
            .collect(),
    );
    object(
        value,
        &[
            "id",
            "name",
            "type",
            "command",
            "args",
            "url",
            "headers",
            "environment",
            "tools",
            "oauth_metadata",
            "source",
            "created_at",
            "updated_at",
        ],
        &[],
    ) && mcp_id(&value["id"])
        && mcp_data(&data, true, false)
        && mcp_tools(&value["tools"])
        && mcp_metadata(&value["oauth_metadata"])
        && mcp_dictionary(&value["headers"], false, true)
        && mcp_dictionary(&value["environment"], true, true)
        && (value["source"] == "user" || value["source"] == "plugin")
        && mcp_text(&value["created_at"], 32)
        && mcp_text(&value["updated_at"], 32)
}
fn mcp_request(operation: &str, value: &Value) -> bool {
    match operation {
        "mcp:getAll" => object(value, &[], &[]),
        "mcp:create" | "mcp:testConnection" => {
            object(value, &["data"], &[])
                && mcp_data(&value["data"], true, operation == "mcp:testConnection")
        }
        "mcp:update" => {
            object(value, &["id", "data"], &[])
                && mcp_id(&value["id"])
                && mcp_data(&value["data"], false, false)
        }
        "mcp:probeForAuth" => object(value, &["url"], &[]) && host_url(&value["url"], true),
        "mcp:submitManualClientId" => {
            object(value, &["id", "clientId"], &[])
                && mcp_id(&value["id"])
                && mcp_text(&value["clientId"], 1024)
                && value["clientId"].as_str().is_some_and(|s| !s.is_empty())
        }
        _ => object(value, &["id"], &[]) && mcp_id(&value["id"]),
    }
}
fn mcp_result(operation: &str, value: &Value) -> bool {
    match operation {
        "mcp:getAll" => value
            .as_array()
            .is_some_and(|items| items.len() <= 128 && items.iter().all(mcp_row)),
        "mcp:create" | "mcp:update" => mcp_row(value),
        "mcp:delete" => value.is_boolean(),
        "mcp:startOAuthFlow" | "mcp:submitManualClientId" => {
            object(value, &[], &["needsManualClientId"])
                && value
                    .get("needsManualClientId")
                    .is_none_or(Value::is_boolean)
        }
        "mcp:getOAuthStatus" => {
            object(value, &["connected"], &["expiresAt"])
                && value["connected"].is_boolean()
                && value
                    .get("expiresAt")
                    .is_none_or(|entry| mcp_text(entry, 32))
        }
        "mcp:probeForAuth" => {
            object(value, &["requiresAuth"], &[]) && value["requiresAuth"].is_boolean()
        }
        "mcp:testConnection" => {
            object(value, &["status"], &["error", "toolCount", "tools"])
                && (value["status"] == "connected" || value["status"] == "failed")
                && value
                    .get("error")
                    .is_none_or(|entry| entry == "MCP probe failed")
                && value
                    .get("toolCount")
                    .is_none_or(|entry| entry.as_u64().is_some_and(|n| n <= 256))
                && value.get("tools").is_none_or(mcp_tools)
        }
        _ => false,
    }
}
fn source_strings(value: &Value, maximum: usize) -> bool {
    value.as_array().is_some_and(|items| {
        items.len() <= maximum && items.iter().all(|item| clean_text(item, 512))
    })
}
fn source_plugin(value: &Value) -> bool {
    value.as_str().is_some_and(|s| SOURCE_PLUGINS.contains(&s))
}
fn stored_plugin(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 128
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
    })
}
fn source_interval(value: &Value) -> bool {
    let within = |n: f64| n.is_finite() && (0.0..=525_600.0).contains(&n);
    if let Some(n) = value.as_f64() {
        return within(n);
    }
    let Some(s) = value.as_str() else {
        return false;
    };
    if s.is_empty() {
        return true;
    }
    let (whole, fraction) = s.split_once('.').map_or((s, None), |(a, b)| (a, Some(b)));
    let decimal = whole == "0"
        || whole
            .as_bytes()
            .first()
            .is_some_and(|c| (b'1'..=b'9').contains(c))
            && whole.bytes().all(|c| c.is_ascii_digit());
    decimal
        && fraction.is_none_or(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit()))
        && s.parse::<f64>().is_ok_and(within)
}
fn source_config(plugin: &str, value: &Value, input: bool) -> bool {
    let (public, secret): (&[&str], &[&str]) = match plugin {
        "linear" => (
            &[
                "_setup_link",
                "redirect_uri",
                "client_id",
                "scope",
                "assignee_id",
            ],
            &["client_secret"],
        ),
        "hubspot" => (
            &[
                "auth_type",
                "_oauth_setup_link",
                "client_id",
                "pipeline_id",
                "owner_id",
            ],
            &["client_secret", "access_token"],
        ),
        "github-issues" => (&["owner", "repo", "state", "assignee", "labels"], &[]),
        "forgejo-issues" => (
            &["login", "owner", "repo", "state", "assignee", "labels"],
            &[],
        ),
        "notion" => (
            &[
                "data_source_id",
                "filters",
                "next_statuses",
                "completion_status",
            ],
            &["api_token"],
        ),
        "youtrack" => (
            &[
                "server_url",
                "project",
                "assignee",
                "state",
                "priority",
                "issue_type",
                "custom_query",
            ],
            &["api_token"],
        ),
        "connector-bridge" => (
            &[
                "piece_name",
                "connector_instance_id",
                "props",
                "poll_interval_minutes",
            ],
            &[],
        ),
        _ => return false,
    };
    bounded_bytes(value, 512_000)
        && value.as_object().is_some_and(|map| {
            map.len() <= 32
                && map.iter().all(|(key, entry)| {
                    if secret.contains(&key.as_str()) {
                        return entry == "__21x_api_key_set__"
                            || input
                                && entry
                                    .as_str()
                                    .is_some_and(|s| s.len() <= 16_384 && !s.contains('\0'));
                    }
                    if !public.contains(&key.as_str()) {
                        return false;
                    }
                    match key.as_str() {
                        "server_url" | "_setup_link" | "_oauth_setup_link" => {
                            entry == "" || host_url(entry, false)
                        }
                        "redirect_uri" => {
                            entry == ""
                                || entry == "twentyonex://oauth/callback"
                                || entry == "nuanu://oauth/callback"
                        }
                        "auth_type" => entry == "" || entry == "oauth" || entry == "private_app",
                        "state" if plugin == "github-issues" || plugin == "forgejo-issues" => {
                            entry == "" || entry == "open" || entry == "closed" || entry == "all"
                        }
                        "poll_interval_minutes" => source_interval(entry),
                        "connector_instance_id" => entry == "" || id(entry),
                        "piece_name" => {
                            entry == ""
                                || entry == "@activepieces/piece-trello"
                                || entry == "@activepieces/piece-todoist"
                        }
                        "props" => {
                            object(entry, &[], &["board_id", "filter_query"])
                                && entry.as_object().is_some_and(|map| {
                                    map.values().all(|item| clean_text(item, 4096))
                                })
                        }
                        "filters" => entry.as_array().is_some_and(|items| {
                            items.len() <= 64
                                && items.iter().all(|item| {
                                    object(item, &["property", "type", "values"], &[])
                                        && named(&item["property"], 512)
                                        && named(&item["type"], 512)
                                        && source_strings(&item["values"], 128)
                                })
                        }),
                        "next_statuses" => source_strings(entry, 128) || clean_text(entry, 4096),
                        "assignee" | "state" | "priority" | "issue_type"
                            if plugin == "youtrack" =>
                        {
                            source_strings(entry, 128) || clean_text(entry, 4096)
                        }
                        _ => clean_text(entry, 4096),
                    }
                })
        })
}
fn source_input(value: &Value, create: bool) -> bool {
    object(
        value,
        if create {
            &["mcp_server_id", "name", "plugin_id"]
        } else {
            &[]
        },
        if create {
            &[
                "project_id",
                "config",
                "list_tool",
                "list_tool_args",
                "update_tool",
                "update_tool_args",
            ]
        } else {
            &[
                "name",
                "plugin_id",
                "config",
                "mcp_server_id",
                "list_tool",
                "list_tool_args",
                "update_tool",
                "update_tool_args",
                "enabled",
            ]
        },
    ) && bounded_bytes(value, 512_000)
        && value.as_object().is_some_and(|map| {
            map.iter().all(|(key, entry)| match key.as_str() {
                "name" => named(entry, 512),
                "plugin_id" => source_plugin(entry),
                "mcp_server_id" => (create && entry.is_null()) || id(entry),
                "project_id" => id(entry),
                "enabled" => entry.is_boolean(),
                "config" => match value.get("plugin_id") {
                    Some(plugin) => plugin
                        .as_str()
                        .is_some_and(|s| source_config(s, entry, true)),
                    None => SOURCE_PLUGINS
                        .iter()
                        .any(|plugin| source_config(plugin, entry, true)),
                },
                "list_tool_args" | "update_tool_args" => object(entry, &[], &[]),
                "list_tool" | "update_tool" => entry == "",
                _ => false,
            })
        })
}
fn source_row(value: &Value) -> bool {
    object(
        value,
        &[
            "id",
            "mcp_server_id",
            "name",
            "plugin_id",
            "config",
            "list_tool",
            "list_tool_args",
            "update_tool",
            "update_tool_args",
            "last_synced_at",
            "enabled",
            "project_id",
            "created_at",
            "updated_at",
        ],
        &[],
    ) && id(&value["id"])
        && (value["mcp_server_id"].is_null() || id(&value["mcp_server_id"]))
        && named(&value["name"], 512)
        && stored_plugin(&value["plugin_id"])
        && value["plugin_id"].as_str().is_some_and(|plugin| {
            if SOURCE_PLUGINS.contains(&plugin) {
                source_config(plugin, &value["config"], false)
            } else {
                object(&value["config"], &[], &[])
            }
        })
        && clean_text(&value["list_tool"], 256)
        && object(&value["list_tool_args"], &[], &[])
        && clean_text(&value["update_tool"], 256)
        && object(&value["update_tool_args"], &[], &[])
        && (value["last_synced_at"].is_null() || clean_text(&value["last_synced_at"], 128))
        && value["enabled"].is_boolean()
        && id(&value["project_id"])
        && clean_text(&value["created_at"], 128)
        && clean_text(&value["updated_at"], 128)
        && bounded_bytes(value, 512_000)
}
fn source_export(value: &Value) -> bool {
    object(
        value,
        &[],
        &[
            "title",
            "description",
            "status",
            "priority",
            "assignee",
            "due_date",
            "labels",
            "complete_at_source",
        ],
    ) && bounded_bytes(value, 512_000)
        && value.as_object().is_some_and(|map| {
            !map.is_empty()
                && map.iter().all(|(key, entry)| match key.as_str() {
                    "status" => entry.as_str().is_some_and(|s| {
                        [
                            "not_started",
                            "triaging",
                            "agent_working",
                            "ready_for_review",
                            "agent_learning",
                            "completed",
                        ]
                        .contains(&s)
                    }),
                    "priority" => entry
                        .as_str()
                        .is_some_and(|s| ["low", "medium", "high", "urgent"].contains(&s)),
                    "labels" => source_strings(entry, 128),
                    "complete_at_source" => entry.is_null() || entry.is_boolean(),
                    "due_date" => entry.is_null() || clean_text(entry, 128),
                    "description" => text(entry, 65_536),
                    _ => text(entry, 4096),
                })
        })
}
fn source_request(operation: &str, value: &Value) -> bool {
    match operation {
        "taskSource:getAll" => {
            object(value, &[], &["projectId"])
                && value
                    .get("projectId")
                    .is_none_or(|entry| entry == "" || id(entry))
        }
        "taskSource:create" => object(value, &["data"], &[]) && source_input(&value["data"], true),
        "taskSource:update" => {
            object(value, &["id", "data"], &[])
                && id(&value["id"])
                && source_input(&value["data"], false)
        }
        "taskSource:delete" => object(value, &["id"], &[]) && id(&value["id"]),
        "taskSource:sync" | "taskSource:getUsers" => {
            object(value, &["sourceId"], &[]) && id(&value["sourceId"])
        }
        "taskSource:exportUpdate" => {
            object(value, &["taskId", "fields"], &[])
                && id(&value["taskId"])
                && source_export(&value["fields"])
        }
        "taskSource:reassign" => {
            object(value, &["taskId", "userIds", "assigneeDisplay"], &[])
                && id(&value["taskId"])
                && source_strings(&value["userIds"], 100)
                && value["userIds"].as_array().is_some_and(|items| {
                    items.iter().all(|entry| named(entry, 512))
                        && items
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<std::collections::HashSet<_>>()
                            .len()
                            == items.len()
                })
                && clean_text(&value["assigneeDisplay"], 4096)
        }
        _ => false,
    }
}
fn source_result(operation: &str, value: &Value) -> bool {
    match operation {
        "taskSource:getAll" => value
            .as_array()
            .is_some_and(|items| items.len() <= 256 && items.iter().all(source_row)),
        "taskSource:create" | "taskSource:update" => source_row(value),
        "taskSource:delete" => value.is_boolean(),
        "taskSource:sync" => {
            object(value, &["source_id", "imported", "updated", "errors"], &[])
                && id(&value["source_id"])
                && ["imported", "updated"]
                    .iter()
                    .all(|key| value[*key].as_u64().is_some_and(|n| n <= 1_000_000))
                && source_strings(&value["errors"], 128)
        }
        "taskSource:getUsers" => value.as_array().is_some_and(|items| {
            items.len() <= 512
                && items.iter().all(|item| {
                    object(item, &["id", "email", "name"], &[])
                        && named(&item["id"], 512)
                        && clean_text(&item["email"], 512)
                        && clean_text(&item["name"], 512)
                })
        }),
        "taskSource:reassign" => {
            object(value, &["success"], &["error"])
                && value["success"].is_boolean()
                && value
                    .get("error")
                    .is_none_or(|entry| clean_text(entry, 4096))
        }
        _ => false,
    }
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
                    "api_keys",
                ],
            ) && config
                .get("api_keys")
                .is_none_or(|keys| agent_keys(keys, false))
        })
}
fn agent_keys(value: &Value, masked: bool) -> bool {
    object(value, &[], &["openai", "anthropic", "cursor"])
        && value.as_object().is_some_and(|map| {
            map.values().all(|key| {
                if masked {
                    key == "__21x_api_key_set__"
                } else {
                    key.as_str().is_some_and(|s| {
                        s.len() <= 16384 && !s.chars().any(|c| c <= '\u{001f}' || c == '\u{007f}')
                    })
                }
            })
        })
}
fn masked_agent(value: &Value) -> bool {
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
        && text(&value["name"], 512)
        && text(&value["server_url"], 4096)
        && value["is_default"].is_boolean()
        && text(&value["created_at"], 128)
        && text(&value["updated_at"], 128)
        && object(
            &value["config"],
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
                "api_keys",
            ],
        )
        && value["config"]
            .get("api_keys")
            .is_none_or(|keys| agent_keys(keys, true))
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
const DETECTION_KEYS: &[&str] = &[
    "nodejs",
    "npm",
    "pnpm",
    "git",
    "gh",
    "glab",
    "tea",
    "rtk",
    "claudeCode",
    "opencode",
    "codex",
    "cursor",
    "pi",
];
const DETECTION_BACKENDS: &[&str] = &["claudeCode", "opencode", "codex", "cursor", "pi"];
fn detection_digits(value: &str) -> bool {
    !value.is_empty() && value.len() <= 6 && value.bytes().all(|b| b.is_ascii_digit())
}
fn detection_version(value: &Value) -> bool {
    let Some(version) = value.as_str() else {
        return false;
    };
    if version.len() > 128 {
        return false;
    }
    let lower = version.to_ascii_lowercase();
    let core = if let Some((core, suffix)) = lower.split_once('-') {
        let channel = suffix.split(['.', '-']).next().unwrap_or("");
        if !["alpha", "beta", "rc", "dev", "next"].contains(&channel)
            || suffix.len() != channel.len() && !detection_digits(&suffix[channel.len() + 1..])
        {
            return false;
        }
        core
    } else if let Some((core, build)) = lower.split_once(".windows.") {
        if !detection_digits(build) {
            return false;
        }
        core
    } else {
        lower.as_str()
    };
    let parts = core.split('.').collect::<Vec<_>>();
    (parts.len() == 2 || parts.len() == 3) && parts.iter().all(|s| detection_digits(s))
}
fn detection_pi_supported(value: &Value) -> bool {
    let Some(version) = value.as_str() else {
        return false;
    };
    let mut parts = version
        .split('.')
        .take(3)
        .map(|p| {
            p.bytes()
                .take_while(u8::is_ascii_digit)
                .fold(0u32, |n, b| n * 10 + u32::from(b - b'0'))
        })
        .collect::<Vec<_>>();
    parts.resize(3, 0);
    parts.as_slice() >= &[0, 80, 5]
}
fn detection_result(value: &Value) -> bool {
    if !object(value, DETECTION_KEYS, &[]) || !bounded_bytes(value, 8192) {
        return false;
    }
    for key in DETECTION_KEYS {
        let row = &value[*key];
        let Some(installed) = row["installed"].as_bool() else {
            return false;
        };
        if !(row["version"].is_null() || detection_version(&row["version"]))
            || !installed && !row["version"].is_null()
        {
            return false;
        }
        if *key == "pi" {
            if !object(row, &["installed", "version", "supported", "reason"], &[]) {
                return false;
            }
            let supported = installed && detection_pi_supported(&row["version"]);
            if row["supported"] != supported {
                return false;
            }
            if supported {
                if !row["reason"].is_null() {
                    return false;
                }
            } else {
                let reason = if !installed {
                    "Pi CLI is not installed.".to_owned()
                } else if let Some(version) = row["version"].as_str() {
                    format!("Pi {version} is unsupported. Update to 0.80.5 or newer.")
                } else {
                    "Could not determine the Pi version. Pi 0.80.5 or newer is required.".to_owned()
                };
                if row["reason"] != reason {
                    return false;
                }
            }
        } else if *key == "rtk" {
            if !object(
                row,
                &["installed", "version", "configured", "integrations"],
                &["reason"],
            ) || !object(&row["integrations"], DETECTION_BACKENDS, &[])
                || !DETECTION_BACKENDS
                    .iter()
                    .all(|key| row["integrations"][*key].is_boolean())
            {
                return false;
            }
            let required = DETECTION_BACKENDS
                .iter()
                .filter(|key| {
                    value[**key]["installed"] == true && value[**key]["supported"] != false
                })
                .copied()
                .collect::<Vec<&str>>();
            let configured = installed
                && !required.is_empty()
                && required.iter().all(|key| row["integrations"][*key] == true);
            if row["configured"] != configured {
                return false;
            }
        } else if !object(row, &["installed", "version"], &["reason"]) {
            return false;
        }
        if *key != "pi"
            && row.get("reason").is_some_and(|reason| {
                installed
                    || !matches!(
                        reason.as_str(),
                        Some("CLI detection timed out." | "CLI detection failed.")
                    )
            })
        {
            return false;
        }
    }
    true
}
const ARTIFACT_COMMANDS: &[&str] = &["artifacts:scan", "artifacts:read"];
fn artifact_path(value: &Value) -> bool {
    value.as_str().is_some_and(|path| {
        !path.is_empty()
            && path.len() <= 2048
            && !path.starts_with('/')
            && !path
                .chars()
                .any(|c| c <= '\u{001f}' || c == '\u{007f}' || c == '\\' || c == ':')
            && path
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != "..")
    })
}
fn artifact_label(value: &Value, maximum: usize) -> bool {
    value.as_str().is_some_and(|text| {
        text.len() <= maximum && !text.chars().any(|c| c <= '\u{001f}' || c == '\u{007f}')
    })
}
fn artifact_entry(value: &Value) -> bool {
    object(
        value,
        &["path", "title", "type", "updatedAt", "size"],
        &["workpieceKey", "files"],
    ) && artifact_path(&value["path"])
        && artifact_label(&value["title"], 512)
        && value["title"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
        && matches!(
            value["type"].as_str(),
            Some("markdown" | "html" | "image" | "file")
        )
        && value["updatedAt"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n >= 0.0)
        && value["size"]
            .as_u64()
            .is_some_and(|n| n <= 9007199254740991)
        && value
            .get("workpieceKey")
            .is_none_or(|key| artifact_label(key, 2048) && key != "")
        && value.get("files").is_none_or(|files| {
            files.as_array().is_some_and(|rows| {
                rows.len() <= 500
                    && rows.iter().all(artifact_path)
                    && rows.contains(&value["path"])
                    && rows
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<std::collections::HashSet<_>>()
                        .len()
                        == rows.len()
            })
        })
}
fn artifact_content(value: &Value) -> bool {
    if value.is_null() {
        return true;
    }
    if !object(value, &["kind", "content"], &["mimeType"]) {
        return false;
    }
    let Some(content) = value["content"].as_str() else {
        return false;
    };
    let mime = value.get("mimeType").and_then(Value::as_str);
    let mimes = [
        "text/markdown",
        "text/html",
        "text/plain",
        "text/css",
        "text/csv",
        "text/javascript",
        "text/typescript",
        "application/json",
        "application/xml",
        "application/yaml",
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/svg+xml",
        "image/webp",
        "application/octet-stream",
    ];
    if value.get("mimeType").is_some() && !mime.is_some_and(|s| mimes.contains(&s)) {
        return false;
    }
    if value["kind"] == "text" {
        return content.len() <= 128 * 1024
            && mime.is_none_or(|m| !m.starts_with("image/") && m != "application/octet-stream");
    }
    if value["kind"] != "data_url" {
        return false;
    }
    let Some(mime) = mime else {
        return false;
    };
    if ![
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/svg+xml",
        "image/webp",
        "application/octet-stream",
    ]
    .contains(&mime)
    {
        return false;
    }
    let prefix = format!("data:{mime};base64,");
    let Some(body) = content.strip_prefix(&prefix) else {
        return false;
    };
    let padding = body.bytes().rev().take_while(|b| *b == b'=').count();
    body.len() <= (512usize * 1024).div_ceil(3) * 4
        && body.len() % 4 == 0
        && padding <= 2
        && body[..body.len() - padding]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/'))
        && body.len() / 4 * 3 >= padding
        && body.len() / 4 * 3 - padding <= 512 * 1024
}
fn artifact_request(operation: &str, value: &Value) -> bool {
    match operation {
        "artifacts:scan" => object(value, &["taskId"], &[]) && id(&value["taskId"]),
        "artifacts:read" => {
            object(value, &["taskId", "relativePath"], &[])
                && id(&value["taskId"])
                && artifact_path(&value["relativePath"])
        }
        _ => false,
    }
}
fn artifact_result(operation: &str, value: &Value) -> bool {
    if operation == "artifacts:read" {
        return artifact_content(value);
    }
    value.as_array().is_some_and(|rows| {
        rows.len() <= 500
            && rows.iter().all(artifact_entry)
            && rows
                .iter()
                .filter_map(|r| r["path"].as_str())
                .collect::<std::collections::HashSet<_>>()
                .len()
                == rows.len()
            && rows
                .iter()
                .map(|r| r.get("files").and_then(Value::as_array).map_or(1, Vec::len))
                .sum::<usize>()
                <= 500
    })
}

const VOICE_COMMANDS: &[&str] = &[
    "voice:getSnapshot",
    "voice:setEnabled",
    "voice:getRuntime",
    "voice:installRuntime",
    "voice:removeRuntime",
    "voice:installModel",
    "voice:removeModel",
    "voice:removeAllModels",
    "voice:selectModel",
    "voice:setEndpointSilence",
    "voice:tts:getSnapshot",
    "voice:tts:setEnabled",
    "voice:tts:setEngine",
    "voice:tts:setVoice",
    "voice:tts:setSpeed",
    "voice:tts:setMaxChars",
    "voice:tts:setSpeakActionResults",
    "voice:tts:setOnlyVoiceTurns",
    "voice:tts:installModel",
    "voice:tts:selectModel",
    "voice:tts:removeModel",
];
const VOICE_ERROR: &str = "Voice management failed. Check the local runtime and model.";
const VOICE_UNAVAILABLE: &str =
    "Voice capture and audio playback are unavailable in this desktop host.";
fn voice_text(value: &Value, max: usize, multiline: bool) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() <= max
            && !s
                .chars()
                .any(|c| c == '\0' || !multiline && (c <= '\u{001f}' || c == '\u{007f}'))
    })
}
fn voice_number(value: &Value, min: f64, max: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n.is_finite() && n >= min && n <= max)
}
fn voice_model_id(value: &Value, tts: bool) -> bool {
    if tts {
        matches!(
            value.as_str(),
            Some("kitten-nano-en-v0_2" | "kokoro-en-v0_19")
        )
    } else {
        matches!(
            value.as_str(),
            Some(
                "nemo-parakeet-tdt-0.6b-v3"
                    | "sherpa-streaming-zipformer-en"
                    | "nemo-fast-conformer-en-480ms"
                    | "nemotron-streaming-en-560ms"
            )
        )
    }
}
fn voice_id(value: &Value) -> bool {
    if value == "" {
        return true;
    }
    if !voice_text(value, 512, false) {
        return false;
    }
    let Some(s) = value.as_str() else {
        return false;
    };
    if s.starts_with("system:") {
        return s.len() > 7;
    }
    let pieces: Vec<_> = s.split(':').collect();
    pieces.len() == 3
        && pieces[0] == "local"
        && voice_model_id(&Value::String(pieces[1].into()), true)
        && (pieces[2] == "0"
            || !pieces[2].starts_with('0')
                && pieces[2].len() <= 3
                && !pieces[2].is_empty()
                && pieces[2].bytes().all(|c| c.is_ascii_digit()))
}
fn voice_runtime(v: &Value) -> bool {
    object(
        v,
        &["installed", "version", "modulePath", "sizeBytes"],
        &["installing", "progress", "error"],
    ) && v["installed"].is_boolean()
        && (v["version"].is_null() || voice_text(&v["version"], 128, false))
        && (v["modulePath"].is_null() || v["modulePath"] == "__21x_local_voice_runtime__")
        && integer(&v["sizeBytes"])
        && v.get("installing").is_none_or(Value::is_boolean)
        && v.get("progress").is_none_or(|x| voice_number(x, 0.0, 1.0))
        && v.get("error").is_none_or(|x| x == VOICE_ERROR)
}
fn voice_model(v: &Value, tts: bool) -> bool {
    let common = [
        "id",
        "label",
        "description",
        "license",
        "licenseUrl",
        "languages",
        "installed",
        "active",
        "installing",
        "progress",
        "sizeBytes",
        "downloadable",
    ];
    let fields: Vec<&str> = common
        .into_iter()
        .chain(if tts {
            vec!["unpackedBytes", "speakerCount"]
        } else {
            vec![]
        })
        .collect();
    object(
        v,
        &fields,
        if tts {
            &["error"]
        } else {
            &["error", "kind", "phase", "legacy"]
        },
    ) && voice_model_id(&v["id"], tts)
        && ["label", "description", "license", "licenseUrl"]
            .iter()
            .all(|key| {
                voice_text(
                    &v[key],
                    if *key == "description" { 4096 } else { 1024 },
                    false,
                )
            })
        && v["languages"].as_array().is_some_and(|items| {
            items.len() <= 64 && items.iter().all(|x| voice_text(x, 64, false))
        })
        && ["installed", "active", "installing", "downloadable"]
            .iter()
            .all(|key| v[key].is_boolean())
        && voice_number(&v["progress"], 0.0, 1.0)
        && integer(&v["sizeBytes"])
        && v.get("error").is_none_or(|x| x == VOICE_ERROR)
        && if tts {
            integer(&v["unpackedBytes"])
                && integer(&v["speakerCount"])
                && voice_number(&v["speakerCount"], 0.0, 512.0)
        } else {
            v.get("kind")
                .is_none_or(|x| matches!(x.as_str(), Some("streaming" | "offline")))
                && v.get("phase")
                    .is_none_or(|x| matches!(x.as_str(), Some("downloading" | "verifying")))
                && v.get("legacy").is_none_or(Value::is_boolean)
        }
}
fn voice_models(v: &Value, tts: bool) -> bool {
    v.as_array().is_some_and(|rows| {
        rows.len() <= 16
            && rows.iter().all(|x| voice_model(x, tts))
            && rows
                .iter()
                .filter_map(|x| x["id"].as_str())
                .collect::<std::collections::HashSet<_>>()
                .len()
                == rows.len()
    })
}
fn voice_engine(v: &Value, tts: bool) -> bool {
    if v["state"] == "loading" {
        return object(v, &["state"], &[]);
    }
    if v["state"] == "ready" {
        return if tts {
            object(
                v,
                &["state", "engine", "modelId", "voiceId", "sampleRate"],
                &[],
            ) && matches!(v["engine"].as_str(), Some("system" | "local"))
                && (v["modelId"] == "" || voice_model_id(&v["modelId"], true))
                && voice_id(&v["voiceId"])
                && integer(&v["sampleRate"])
                && voice_number(&v["sampleRate"], 1.0, 192000.0)
        } else {
            object(v, &["state", "modelId", "engine"], &[])
                && voice_model_id(&v["modelId"], false)
                && voice_text(&v["engine"], 128, false)
        };
    }
    object(v, &["state", "message"], &[])
        && (if tts {
            matches!(
                v["state"].as_str(),
                Some("unavailable" | "model_missing" | "error")
            )
        } else {
            matches!(
                v["state"].as_str(),
                Some("engine_missing" | "model_missing" | "error")
            )
        })
        && (v["message"] == VOICE_ERROR || v["message"] == VOICE_UNAVAILABLE)
}
fn voice_status(v: &Value, snapshot: bool) -> bool {
    let common = ["enabled", "engine", "models", "shortcut", "runtime"];
    let fields: Vec<&str> = common
        .into_iter()
        .chain(if snapshot {
            vec!["state", "turnId", "partial", "final"]
        } else {
            vec![]
        })
        .collect();
    object(v, &fields, &[])
        && v["enabled"].is_boolean()
        && voice_engine(&v["engine"], false)
        && voice_models(&v["models"], false)
        && voice_text(&v["shortcut"], 256, false)
        && voice_runtime(&v["runtime"])
        && (!snapshot
            || matches!(
                v["state"].as_str(),
                Some(
                    "disabled"
                        | "idle"
                        | "model_needed"
                        | "permission_needed"
                        | "listening"
                        | "transcribing"
                        | "awaiting_confirmation"
                        | "executing"
                        | "waiting_for_agent"
                        | "speaking"
                        | "error"
                )
            ) && (v["turnId"].is_null() || voice_text(&v["turnId"], 128, false))
                && voice_text(&v["partial"], 65536, true)
                && voice_text(&v["final"], 65536, true))
}
fn voice_tts_voice(v: &Value) -> bool {
    object(
        v,
        &[
            "id",
            "label",
            "engine",
            "speakerId",
            "modelId",
            "language",
            "description",
        ],
        &[],
    ) && voice_id(&v["id"])
        && v["id"] != ""
        && matches!(v["engine"].as_str(), Some("system" | "local"))
        && integer(&v["speakerId"])
        && voice_number(&v["speakerId"], 0.0, 512.0)
        && (v["modelId"] == "" || voice_model_id(&v["modelId"], true))
        && ["label", "language", "description"].iter().all(|key| {
            voice_text(
                &v[key],
                if *key == "description" { 4096 } else { 512 },
                false,
            )
        })
}
fn voice_hosted_off(v: &Value) -> bool {
    object(
        v,
        &[
            "keySet",
            "disclosureAccepted",
            "modelId",
            "models",
            "voices",
            "error",
            "usage",
        ],
        &[],
    ) && v["keySet"] == false
        && v["disclosureAccepted"] == false
        && v["modelId"] == "eleven_flash_v2_5"
        && v["models"].as_array().is_some_and(Vec::is_empty)
        && v["voices"].as_array().is_some_and(Vec::is_empty)
        && (v["error"].is_null()
            || object(&v["error"], &["kind", "message"], &[])
                && v["error"]["kind"] == "unknown"
                && v["error"]["message"] == "Hosted speech is unavailable in this desktop host.")
        && v["usage"].is_null()
}
fn voice_tts_snapshot(v: &Value) -> bool {
    object(
        v,
        &[
            "enabled",
            "engine",
            "status",
            "voices",
            "voiceId",
            "speed",
            "maxChars",
            "speakActionResults",
            "onlyVoiceTurns",
            "models",
            "speaking",
            "elevenlabs",
        ],
        &[],
    ) && v["enabled"].is_boolean()
        && matches!(v["engine"].as_str(), Some("system" | "local"))
        && voice_engine(&v["status"], true)
        && v["voices"].as_array().is_some_and(|rows| {
            rows.len() <= 256
                && rows.iter().all(voice_tts_voice)
                && rows
                    .iter()
                    .filter_map(|x| x["id"].as_str())
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    == rows.len()
        })
        && voice_id(&v["voiceId"])
        && voice_number(&v["speed"], 0.5, 2.0)
        && integer(&v["maxChars"])
        && voice_number(&v["maxChars"], 1.0, 6000.0)
        && v["speakActionResults"].is_boolean()
        && v["onlyVoiceTurns"].is_boolean()
        && voice_models(&v["models"], true)
        && v["speaking"].is_boolean()
        && voice_hosted_off(&v["elevenlabs"])
}
fn voice_request(op: &str, v: &Value) -> bool {
    match op {
        "voice:setEnabled" | "voice:tts:setEnabled" => {
            object(v, &["enabled"], &[]) && v["enabled"].is_boolean()
        }
        "voice:installModel" | "voice:removeModel" | "voice:selectModel" => {
            object(v, &["id"], &[]) && voice_model_id(&v["id"], false)
        }
        "voice:tts:installModel" | "voice:tts:removeModel" | "voice:tts:selectModel" => {
            object(v, &["id"], &[]) && voice_model_id(&v["id"], true)
        }
        "voice:setEndpointSilence" => {
            object(v, &["seconds"], &[])
                && v["seconds"].as_f64().is_some_and(|n| n >= 0.1 && n <= 10.0)
        }
        "voice:tts:setEngine" => {
            object(v, &["engine"], &[]) && matches!(v["engine"].as_str(), Some("system" | "local"))
        }
        "voice:tts:setVoice" => object(v, &["voiceId"], &[]) && voice_id(&v["voiceId"]),
        "voice:tts:setSpeed" => object(v, &["speed"], &[]) && voice_number(&v["speed"], 0.5, 2.0),
        "voice:tts:setMaxChars" => {
            object(v, &["maxChars"], &[])
                && integer(&v["maxChars"])
                && voice_number(&v["maxChars"], 1.0, 6000.0)
        }
        "voice:tts:setSpeakActionResults" | "voice:tts:setOnlyVoiceTurns" => {
            object(v, &["on"], &[]) && v["on"].is_boolean()
        }
        _ => object(v, &[], &[]),
    }
}
fn voice_result(op: &str, v: &Value) -> bool {
    match op {
        "voice:getSnapshot" | "voice:setEnabled" => voice_status(v, true),
        "voice:getRuntime" | "voice:installRuntime" | "voice:removeRuntime" => voice_runtime(v),
        "voice:installModel" => voice_model(v, false),
        "voice:removeModel" | "voice:selectModel" => voice_models(v, false),
        "voice:removeAllModels" | "voice:setEndpointSilence" => {
            object(v, &["success"], &[]) && v["success"].is_boolean()
        }
        _ => voice_tts_snapshot(v),
    }
}

const GIT_PROVIDER_COMMANDS: &[&str] = &[
    "github:checkCli",
    "github:fetchOrgs",
    "github:fetchOrgRepos",
    "github:fetchUserRepos",
    "github:fetchPullRequestDetails",
    "gitlab:checkCli",
    "gitlab:fetchOrgs",
    "gitlab:fetchOrgRepos",
    "gitlab:fetchUserRepos",
    "forgejo:checkCli",
    "forgejo:setLogin",
    "forgejo:fetchOrgs",
    "forgejo:fetchOrgRepos",
    "forgejo:fetchUserRepos",
    "git:recordRepoProviders",
];
fn git_text(v: &Value, max: usize, multiline: bool) -> bool {
    v.as_str().is_some_and(|s| {
        let lower = s.to_ascii_lowercase();
        let token = [
            "ghp_",
            "gho_",
            "ghu_",
            "ghs_",
            "ghr_",
            "github_pat_",
            "glpat-",
            "__21x_",
        ]
        .iter()
        .any(|p| lower.starts_with(*p))
            || lower.strip_prefix("bearer").is_some_and(|tail| {
                tail.chars()
                    .next()
                    .is_some_and(|c| c == '\u{feff}' || (c.is_whitespace() && c != '\u{0085}'))
            });
        s.len() <= max
            && !token
            && !s.chars().any(|c| {
                c == '\u{007f}'
                    || (c <= '\u{001f}' && !(multiline && matches!(c, '\t' | '\n' | '\r')))
            })
    })
}
fn git_segment(s: &str) -> bool {
    !matches!(s, "." | ".." | "__proto__" | "constructor" | "prototype")
        && !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_')
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
}
fn git_path(v: &Value, repository: bool) -> bool {
    git_text(v, 512, false)
        && v.as_str().is_some_and(|s| {
            let parts: Vec<_> = s.split('/').collect();
            parts.len() >= (if repository { 2 } else { 1 })
                && parts.len() <= (if repository { 16 } else { 15 })
                && parts.iter().all(|p| git_segment(p))
        })
}
fn git_login(v: &Value) -> bool {
    git_text(v, 128, false)
        && v.as_str().is_some_and(|s| {
            s == js_trim(s)
                && !matches!(s, "__proto__" | "constructor" | "prototype")
                && s.bytes().next().is_some_and(|c| c.is_ascii_alphanumeric())
                && s.bytes().all(|c| {
                    c.is_ascii_alphanumeric() || matches!(c, b' ' | b'.' | b'_' | b'@' | b'-')
                })
        })
}
fn git_address(v: &Value) -> bool {
    git_text(v, 2048, false)
        && v.as_str().is_some_and(|s| {
            s == js_trim(s)
                && url::Url::parse(s).is_ok_and(|u| {
                    matches!(u.scheme(), "http" | "https")
                        && u.username().is_empty()
                        && u.password().is_none_or(|p| p.is_empty())
                        && u.query().is_none_or(|q| q.is_empty())
                        && u.fragment().is_none_or(|f| f.is_empty())
                })
        })
}
fn git_pr_address(v: &Value) -> bool {
    git_address(v)
        && v.as_str().is_some_and(|s| {
            url::Url::parse(s).is_ok_and(|u| {
                let parts: Vec<_> = u.path().split('/').filter(|p| !p.is_empty()).collect();
                parts.len() == 4
                    && git_segment(parts[0])
                    && git_segment(parts[1])
                    && (if u.host_str() == Some("github.com") {
                        u.scheme() == "https" && u.port().is_none() && parts[2] == "pull"
                    } else {
                        parts[2] == "pulls"
                    })
                    && !parts[3].is_empty()
                    && parts[3].len() <= 10
                    && parts[3].as_bytes()[0] != b'0'
                    && parts[3].bytes().all(|c| c.is_ascii_digit())
            })
        })
}
fn git_unique(v: &Value, max: usize, key: Option<&str>, valid: fn(&Value) -> bool) -> bool {
    v.as_array().is_some_and(|rows| {
        let mut seen = std::collections::HashSet::new();
        rows.len() <= max
            && rows.iter().all(|row| {
                valid(row)
                    && seen.insert(if let Some(k) = key {
                        row[k].as_str().unwrap()
                    } else {
                        row.as_str().unwrap()
                    })
            })
    })
}
fn git_organization(v: &Value) -> bool {
    git_path(v, false)
}
fn git_repository(v: &Value) -> bool {
    git_path(v, true)
}
fn git_cli(v: &Value, tea: bool) -> bool {
    object(
        v,
        if tea {
            &["installed", "authenticated", "logins", "code"]
        } else {
            &["installed", "authenticated"]
        },
        if tea {
            &["username", "login", "serverUrl", "message"]
        } else {
            &["username"]
        },
    ) && v["installed"].is_boolean()
        && v["authenticated"].is_boolean()
        && (v["authenticated"] != true || v["installed"] == true)
        && v.get("username")
            .is_none_or(|n| git_text(n, 128, false) && n.as_str().is_some_and(git_segment))
        && (!tea
            || (v.get("login").is_none_or(git_login)
                && v.get("serverUrl").is_none_or(git_address)
                && git_unique(&v["logins"], 64, Some("name"), git_login_row)
                && match v["code"].as_str() {
                    Some("ready") => v.get("message").is_none(),
                    Some("not-installed") => v
                        .get("message")
                        .is_none_or(|m| m == "The tea CLI is unavailable."),
                    Some("no-login") => v
                        .get("message")
                        .is_none_or(|m| m == "No tea login is configured."),
                    Some("login-selection-required") => v
                        .get("message")
                        .is_none_or(|m| m == "Choose a configured tea login."),
                    Some("login-not-found") => v
                        .get("message")
                        .is_none_or(|m| m == "The selected tea login is unavailable."),
                    Some("unauthorized") => v
                        .get("message")
                        .is_none_or(|m| m == "The configured tea login was not authorized."),
                    Some("unreachable") => v
                        .get("message")
                        .is_none_or(|m| m == "The configured Forgejo server could not be reached."),
                    Some("error") => v
                        .get("message")
                        .is_none_or(|m| m == "The Forgejo request failed."),
                    _ => false,
                }))
}
fn git_login_row(v: &Value) -> bool {
    object(v, &["name", "url", "sshHost", "user", "isDefault"], &[])
        && git_login(&v["name"])
        && git_address(&v["url"])
        && git_text(&v["sshHost"], 512, false)
        && v["sshHost"].as_str().is_some_and(|s| {
            s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'[' | b']' | b':' | b'-'))
        })
        && git_text(&v["user"], 128, false)
        && v["isDefault"].is_boolean()
}
fn git_repo(v: &Value) -> bool {
    object(
        v,
        &[
            "name",
            "fullName",
            "defaultBranch",
            "cloneUrl",
            "description",
            "isPrivate",
        ],
        &[],
    ) && git_text(&v["name"], 128, false)
        && v["name"].as_str().is_some_and(git_segment)
        && git_repository(&v["fullName"])
        && v["fullName"]
            .as_str()
            .is_some_and(|s| s.rsplit('/').next() == v["name"].as_str())
        && git_text(&v["defaultBranch"], 256, false)
        && v["defaultBranch"] != ""
        && git_address(&v["cloneUrl"])
        && git_text(&v["description"], 4096, true)
        && v["isPrivate"].is_boolean()
}
fn git_pr(v: &Value) -> bool {
    object(
        v,
        &[
            "url",
            "repository",
            "number",
            "title",
            "body",
            "state",
            "isDraft",
            "reviewDecision",
            "author",
            "baseRefName",
            "headRefName",
            "additions",
            "deletions",
            "changedFiles",
            "commentsCount",
            "reviewsCount",
            "createdAt",
            "updatedAt",
            "checks",
        ],
        &["mergeStateStatus", "mergedAt", "closedAt"],
    ) && git_pr_address(&v["url"])
        && git_repository(&v["repository"])
        && integer(&v["number"])
        && v["number"].as_u64().is_some_and(|n| n > 0)
        && git_text(&v["title"], 1024, false)
        && git_text(&v["body"], 131072, true)
        && matches!(v["state"].as_str(), Some("open" | "closed" | "merged"))
        && v["isDraft"].is_boolean()
        && matches!(
            v["reviewDecision"].as_str(),
            Some("approved" | "changes_requested" | "review_required" | "none")
        )
        && object(&v["author"], &["login"], &["avatarUrl", "url"])
        && git_text(&v["author"]["login"], 128, false)
        && v["author"]["login"].as_str().is_some_and(git_segment)
        && ["avatarUrl", "url"]
            .iter()
            .all(|&k| v["author"].get(k).is_none_or(git_address))
        && ["baseRefName", "headRefName"]
            .iter()
            .all(|&k| git_text(&v[k], 256, false))
        && [
            "additions",
            "deletions",
            "changedFiles",
            "commentsCount",
            "reviewsCount",
        ]
        .iter()
        .all(|&k| integer(&v[k]))
        && ["createdAt", "updatedAt"]
            .iter()
            .all(|&k| git_text(&v[k], 64, false))
        && v.get("mergeStateStatus")
            .is_none_or(|x| git_text(x, 128, false))
        && ["mergedAt", "closedAt"]
            .iter()
            .all(|&k| v.get(k).is_none_or(|x| git_text(x, 64, false)))
        && v["checks"].as_array().is_some_and(|rows| {
            rows.len() <= 128
                && rows.iter().all(|r| {
                    object(r, &["name", "state"], &["url"])
                        && git_text(&r["name"], 256, false)
                        && matches!(
                            r["state"].as_str(),
                            Some("passed" | "failed" | "pending" | "skipped")
                        )
                        && r.get("url").is_none_or(git_address)
                })
        })
}
fn git_request(op: &str, v: &Value) -> bool {
    match op {
        "git:recordRepoProviders" => {
            object(v, &["repoFullNames", "provider"], &[])
                && matches!(
                    v["provider"].as_str(),
                    Some("github" | "gitlab" | "forgejo")
                )
                && git_unique(&v["repoFullNames"], 128, None, git_repository)
        }
        "forgejo:setLogin" => {
            object(v, &["loginName"], &[])
                && (v["loginName"].is_null() || git_login(&v["loginName"]))
        }
        "github:fetchPullRequestDetails" => object(v, &["url"], &[]) && git_pr_address(&v["url"]),
        _ if op.ends_with(":fetchOrgRepos") => {
            object(v, &["org"], &[])
                && git_organization(&v["org"])
                && (op.starts_with("gitlab:")
                    || v["org"].as_str().is_some_and(|s| !s.contains('/')))
        }
        _ => object(v, &[], &[]),
    }
}
fn git_result(op: &str, v: &Value) -> bool {
    match op {
        "forgejo:checkCli" | "forgejo:setLogin" => git_cli(v, true),
        "github:checkCli" | "gitlab:checkCli" => git_cli(v, false),
        "github:fetchPullRequestDetails" => git_pr(v),
        _ if op.ends_with(":fetchOrgs") => git_unique(v, 512, None, git_organization),
        _ => git_unique(v, 2048, Some("fullName"), git_repo),
    }
}

const WORKSPACE_FILE_COMMANDS: &[&str] = &[
    "tasks:getWorkspaceDir",
    "shell:readTextFile",
    "shell:openPath",
    "shell:showItemInFolder",
];
fn workspace_file_path(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        if s.is_empty() || s.len() > 4096 || s.chars().any(|c| c <= '\u{001f}' || c == '\u{007f}') {
            return false;
        }
        let b = s.as_bytes();
        s.starts_with('/')
            || b.len() >= 3
                && b[0].is_ascii_alphabetic()
                && b[1] == b':'
                && matches!(b[2], b'/' | b'\\')
            || s.strip_prefix("\\\\").is_some_and(|tail| {
                let mut parts = tail.split(['/', '\\']);
                parts.next().is_some_and(|p| !p.is_empty())
                    && parts.next().is_some_and(|p| !p.is_empty())
            })
    })
}
pub fn valid_request(operation: &str, value: &Value) -> bool {
    if WORKSPACE_FILE_COMMANDS.contains(&operation) {
        return if operation == "tasks:getWorkspaceDir" {
            object(value, &["taskId"], &[]) && id(&value["taskId"])
        } else {
            object(value, &["filePath"], &[]) && workspace_file_path(&value["filePath"])
        };
    }
    if GIT_PROVIDER_COMMANDS.contains(&operation) {
        return bounded_bytes(value, 1024 * 1024) && git_request(operation, value);
    }
    if VOICE_COMMANDS.contains(&operation) {
        return bounded_bytes(value, 8192) && voice_request(operation, value);
    }
    if ARTIFACT_COMMANDS.contains(&operation) {
        return bounded_bytes(value, 8192) && artifact_request(operation, value);
    }
    if operation == "agent-installer:detect" {
        return object(value, &[], &[]);
    }
    if MOBILE_COMMANDS.contains(&operation) {
        return bounded_bytes(value, 1024 * 1024) && mobile_request(operation, value);
    }
    if CONTEXT_COMMANDS.contains(&operation) {
        let key = if operation == "sessionContext:getSnapshot" {
            "scope"
        } else {
            "policy"
        };
        return object(value, &[key], &[])
            && bounded_bytes(value, 512_000)
            && if key == "scope" {
                context_scope(&value[key])
            } else {
                context_policy(&value[key])
            };
    }
    if CLAUDE_COMMANDS.contains(&operation) {
        return bounded_bytes(value, 1024 * 1024) && claude_request(operation, value);
    }
    if PLUGIN_COMMANDS.contains(&operation) {
        return bounded_bytes(value, 512_000) && plugin_request(operation, value);
    }
    if CONNECTOR_COMMANDS.contains(&operation) {
        return bounded_bytes(value, 1024 * 1024) && connector_request(operation, value);
    }
    if MCP_COMMANDS.contains(&operation) {
        return bounded_bytes(value, 1024 * 1024) && mcp_request(operation, value);
    }
    if SOURCE_COMMANDS.contains(&operation) {
        return bounded_bytes(value, 512000) && source_request(operation, value);
    }
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
    if WORKSPACE_FILE_COMMANDS.contains(&operation) {
        if matches!(operation, "shell:openPath" | "shell:showItemInFolder") {
            return object(value, &["defined"], &[]) && value["defined"] == false;
        }
        if !object(value, &["defined", "value"], &[])
            || value["defined"] != true
            || !bounded_bytes(value, 889_999)
        {
            return false;
        }
        let v = &value["value"];
        return if operation == "tasks:getWorkspaceDir" {
            workspace_file_path(v)
        } else {
            v.is_null()
                || object(v, &["content", "size"], &[])
                    && v["content"].as_str().is_some_and(|s| s.len() <= 131072)
                    && v["size"].as_u64().is_some_and(|s| {
                        s <= 9007199254740991 && (s <= 131072 || v["content"] == "")
                    })
        };
    }
    if GIT_PROVIDER_COMMANDS.contains(&operation) {
        return if operation == "git:recordRepoProviders" {
            object(value, &["defined"], &[]) && value["defined"] == false
        } else {
            object(value, &["defined", "value"], &[])
                && value["defined"] == true
                && bounded_bytes(value, 889_999)
                && git_result(operation, &value["value"])
        };
    }
    if VOICE_COMMANDS.contains(&operation) {
        return object(value, &["defined", "value"], &[])
            && value["defined"] == true
            && bounded_bytes(value, 262208)
            && bounded_bytes(&value["value"], 262144)
            && voice_result(operation, &value["value"]);
    }
    if operation == "agent-installer:detect" {
        return object(value, &["defined", "value"], &[])
            && value["defined"] == true
            && bounded_bytes(value, 8256)
            && detection_result(&value["value"]);
    }
    if ARTIFACT_COMMANDS.contains(&operation) {
        return object(value, &["defined", "value"], &[])
            && value["defined"] == true
            && bounded_bytes(value, 900_064)
            && bounded_bytes(&value["value"], 900_000)
            && artifact_result(operation, &value["value"]);
    }
    if MOBILE_COMMANDS.contains(&operation) {
        return object(value, &["defined", "value"], &[])
            && value["defined"] == true
            && bounded_bytes(value, 1024 * 1024)
            && bounded_bytes(&value["value"], 64 * 1024)
            && mobile_result(operation, &value["value"]);
    }
    if CONTEXT_COMMANDS.contains(&operation) {
        return object(value, &["defined", "value"], &[])
            && value["defined"] == true
            && bounded_bytes(value, 1024 * 1024)
            && bounded_bytes(&value["value"], 512_000)
            && if operation == "sessionContext:getSnapshot" {
                context_snapshot(&value["value"])
            } else {
                context_policy(&value["value"])
            };
    }
    if CLAUDE_COMMANDS.contains(&operation) {
        if !object(value, &["defined"], &["value"]) || !bounded_bytes(value, 1024 * 1024) {
            return false;
        }
        if value["defined"] == false {
            return value.get("value").is_none()
                && matches!(
                    operation,
                    "claudePlugin:enablePlugin" | "claudePlugin:disablePlugin"
                );
        }
        return value["defined"] == true
            && value.get("value").is_some_and(|result| {
                bounded_bytes(result, 768 * 1024) && claude_result(operation, result)
            });
    }
    if PLUGIN_COMMANDS.contains(&operation) {
        return object(value, &["defined", "value"], &[])
            && value["defined"] == true
            && bounded_bytes(value, 1024 * 1024)
            && bounded_bytes(&value["value"], 512_000)
            && plugin_result(operation, &value["value"]);
    }
    if CONNECTOR_COMMANDS.contains(&operation) {
        if !object(value, &["defined"], &["value"]) || !bounded_bytes(value, 1024 * 1024) {
            return false;
        }
        if value["defined"] == false {
            return operation == "connectors:clearCredentials" && value.get("value").is_none();
        }
        return value["defined"] == true
            && value.get("value").is_some_and(|result| {
                bounded_bytes(result, 64 * 1024) && connector_result(operation, result)
            });
    }
    if MCP_COMMANDS.contains(&operation) || SOURCE_COMMANDS.contains(&operation) {
        if !bounded_bytes(value, 1024 * 1024) || !object(value, &["defined"], &["value"]) {
            return false;
        }
        if value["defined"] == false {
            return value.get("value").is_none()
                && matches!(
                    operation,
                    "mcp:update"
                        | "mcp:revokeOAuthToken"
                        | "taskSource:update"
                        | "taskSource:exportUpdate"
                );
        }
        if value["defined"] != true || value.get("value").is_none() {
            return false;
        }
        return if MCP_COMMANDS.contains(&operation) {
            bounded_bytes(&value["value"], 768 * 1024) && mcp_result(operation, &value["value"])
        } else {
            bounded_bytes(&value["value"], 512000) && source_result(operation, &value["value"])
        };
    }
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
        "agent:getAll" => result
            .as_array()
            .is_some_and(|items| items.len() <= 128 && items.iter().all(masked_agent)),
        "agent:create" | "agent:update" => masked_agent(result),
        "db:getTasks"
        | "db:getSubtasks"
        | "project:getAll"
        | "skills:getAll"
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
        "voice:status" => bounded_bytes(value, 262144) && voice_status(value, false),
        "voice:tts:status" => bounded_bytes(value, 262144) && voice_tts_snapshot(value),
        "voice:tts:modelProgress" => {
            object(value, &["model"], &[])
                && bounded_bytes(value, 262144)
                && voice_model(&value["model"], true)
        }
        "voice:runtimeProgress" => {
            object(value, &["stage", "output", "percent"], &[])
                && matches!(
                    value["stage"].as_str(),
                    Some("starting" | "installing" | "complete" | "error")
                )
                && value["output"]
                    == if value["stage"] == "error" {
                        VOICE_ERROR
                    } else {
                        VOICE_UNAVAILABLE
                    }
                && voice_number(&value["percent"], 0.0, 100.0)
        }
        "mobile:pairing-initiated" => bounded_bytes(value, 64 * 1024) && mobile_pin(value),
        "mobile:device-connected" => {
            bounded_bytes(value, 64 * 1024)
                && object(value, &["sessionId", "deviceName"], &[])
                && mcp_id(&value["sessionId"])
                && mcp_text(&value["deviceName"], 256)
        }
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

    fn git_test_repo() -> Value {
        json!({"name":"repo","fullName":"fixture/repo","defaultBranch":"release/main","cloneUrl":"https://git.example/fixture/repo.git","description":"Public\nDescription","isPrivate":true})
    }
    fn git_test_pr() -> Value {
        json!({"url":"https://github.com/fixture/repo/pull/42","repository":"fixture/repo","number":42,"title":"Public change","body":"Human\nbody","state":"open","isDraft":false,"reviewDecision":"review_required","author":{"login":"fixture","avatarUrl":"https://git.example/avatar"},"baseRefName":"main","headRefName":"feature/change","additions":1,"deletions":0,"changedFiles":1,"commentsCount":0,"reviewsCount":0,"createdAt":"2026-10-14","updatedAt":"2026-10-14","checks":[{"name":"CI","state":"pending","url":"https://git.example/checks/42"}]})
    }
    #[test]
    fn git_provider_finite_requests_and_results_match_each_operation() {
        for op in GIT_PROVIDER_COMMANDS {
            let request = match *op {
                "git:recordRepoProviders" => {
                    json!({"repoFullNames":["fixture/repo"],"provider":"forgejo"})
                }
                "forgejo:setLogin" => json!({"loginName":null}),
                "github:fetchPullRequestDetails" => {
                    json!({"url":"https://github.com/fixture/repo/pull/42"})
                }
                _ if op.ends_with(":fetchOrgRepos") => {
                    json!({"org":if op.starts_with("gitlab:") {"fixture/subgroup"} else {"fixture"}})
                }
                _ => json!({}),
            };
            assert!(COMMANDS.contains(op));
            assert!(valid_request(op, &request), "{op}");
            let result = match *op {
                "git:recordRepoProviders" => json!({"defined":false}),
                "forgejo:checkCli" | "forgejo:setLogin" => {
                    json!({"defined":true,"value":{"installed":true,"authenticated":true,"username":"fixture","login":"Work login","serverUrl":"https://git.example/","logins":[{"name":"Work login","url":"https://git.example/","sshHost":"[::1]:2222","user":"Fixture User","isDefault":true}],"code":"ready"}})
                }
                "github:checkCli" | "gitlab:checkCli" => {
                    json!({"defined":true,"value":{"installed":true,"authenticated":true,"username":"fixture"}})
                }
                "github:fetchPullRequestDetails" => json!({"defined":true,"value":git_test_pr()}),
                _ if op.ends_with(":fetchOrgs") => {
                    json!({"defined":true,"value":["fixture","fixture/subgroup"]})
                }
                _ => json!({"defined":true,"value":[git_test_repo()]}),
            };
            assert!(valid_result(op, &result), "{op}");
            for key in [
                "caller",
                "engineEpoch",
                "permission",
                "program",
                "workspaceDir",
                "token",
            ] {
                let mut injected = request.clone();
                injected[key] = json!("untrusted authority");
                assert!(!valid_request(op, &injected), "{op}: {key}");
            }
            assert!(
                !valid_result(op, &json!({"defined":true,"value":null})),
                "{op}"
            );
        }
        assert!(!valid_request("github:spawn", &json!({})));
        assert!(!valid_result(
            "git:recordRepoProviders",
            &json!({"defined":false,"value":null})
        ));
    }
    #[test]
    fn git_provider_request_authority_and_utf8_bounds_are_finite() {
        for org in [
            "../private",
            "--help",
            "constructor",
            "ghp_private",
            "__21x_api_key_set__",
            "fixture\u{0000}",
        ] {
            assert!(!valid_request("github:fetchOrgRepos", &json!({"org":org})));
        }
        assert!(valid_request(
            "gitlab:fetchOrgRepos",
            &json!({"org":"fixture/group"})
        ));
        assert!(!valid_request(
            "github:fetchOrgRepos",
            &json!({"org":"fixture/group"})
        ));
        assert!(!valid_request(
            "forgejo:fetchOrgRepos",
            &json!({"org":"fixture/group"})
        ));
        assert!(valid_request(
            "forgejo:setLogin",
            &json!({"loginName":"Work user@example"})
        ));
        assert!(valid_request(
            "forgejo:setLogin",
            &json!({"loginName":null})
        ));
        for name in [
            " Work",
            "Work ",
            "glpat-private",
            "__21x_api_key_set__",
            "Work\nlogin",
        ] {
            assert!(!valid_request(
                "forgejo:setLogin",
                &json!({"loginName":name})
            ));
        }
        for url in [
            "https://user:secret@github.com/fixture/repo/pull/42",
            "https://github.com/fixture/repo/pull/42?token=private",
            "http://github.com/fixture/repo/pull/42",
            "https://github.com:444/fixture/repo/pull/42",
            "file:///private",
            "https://git.example/fixture/repo/pulls/0",
        ] {
            assert!(
                !valid_request("github:fetchPullRequestDetails", &json!({"url":url})),
                "{url}"
            );
        }
        for url in [
            "https://github.com/fixture/repo/pull/42",
            "https://github.com:443/fixture/repo/pull/42",
            "https://github.com/fixture/repo/pull/42?#",
            "http://git.example:8080/fixture/repo/pulls/42",
        ] {
            assert!(
                valid_request("github:fetchPullRequestDetails", &json!({"url":url})),
                "{url}"
            );
        }
        assert!(!valid_request(
            "git:recordRepoProviders",
            &json!({"repoFullNames":["fixture/repo","fixture/repo"],"provider":"github"})
        ));
        assert!(!valid_request(
            "git:recordRepoProviders",
            &json!({"repoFullNames":[],"provider":"program"})
        ));
        assert!(valid_request(
            "git:recordRepoProviders",
            &json!({"repoFullNames":[],"provider":"gitlab"})
        ));
        assert!(!valid_request(
            "git:recordRepoProviders",
            &json!({"repoFullNames":(0..129).map(|i|format!("fixture/repo{i}")).collect::<Vec<_>>(),"provider":"github"})
        ));
        assert!(!git_text(&json!("é".repeat(2049)), 4096, true));
    }
    #[test]
    fn git_provider_wire_projection_cannot_publish_credentials_or_private_fields() {
        let wrap = |v: Value| json!({"defined":true,"value":v});
        let mut repo = git_test_repo();
        for url in [
            "https://user:secret@git.example/repo.git",
            "https://git.example/repo.git?token=private",
            "https://git.example/repo.git#private",
        ] {
            repo["cloneUrl"] = json!(url);
            assert!(!valid_result("github:fetchUserRepos", &wrap(json!([repo]))));
        }
        repo = git_test_repo();
        repo["token"] = json!("private");
        assert!(!valid_result("gitlab:fetchUserRepos", &wrap(json!([repo]))));
        repo = git_test_repo();
        repo["description"] = json!("x".repeat(4097));
        assert!(!valid_result(
            "forgejo:fetchUserRepos",
            &wrap(json!([repo]))
        ));
        assert!(!valid_result(
            "github:fetchUserRepos",
            &wrap(json!([git_test_repo(), git_test_repo()]))
        ));
        assert!(!valid_result(
            "github:checkCli",
            &wrap(json!({"installed":false,"authenticated":true}))
        ));
        assert!(!valid_result(
            "github:checkCli",
            &wrap(json!({"installed":true,"authenticated":true,"username":"ghp_private"}))
        ));
        assert!(!valid_result(
            "github:fetchOrgs",
            &wrap(json!((0..513)
                .map(|i| format!("org{i}"))
                .collect::<Vec<_>>()))
        ));
        let large_repos: Vec<_> = (0..240)
            .map(|i| {
                let mut row = git_test_repo();
                row["name"] = json!(format!("repo{i}"));
                row["fullName"] = json!(format!("fixture/repo{i}"));
                row["description"] = json!("x".repeat(4096));
                row
            })
            .collect();
        assert!(!valid_result(
            "github:fetchUserRepos",
            &wrap(json!(large_repos))
        ));
        assert!(valid_result(
            "forgejo:checkCli",
            &wrap(
                json!({"installed":false,"authenticated":false,"logins":[],"code":"not-installed","message":"The tea CLI is unavailable."})
            )
        ));
        assert!(!valid_result(
            "forgejo:checkCli",
            &wrap(
                json!({"installed":true,"authenticated":false,"logins":[],"code":"error","message":"private subprocess stderr"})
            )
        ));
        let mut pr = git_test_pr();
        pr["author"]["token"] = json!("private");
        assert!(!valid_result("github:fetchPullRequestDetails", &wrap(pr)));
        pr = git_test_pr();
        pr["body"] = json!("x".repeat(131073));
        assert!(!valid_result("github:fetchPullRequestDetails", &wrap(pr)));
        pr = git_test_pr();
        pr["checks"] = json!(vec![json!({"name":"CI","state":"passed"}); 129]);
        assert!(!valid_result("github:fetchPullRequestDetails", &wrap(pr)));
    }

    #[test]
    fn mobile_ingress_is_exact_and_public_results_events_never_expose_session_tokens() {
        assert_eq!(EVENTS.len(), 23);
        let requests = [
            ("mobile:getInfo", json!({})),
            (
                "mobile:setAccess",
                json!({"options":{"enabled":false,"lanAccess":false,"sessionIdleDays":7}}),
            ),
            ("mobile:startTunnel", json!({})),
            ("mobile:stopTunnel", json!({})),
            (
                "mobile:setCustomUrl",
                json!({"url":"https://mobile.example.test/access"}),
            ),
            ("mobile:clearCustomUrl", json!({})),
            ("mobile:getPendingPin", json!({})),
            ("mobile:getSessions", json!({})),
            (
                "mobile:revokeSession",
                json!({"sessionId":"mobile.fixture:one"}),
            ),
            ("mobile:revokeAllSessions", json!({})),
        ];
        for (operation, mut request) in requests {
            assert!(valid_request(operation, &request), "{operation}");
            request["caller"] = json!({"id":"foreign","capabilities":["*"]});
            assert!(!valid_request(operation, &request));
        }
        assert!(valid_request(
            "mobile:setAccess",
            &json!({"options":{"sessionIdleDays":0.125}})
        ));
        for options in [
            json!({}),
            json!({"enabled":"true"}),
            json!({"sessionIdleDays":0}),
            json!({"sessionIdleDays":366}),
            json!({"enabled":true,"profileRoot":"/private"}),
        ] {
            assert!(!valid_request(
                "mobile:setAccess",
                &json!({"options":options})
            ));
        }
        for address in [
            "file:///private",
            "https://user:pass@example.test",
            "https://example.test?sessionToken=private",
            "https://example.test#private",
            " https://example.test",
            "https://example.test/bad\0path",
        ] {
            assert!(!valid_request(
                "mobile:setCustomUrl",
                &json!({"url":address})
            ));
        }
        let info = json!({"enabled":false,"lanAccess":false,"sessionIdleDays":7,"url":"http://127.0.0.1:3210/pair?code=init.fixture:one","port":3210,"lanUrl":null,"tunnelUrl":null,"tunnelActive":false,"remoteMode":"quick","customUrl":null});
        assert!(valid_result(
            "mobile:getInfo",
            &json!({"defined":true,"value":info.clone()})
        ));
        assert!(valid_result(
            "mobile:startTunnel",
            &json!({"defined":true,"value":{"tunnelUrl":"https://mobile.example.test/pair?code=init.fixture:one"}})
        ));
        assert!(valid_result(
            "mobile:setCustomUrl",
            &json!({"defined":true,"value":{"url":"https://mobile.example.test/access/pair?code=init.fixture:one"}})
        ));
        let mut leaked = info.clone();
        leaked["sessionToken"] = json!("private");
        assert!(!valid_result(
            "mobile:getInfo",
            &json!({"defined":true,"value":leaked})
        ));
        for address in [
            "https://example.test/pair?code=one&code=two",
            "https://example.test/pair?code=one&sessionToken=private",
            "https://example.test/not-pair?code=one",
            "https://example.test/pair?code=bad%2Fcode",
            "https://example.test/pair?code=one#private",
        ] {
            let mut malformed = info.clone();
            malformed["url"] = json!(address);
            assert!(!valid_result(
                "mobile:getInfo",
                &json!({"defined":true,"value":malformed})
            ));
        }
        let pin = json!({"pin":"123456","pairCodeId":"pair.fixture:one","expiresAt":1000});
        assert!(valid_result(
            "mobile:getPendingPin",
            &json!({"defined":true,"value":pin.clone()})
        ));
        assert!(valid_result(
            "mobile:getPendingPin",
            &json!({"defined":true,"value":null})
        ));
        assert!(valid_event("mobile:pairing-initiated", &pin));
        assert!(valid_event(
            "mobile:device-connected",
            &json!({"sessionId":"mobile.fixture:one","deviceName":"Fixture Phone"})
        ));
        assert!(!valid_event(
            "mobile:pairing-initiated",
            &json!({"pin":"12345","pairCodeId":"fixture","expiresAt":1000})
        ));
        assert!(!valid_event(
            "mobile:device-connected",
            &json!({"sessionId":"fixture","deviceName":"Fixture","sessionToken":"private"})
        ));
        let row = json!({"id":"mobile.fixture:one","device_name":"Fixture Phone","paired_at":1000,"last_seen":1001});
        assert!(valid_result(
            "mobile:getSessions",
            &json!({"defined":true,"value":[row.clone()]})
        ));
        assert!(!valid_result(
            "mobile:getSessions",
            &json!({"defined":true,"value":[row.clone(),row.clone()]})
        ));
        let mut raw = row;
        raw["token_hash"] = json!("private");
        assert!(!valid_result(
            "mobile:getSessions",
            &json!({"defined":true,"value":[raw]})
        ));
        assert!(valid_result(
            "mobile:revokeSession",
            &json!({"defined":true,"value":{"success":false}})
        ));
        assert!(!valid_result(
            "mobile:startTunnel",
            &json!({"defined":false})
        ));
    }

    fn context_fixture() -> Value {
        json!({"scope":{"kind":"captain","ownerId":"project_fixture"},"generation":{"id":"generation:fixture","key":"adapter:native_fixture","engine":"adapter","state":"running","createdAt":100,"backendId":"native_fixture"},"usage":{"tokens":1200,"source":"reported","contextWindow":16000,"model":"fixture/model","observedAt":110},"counters":{"compactions":1,"wakeups":2,"turns":3,"ageMs":10},"policy":{"mode":"observe","contextRatio":0.6,"compactions":3,"wakeups":20,"turns":10,"maxAgeDays":7},"reasons":["context"],"warnings":["Human\nwarning"],"summaries":[{"id":"summary:fixture","content":"Human\nsummary","kind":"rollover","createdAt":105,"source":"model"}],"handoff":{"id":"handoff:fixture","state":"creation_unconfirmed"}})
    }
    fn installed_fixture() -> Value {
        json!({"id":"plugin.fixture:one","name":"fixture-plugin","marketplace_id":"marketplace.fixture:one","manifest":{"name":"fixture-plugin","version":"1.0","description":"Fixture","author":{"name":"Fixture Author"},"homepage":"https://example.test/plugin","repository":"","license":"MIT","keywords":["fixture"]},"source":{"source":"github","repo":"fixture/marketplace#main","path":"plugins/fixture-plugin"},"scope":"user","enabled":true,"version":"1.0","installed_at":"2026-10-14","updated_at":"2026-10-14"})
    }
    #[test]
    fn session_context_policy_and_projection_are_finite_and_truthful() {
        let snapshot = context_fixture();
        let policy = snapshot["policy"].clone();
        assert!(valid_request(
            "sessionContext:getSnapshot",
            &json!({"scope":{"kind":"commander","ownerId":"session_fixture"}})
        ));
        assert!(valid_request(
            "sessionContext:setPolicy",
            &json!({"policy":policy.clone()})
        ));
        assert!(valid_result(
            "sessionContext:setPolicy",
            &json!({"defined":true,"value":policy.clone()})
        ));
        for mode in ["off", "observe", "on"] {
            let mut candidate = policy.clone();
            candidate["mode"] = json!(mode);
            assert!(valid_request(
                "sessionContext:setPolicy",
                &json!({"policy":candidate})
            ));
        }
        assert!(valid_request(
            "sessionContext:setPolicy",
            &json!({"policy":{"mode":"on","contextRatio":1,"compactions":1000000,"wakeups":1000000,"turns":1000000,"maxAgeDays":3650}})
        ));
        for (key, value) in [
            ("mode", json!("automatic")),
            ("contextRatio", json!(0)),
            ("contextRatio", json!(1.01)),
            ("compactions", json!(0)),
            ("wakeups", json!(1000001)),
            ("turns", json!(1.5)),
            ("maxAgeDays", json!(3651)),
        ] {
            let mut candidate = policy.clone();
            candidate[key] = value;
            assert!(!valid_request(
                "sessionContext:setPolicy",
                &json!({"policy":candidate})
            ));
        }
        assert!(!valid_request(
            "sessionContext:getSnapshot",
            &json!({"scope":{"kind":"task","ownerId":"task_fixture"}})
        ));
        assert!(!valid_request(
            "sessionContext:getSnapshot",
            &json!({"scope":{"kind":"captain","ownerId":"project_fixture","profileRoot":"/foreign"}})
        ));
        assert!(valid_result(
            "sessionContext:getSnapshot",
            &json!({"defined":true,"value":snapshot.clone()})
        ));
        for state in ["open", "running", "closed", "interrupted"] {
            let mut candidate = snapshot.clone();
            candidate["generation"]["state"] = json!(state);
            assert!(valid_result(
                "sessionContext:getSnapshot",
                &json!({"defined":true,"value":candidate})
            ));
        }
        for state in [
            "pending",
            "summary",
            "memory",
            "creating",
            "created",
            "creation_unconfirmed",
            "completed",
        ] {
            let mut candidate = snapshot.clone();
            candidate["handoff"]["state"] = json!(state);
            assert!(valid_result(
                "sessionContext:getSnapshot",
                &json!({"defined":true,"value":candidate})
            ));
        }
        let mut unknown = snapshot.clone();
        unknown["generation"] = Value::Null;
        unknown["usage"] = json!({"tokens":null,"source":"unknown","contextWindow":null,"model":null,"observedAt":null});
        unknown["handoff"] = Value::Null;
        assert!(valid_result(
            "sessionContext:getSnapshot",
            &json!({"defined":true,"value":unknown.clone()})
        ));
        unknown["usage"]["tokens"] = json!(10);
        assert!(!valid_result(
            "sessionContext:getSnapshot",
            &json!({"defined":true,"value":unknown})
        ));
        for (key, value) in [
            ("reasons", json!(["context", "context"])),
            ("reasons", json!(["unverified"])),
            (
                "handoff",
                json!({"id":"fixture","state":"created","targetPath":"/private"}),
            ),
            (
                "usage",
                json!({"tokens":null,"source":"reported","contextWindow":16000,"model":"fixture","observedAt":100}),
            ),
        ] {
            let mut candidate = snapshot.clone();
            candidate[key] = value;
            assert!(!valid_result(
                "sessionContext:getSnapshot",
                &json!({"defined":true,"value":candidate})
            ));
        }
        let mut large = snapshot;
        large["summaries"][0]["content"] = json!("x".repeat(65_536));
        assert!(valid_result(
            "sessionContext:getSnapshot",
            &json!({"defined":true,"value":large.clone()})
        ));
        large["summaries"][0]["content"] = json!("x".repeat(65_537));
        assert!(!valid_result(
            "sessionContext:getSnapshot",
            &json!({"defined":true,"value":large})
        ));
        assert!(!valid_result(
            "sessionContext:getSnapshot",
            &json!({"defined":false})
        ));
    }
    #[test]
    fn claude_plugin_contracts_preserve_finite_catalog_sources_and_strip_private_resources() {
        let requests = [
            ("claudePlugin:getMarketplaceSources", json!({})),
            (
                "claudePlugin:addMarketplaceSource",
                json!({"data":{"name":"Fixture","source_url":"fixture/marketplace#main","auto_update":false}}),
            ),
            (
                "claudePlugin:removeMarketplaceSource",
                json!({"id":"marketplace.fixture:one"}),
            ),
            (
                "claudePlugin:fetchCatalog",
                json!({"sourceId":"marketplace.fixture:one"}),
            ),
            (
                "claudePlugin:discoverPlugins",
                json!({"searchQuery":"fixture"}),
            ),
            ("claudePlugin:getInstalledPlugins", json!({})),
            (
                "claudePlugin:installPlugin",
                json!({"pluginName":"fixture-plugin","marketplaceId":"marketplace.fixture:one","scope":"user"}),
            ),
            (
                "claudePlugin:uninstallPlugin",
                json!({"pluginId":"plugin.fixture:one"}),
            ),
            (
                "claudePlugin:enablePlugin",
                json!({"pluginId":"plugin.fixture:one"}),
            ),
            (
                "claudePlugin:disablePlugin",
                json!({"pluginId":"plugin.fixture:one"}),
            ),
            (
                "claudePlugin:getPluginResources",
                json!({"pluginId":"plugin.fixture:one"}),
            ),
        ];
        for (operation, mut request) in requests {
            assert!(valid_request(operation, &request), "{operation}");
            request["capability"] = json!({"namespace":"*"});
            assert!(!valid_request(operation, &request));
        }
        for (kind, url) in [
            ("url", "https://example.test/catalog"),
            ("local", "/synthetic-fixture/catalog"),
        ] {
            assert!(valid_request(
                "claudePlugin:addMarketplaceSource",
                &json!({"data":{"name":"Fixture","source_type":kind,"source_url":url}})
            ));
        }
        for name in [
            "../escape",
            "bad/name",
            "CON",
            "nul.json",
            "plugin.",
            "bad\0name",
        ] {
            assert!(!valid_request(
                "claudePlugin:installPlugin",
                &json!({"pluginName":name,"marketplaceId":"fixture"})
            ));
        }
        assert!(!valid_request(
            "claudePlugin:installPlugin",
            &json!({"pluginName":"fixture-plugin","marketplaceId":"fixture","scope":"project"})
        ));
        assert!(!valid_request(
            "claudePlugin:addMarketplaceSource",
            &json!({"data":{"name":"Fixture","source_type":"local","source_url":"__21x_local_source__"}})
        ));
        assert!(!valid_request(
            "claudePlugin:addMarketplaceSource",
            &json!({"data":{"name":"Fixture","source_type":"url","source_url":"https://user:pass@example.test/catalog"}})
        ));
        let marketplace = json!({"id":"marketplace.fixture:one","name":"Fixture","source_type":"local","source_url":"__21x_local_source__","metadata":{},"auto_update":false,"created_at":"2026-10-14","updated_at":"2026-10-14"});
        assert!(valid_result(
            "claudePlugin:addMarketplaceSource",
            &json!({"defined":true,"value":marketplace.clone()})
        ));
        let mut raw_market = marketplace;
        raw_market["source_url"] = json!("/private/profile/catalog");
        assert!(!valid_result(
            "claudePlugin:addMarketplaceSource",
            &json!({"defined":true,"value":raw_market})
        ));
        let installed = installed_fixture();
        assert!(valid_result(
            "claudePlugin:installPlugin",
            &json!({"defined":true,"value":installed.clone()})
        ));
        let mut secret_manifest = installed;
        secret_manifest["manifest"]["mcpServers"] =
            json!({"private":{"command":"/private/tool","env":{"TOKEN":"private"}}});
        assert!(!valid_result(
            "claudePlugin:installPlugin",
            &json!({"defined":true,"value":secret_manifest})
        ));
        assert!(valid_result(
            "claudePlugin:fetchCatalog",
            &json!({"defined":true,"value":{"name":"Fixture","owner":{"name":"Author"},"plugins":[{"name":"fixture-plugin","source":"./plugins/fixture-plugin","author":{"name":"Author"}}],"metadata":{"version":"1"}}})
        ));
        assert!(valid_result(
            "claudePlugin:fetchCatalog",
            &json!({"defined":true,"value":null})
        ));
        assert!(valid_result(
            "claudePlugin:enablePlugin",
            &json!({"defined":false})
        ));
        assert!(!valid_result(
            "claudePlugin:installPlugin",
            &json!({"defined":false})
        ));
        let mut resources = json!({"skills":[{"id":"skill:fixture","name":"Fixture","description":"Public description"}],"mcpServers":[{"id":"mcp:fixture","name":"Fixture","command":"","args":[]}],"agents":[{"id":"agent:fixture","name":"Fixture","description":""}],"commands":["./commands/fixture.md"]});
        assert!(valid_result(
            "claudePlugin:getPluginResources",
            &json!({"defined":true,"value":resources.clone()})
        ));
        resources["mcpServers"][0]["command"] = json!("/private/tool");
        assert!(!valid_result(
            "claudePlugin:getPluginResources",
            &json!({"defined":true,"value":resources.clone()})
        ));
        resources["mcpServers"][0]["command"] = json!("");
        resources["agents"][0]["description"] = json!("private system prompt");
        assert!(!valid_result(
            "claudePlugin:getPluginResources",
            &json!({"defined":true,"value":resources})
        ));
    }

    #[test]
    fn plugin_metadata_and_resolvers_have_exact_domain_shapes_and_scope() {
        assert!(valid_request("plugin:list", &json!({})));
        assert!(valid_request(
            "plugin:getDocumentation",
            &json!({"pluginId":"notion"})
        ));
        assert!(valid_request(
            "plugin:resolveOptions",
            &json!({"pluginId":"linear","resolverKey":"users","config":{},"sourceId":"source_fixture"})
        ));
        for (plugin, resolvers) in [
            ("linear", vec!["users"]),
            ("hubspot", vec!["owners", "pipelines"]),
            ("github-issues", vec!["owners", "repos"]),
            ("forgejo-issues", vec!["logins", "owners", "repos"]),
            (
                "notion",
                vec!["data_sources", "status_options", "data_source_properties"],
            ),
            (
                "youtrack",
                vec!["projects", "users", "states", "priorities", "types"],
            ),
            ("connector-bridge", vec!["pieces"]),
        ] {
            for resolver in resolvers {
                let mut request = json!({"pluginId":plugin,"resolverKey":resolver,"config":{}});
                assert!(valid_request("plugin:resolveOptions", &request));
                request["authority"] = json!({"namespace":"*"});
                assert!(!valid_request("plugin:resolveOptions", &request));
            }
        }
        assert!(valid_request(
            "plugin:resolveOptions",
            &json!({"pluginId":"youtrack","resolverKey":"users","config":{"api_token":"x".repeat(16_384)}})
        ));
        for request in [
            json!({"pluginId":"notion","resolverKey":"owners","config":{}}),
            json!({"pluginId":"unknown","resolverKey":"users","config":{}}),
            json!({"pluginId":"notion","resolverKey":"data_sources","config":{"api_token":"bad\0secret"}}),
            json!({"pluginId":"notion","resolverKey":"data_sources","config":{"api_token":"x".repeat(16_385)}}),
            json!({"pluginId":"notion","resolverKey":"data_sources","config":{"command":"arbitrary"}}),
            json!({"pluginId":"linear","resolverKey":"users","config":{},"mcpServerId":"native/foreign"}),
        ] {
            assert!(!valid_request("plugin:resolveOptions", &request));
        }
        assert!(!valid_request(
            "plugin:getDocumentation",
            &json!({"pluginId":"notion","path":"/private"})
        ));
        let metadata = json!({"id":"notion","displayName":"Notion","description":"Multiline\ndescription","icon":"notion"});
        assert!(valid_result(
            "plugin:list",
            &json!({"defined":true,"value":[metadata.clone()]})
        ));
        assert!(!valid_result(
            "plugin:list",
            &json!({"defined":true,"value":[metadata.clone(),metadata]})
        ));
        assert!(valid_result(
            "plugin:getDocumentation",
            &json!({"defined":true,"value":null})
        ));
        assert!(valid_result(
            "plugin:getDocumentation",
            &json!({"defined":true,"value":"x".repeat(128_000)})
        ));
        assert!(!valid_result(
            "plugin:getDocumentation",
            &json!({"defined":true,"value":"x".repeat(128_001)})
        ));
        assert!(!valid_result(
            "plugin:getDocumentation",
            &json!({"defined":false})
        ));
        assert!(valid_result(
            "plugin:resolveOptions",
            &json!({"defined":true,"value":[{"value":"x".repeat(65_536),"label":"Multiline\noption"}]})
        ));
        assert!(!valid_result(
            "plugin:resolveOptions",
            &json!({"defined":true,"value":[{"value":"external:value","label":"Fixture","secret":"private"}]})
        ));
        assert!(!valid_result(
            "plugin:resolveOptions",
            &json!({"defined":true,"value":[{"value":"bad\0value","label":"Fixture"}]})
        ));
        assert!(!valid_result(
            "plugin:resolveOptions",
            &json!({"defined":true,"value":[{"value":"external:value","label":"é".repeat(2049)}]})
        ));
    }

    #[test]
    fn connector_contracts_bind_only_mapped_instances_and_masked_outcomes() {
        let requests = [
            ("connectors:bridgePieces", json!({})),
            (
                "connectors:ensureInstance",
                json!({"pieceName":"@activepieces/piece-trello","instanceId":"connector.fixture:one"}),
            ),
            (
                "connectors:credentialStatus",
                json!({"instanceId":"connector.fixture:one"}),
            ),
            (
                "connectors:setCredentials",
                json!({"instanceId":"connector.fixture:one","input":{"username":"fixture","password":"synthetic"},"storage":"session"}),
            ),
            (
                "connectors:clearCredentials",
                json!({"instanceId":"connector.fixture:one"}),
            ),
            (
                "connectors:oauthConnect",
                json!({"instanceId":"connector.fixture:one","input":{"clientId":"fixture","clientSecret":"synthetic"},"storage":"persistent"}),
            ),
            (
                "connectors:syncStatus",
                json!({"instanceId":"connector.fixture:one"}),
            ),
        ];
        for (operation, mut request) in requests {
            assert!(valid_request(operation, &request), "{operation}");
            request["profileRoot"] = json!("/foreign/profile");
            assert!(!valid_request(operation, &request), "{operation}");
        }
        for secret in [
            "__21x_api_key_set__",
            "__21x_mcp_secret_set__",
            " __21x_api_key_set__ ",
            "bad\0secret",
            "bad\nsecret",
            "",
        ] {
            assert!(!valid_request(
                "connectors:setCredentials",
                &json!({"instanceId":"connector.fixture:one","input":{"secret":secret}})
            ));
        }
        assert!(!valid_request(
            "connectors:ensureInstance",
            &json!({"pieceName":"@activepieces/piece-foreign"})
        ));
        assert!(!valid_request(
            "connectors:oauthConnect",
            &json!({"instanceId":"connector.fixture:one","input":{"accessToken":"synthetic"}})
        ));
        assert!(valid_request(
            "connectors:setCredentials",
            &json!({"instanceId":"connector.fixture:one","input":{"secret":"x".repeat(4096)}})
        ));
        assert!(!valid_request(
            "connectors:setCredentials",
            &json!({"instanceId":"connector.fixture:one","input":{"secret":"x".repeat(4097)}})
        ));
        assert!(valid_result(
            "connectors:credentialStatus",
            &json!({"defined":true,"value":{"storage":null,"persistentAvailable":false,"oauth":{"state":"revoked","expiresAt":null}}})
        ));
        assert!(!valid_result(
            "connectors:credentialStatus",
            &json!({"defined":true,"value":{"storage":"session","persistentAvailable":true,"accessToken":"private"}})
        ));
        assert!(valid_result(
            "connectors:setCredentials",
            &json!({"defined":true,"value":{"ok":true,"storage":"session"}})
        ));
        assert!(valid_result(
            "connectors:oauthConnect",
            &json!({"defined":true,"value":{"ok":false,"error":"Connector credentials could not be saved.","sessionOnlyAvailable":true,"remediation":"Secure persistent storage is unavailable. Use session storage or restore secure storage."}})
        ));
        assert!(!valid_result(
            "connectors:setCredentials",
            &json!({"defined":true,"value":{"ok":false,"error":"private provider details"}})
        ));
        assert!(valid_result(
            "connectors:clearCredentials",
            &json!({"defined":false})
        ));
        assert!(!valid_result(
            "connectors:clearCredentials",
            &json!({"defined":true,"value":null})
        ));
        assert!(valid_result(
            "connectors:syncStatus",
            &json!({"defined":true,"value":{"lastError":"Connector sync failed. Open the task source for details.","lastSyncedAt":null,"attemptCount":2,"nextRetryAt":1000,"deadLetterCount":1}})
        ));
        let piece = json!({"pieceName":"@activepieces/piece-todoist","label":"Todoist","authType":"oauth2","authLabels":{"clientId":"Client ID","clientSecret":"Client secret"},"configProps":[{"key":"filter_query","label":"Filter","required":false}],"oauth":{"mode":"user-supplied","pkce":true,"clientSecretRequired":false,"scopes":["data:read"],"redirectUriHint":"twentyonex://oauth/callback"}});
        assert!(valid_result(
            "connectors:bridgePieces",
            &json!({"defined":true,"value":[piece.clone()]})
        ));
        assert!(!valid_result(
            "connectors:bridgePieces",
            &json!({"defined":true,"value":[piece.clone(),piece]})
        ));
    }

    #[test]
    fn mcp_contracts_scope_crud_probes_and_live_oauth_requests() {
        let requests = [
            ("mcp:getAll", json!({})),
            (
                "mcp:create",
                json!({"data":{"name":"Fixture","command":"fixture-mcp","args":["--probe"],"headers":{"Authorization":"synthetic"},"environment":{"FIXTURE_TOKEN":"synthetic"}}}),
            ),
            (
                "mcp:update",
                json!({"id":"mcp.fixture:one","data":{"url":"https://mcp.example.test/api","type":"remote"}}),
            ),
            ("mcp:delete", json!({"id":"mcp.fixture:one"})),
            (
                "mcp:testConnection",
                json!({"data":{"id":"mcp.fixture:one","name":"Fixture"}}),
            ),
            ("mcp:startOAuthFlow", json!({"id":"mcp.fixture:one"})),
            ("mcp:getOAuthStatus", json!({"id":"mcp.fixture:one"})),
            ("mcp:revokeOAuthToken", json!({"id":"mcp.fixture:one"})),
            (
                "mcp:probeForAuth",
                json!({"url":"https://mcp.example.test/api"}),
            ),
            (
                "mcp:submitManualClientId",
                json!({"id":"mcp.fixture:one","clientId":"fixture-client"}),
            ),
        ];
        for (operation, mut request) in requests {
            assert!(valid_request(operation, &request), "{operation}");
            request["authority"] = json!({"namespace":"*"});
            assert!(!valid_request(operation, &request), "{operation}");
        }
        for data in [
            json!({"name":"Fixture","source":"plugin"}),
            json!({"name":"Fixture","oauth_metadata":{"client_secret":"synthetic"}}),
            json!({"name":"Fixture","headers":{"constructor":"synthetic"}}),
            json!({"name":"Fixture","environment":{"bad-key":"synthetic"}}),
            json!({"name":"Fixture","url":"https://user:pass@example.test/api"}),
            json!({"name":"Fixture","command":"bad\ncommand"}),
        ] {
            assert!(!valid_request("mcp:create", &json!({"data":data})));
        }
        assert!(!valid_request(
            "mcp:startOAuthFlow",
            &json!({"id":"mcp.fixture:one","url":"https://foreign.example.test"})
        ));
        let mut row = json!({"id":"mcp.fixture:one","name":"Fixture","type":"local","command":"fixture-mcp","args":[],"url":"","headers":{"Authorization":"__21x_mcp_secret_set__"},"environment":{"FIXTURE_TOKEN":"__21x_mcp_secret_set__"},"tools":[{"name":"fixture_tool","description":"Description"}],"oauth_metadata":{"client_secret":"__21x_mcp_secret_set__"},"source":"user","created_at":"2026-10-14","updated_at":"2026-10-14"});
        assert!(valid_result(
            "mcp:getAll",
            &json!({"defined":true,"value":[row.clone()]})
        ));
        for field in ["headers", "environment", "oauth_metadata"] {
            let key = match field {
                "headers" => "Authorization",
                "environment" => "FIXTURE_TOKEN",
                _ => "client_secret",
            };
            let mut leaked = row.clone();
            leaked[field][key] = json!("synthetic-private-value");
            assert!(!valid_result(
                "mcp:update",
                &json!({"defined":true,"value":leaked})
            ));
        }
        row["extra"] = json!("unexpected");
        assert!(!valid_result(
            "mcp:create",
            &json!({"defined":true,"value":row})
        ));
        assert!(!valid_result("mcp:create", &json!({"defined":false})));
        assert!(valid_result("mcp:update", &json!({"defined":false})));
        assert!(valid_result(
            "mcp:revokeOAuthToken",
            &json!({"defined":false})
        ));
        assert!(!valid_result("mcp:getAll", &json!({"defined":false})));
        assert!(valid_result(
            "mcp:testConnection",
            &json!({"defined":true,"value":{"status":"failed","error":"MCP probe failed"}})
        ));
        assert!(valid_result(
            "mcp:testConnection",
            &json!({"defined":true,"value":{"status":"connected","tools":[{"name":"lookup","description":"Read items\nReturn a bounded page."}]}})
        ));
        assert!(!valid_result(
            "mcp:testConnection",
            &json!({"defined":true,"value":{"status":"failed","error":"private command details"}})
        ));
        assert!(valid_result(
            "mcp:startOAuthFlow",
            &json!({"defined":true,"value":{"needsManualClientId":true}})
        ));
        assert!(!valid_result(
            "mcp:startOAuthFlow",
            &json!({"defined":true,"value":{"pid":1234}})
        ));
    }

    #[test]
    fn task_sources_accept_only_plugin_inputs_and_masked_metadata_outputs() {
        let requests = [
            ("taskSource:getAll", json!({"projectId":""})),
            (
                "taskSource:create",
                json!({"data":{"name":"Fixture","mcp_server_id":null,"plugin_id":"notion","config":{"api_token":"synthetic\ncredential","filters":[{"property":"Status","type":"select","values":["Open"]}],"next_statuses":["Done"]}}}),
            ),
            (
                "taskSource:update",
                json!({"id":"source_fixture","data":{"config":{"api_token":"__21x_api_key_set__","server_url":"https://youtrack.example.test"}}}),
            ),
            ("taskSource:delete", json!({"id":"source_fixture"})),
            ("taskSource:sync", json!({"sourceId":"source_fixture"})),
            (
                "taskSource:exportUpdate",
                json!({"taskId":"task_fixture","fields":{"description":"Multiline\ncontext","priority":"urgent","complete_at_source":null}}),
            ),
            ("taskSource:getUsers", json!({"sourceId":"source_fixture"})),
            (
                "taskSource:reassign",
                json!({"taskId":"task_fixture","userIds":["external:user"],"assigneeDisplay":"Fixture"}),
            ),
        ];
        for (operation, mut request) in requests {
            assert!(valid_request(operation, &request), "{operation}");
            request["workspaceDir"] = json!("/foreign/path");
            assert!(!valid_request(operation, &request), "{operation}");
        }
        for data in [
            json!({"name":"Fixture","mcp_server_id":null,"plugin_id":"unknown-plugin"}),
            json!({"name":"Fixture","mcp_server_id":null,"plugin_id":"notion","config":{"command":"arbitrary"}}),
            json!({"name":"Fixture","mcp_server_id":null,"plugin_id":"notion","list_tool_args":{"path":"/foreign/path"}}),
            json!({"name":"Fixture","mcp_server_id":null,"plugin_id":"notion","config":{"api_token":"bad\0value"}}),
            json!({"name":"Fixture","mcp_server_id":null,"plugin_id":"notion","config":{"api_token":"x".repeat(16_385)}}),
        ] {
            assert!(!valid_request("taskSource:create", &json!({"data":data})));
        }
        assert!(valid_request(
            "taskSource:update",
            &json!({"id":"source_fixture","data":{"config":{"api_token":"x".repeat(16_384)}}})
        ));
        assert!(valid_request(
            "taskSource:create",
            &json!({"data":{"name":"Fixture","mcp_server_id":null,"plugin_id":"connector-bridge","config":{"piece_name":"@activepieces/piece-trello","props":{"board_id":"external-board"},"poll_interval_minutes":0.5}}})
        ));
        for interval in [
            json!(15),
            json!("15"),
            json!(0),
            json!("0"),
            json!(""),
            json!(0.5),
            json!("0.5"),
        ] {
            assert!(valid_request(
                "taskSource:update",
                &json!({"id":"source_fixture","data":{"plugin_id":"connector-bridge","config":{"poll_interval_minutes":interval}}})
            ));
        }
        for interval in [
            json!("arbitrary"),
            json!("-1"),
            json!("Infinity"),
            json!("+1"),
            json!("0x10"),
            json!("1e1"),
            json!(" 1"),
        ] {
            assert!(!valid_request(
                "taskSource:update",
                &json!({"id":"source_fixture","data":{"plugin_id":"connector-bridge","config":{"poll_interval_minutes":interval}}})
            ));
        }
        assert!(!valid_request(
            "taskSource:update",
            &json!({"id":"source_fixture","data":{"mcp_server_id":null}})
        ));
        assert!(!valid_request(
            "taskSource:reassign",
            &json!({"taskId":"task_fixture","userIds":["same","same"],"assigneeDisplay":""})
        ));
        let mut row = json!({"id":"source_fixture","mcp_server_id":null,"name":"Fixture","plugin_id":"notion","config":{"api_token":"__21x_api_key_set__"},"list_tool":"legacy_list","list_tool_args":{},"update_tool":"legacy_update","update_tool_args":{},"last_synced_at":null,"enabled":false,"project_id":"project_fixture","created_at":"2026-10-14","updated_at":"2026-10-14"});
        assert!(valid_result(
            "taskSource:getAll",
            &json!({"defined":true,"value":[row.clone()]})
        ));
        row["config"]["api_token"] = json!("synthetic-private-value");
        assert!(!valid_result(
            "taskSource:create",
            &json!({"defined":true,"value":row.clone()})
        ));
        row["plugin_id"] = json!("uninstalled.plugin");
        row["config"] = json!({});
        assert!(valid_result(
            "taskSource:update",
            &json!({"defined":true,"value":row.clone()})
        ));
        row["config"] = json!({"internal":"private"});
        assert!(!valid_result(
            "taskSource:update",
            &json!({"defined":true,"value":row})
        ));
        assert!(valid_result(
            "taskSource:exportUpdate",
            &json!({"defined":false})
        ));
        assert!(!valid_result(
            "taskSource:create",
            &json!({"defined":false})
        ));
        assert!(!valid_result("taskSource:sync", &json!({"defined":false})));
        assert!(valid_result(
            "taskSource:sync",
            &json!({"defined":true,"value":{"source_id":"source_fixture","imported":1,"updated":2,"errors":["Explicit source failure"]}})
        ));
        assert!(valid_result(
            "taskSource:getUsers",
            &json!({"defined":true,"value":[{"id":"external:user","name":"Fixture","email":"fixture@example.test"}]})
        ));
        assert!(!valid_result(
            "taskSource:reassign",
            &json!({"defined":true,"value":{"success":true,"token":"private"}})
        ));
    }
    #[test]
    fn production_names_and_scopes_are_finite() {
        assert_eq!(COMMANDS.len(), 180);
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
    fn workspace_controls_are_exact_bounded_and_have_no_payload_path_grants() {
        for (op, payload) in [
            ("tasks:getWorkspaceDir", json!({"taskId":"task_fixture"})),
            (
                "shell:readTextFile",
                json!({"filePath":"/workspace/task_fixture/報告.md"}),
            ),
            (
                "shell:openPath",
                json!({"filePath":"C:\\workspace\\task_fixture"}),
            ),
            (
                "shell:showItemInFolder",
                json!({"filePath":"\\\\server\\share\\task_fixture\\report.md"}),
            ),
        ] {
            assert!(valid_request(op, &payload));
            let mut extra = payload.clone();
            extra["authority"] = json!({"root":"/private"});
            assert!(!valid_request(op, &extra));
        }
        for bad in [
            json!({"filePath":"relative"}),
            json!({"filePath":"/private\u{0}file"}),
            json!({"filePath":"/".to_owned()+ &"é".repeat(4096)}),
        ] {
            assert!(!valid_request("shell:readTextFile", &bad));
        }
        assert!(valid_result(
            "shell:readTextFile",
            &json!({"defined":true,"value":null})
        ));
        assert!(valid_result(
            "shell:readTextFile",
            &json!({"defined":true,"value":{"content":"","size":200000}})
        ));
        assert!(valid_result(
            "shell:readTextFile",
            &json!({"defined":true,"value":{"content":"\u{0}".repeat(131072),"size":131072}})
        ));
        assert!(!valid_result(
            "shell:readTextFile",
            &json!({"defined":true,"value":{"content":"é".repeat(131072),"size":131072}})
        ));
        assert!(!valid_result(
            "shell:readTextFile",
            &json!({"defined":true,"value":{"content":"x","size":200000}})
        ));
        assert!(!valid_result(
            "shell:readTextFile",
            &json!({"defined":true,"value":{"content":"x","size":9007199254740992u64}})
        ));
        assert!(valid_result("shell:openPath", &json!({"defined":false})));
        assert!(!valid_result(
            "shell:openPath",
            &json!({"defined":true,"value":null})
        ));
        assert!(valid_result(
            "tasks:getWorkspaceDir",
            &json!({"defined":true,"value":"/workspace/task_fixture"})
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
    fn voice_management_refuses_hosted_paths_audio_and_unknown_model_authority() {
        assert!(valid_request(
            "voice:setEndpointSilence",
            &json!({"seconds":1.5})
        ));
        assert!(valid_request(
            "voice:tts:setVoice",
            &json!({"voiceId":"system:café"})
        ));
        for (op, value) in [
            ("voice:setEndpointSilence", json!({"seconds":0})),
            ("voice:setEndpointSilence", json!({"seconds":10.1})),
            ("voice:tts:setEngine", json!({"engine":"elevenlabs"})),
            ("voice:installModel", json!({"id":"/foreign/model"})),
            (
                "voice:tts:setVoice",
                json!({"voiceId":"local:kokoro-en-v0_19:001"}),
            ),
            ("voice:tts:setMaxChars", json!({"maxChars":1.5})),
            ("voice:removeRuntime", json!({"rootDir":"/foreign/runtime"})),
            ("voice:tts:setSpeed", json!({"speed":1,"authority":"all"})),
            ("voice:pushAudio", json!({"turnId":"foreign","chunk":[]})),
        ] {
            assert!(!valid_request(op, &value), "{op}");
        }
        let mut runtime = json!({"installed":true,"version":"1.0.0","modulePath":"__21x_local_voice_runtime__","sizeBytes":180000000});
        assert!(valid_result(
            "voice:getRuntime",
            &json!({"defined":true,"value":runtime})
        ));
        runtime["modulePath"] = json!("/private/profile/runtime");
        assert!(!valid_result(
            "voice:getRuntime",
            &json!({"defined":true,"value":runtime})
        ));
        assert!(!valid_event(
            "voice:speech:chunk",
            &json!({"pcm":"unreviewed"})
        ));
        assert!(!valid_event(
            "voice:runtimeProgress",
            &json!({"stage":"installing","output":"raw process credential","percent":10})
        ));
        assert!(valid_event(
            "voice:runtimeProgress",
            &json!({"stage":"error","output":VOICE_ERROR,"percent":100})
        ));
    }
    #[test]
    fn agent_key_inputs_have_finite_vendors_and_outputs_only_keep_markers() {
        assert!(valid_request(
            "agent:update",
            &json!({"id":"agent_fixture","data":{"config":{"api_keys":{"openai":"synthetic fixture key","anthropic":"","cursor":"__21x_api_key_set__"}}}})
        ));
        assert!(valid_request(
            "agent:create",
            &json!({"data":{"name":"Fixture","config":{"api_keys":{"openai":"x".repeat(16384)}}}})
        ));
        for keys in [
            json!({"unknown":"value"}),
            json!({"openai":{"value":"injected"}}),
            json!({"openai":"bad\nheader"}),
            json!({"openai":"x".repeat(16385)}),
            json!({"openai":"💬".repeat(4097)}),
        ] {
            assert!(!valid_request(
                "agent:update",
                &json!({"id":"agent_fixture","data":{"config":{"api_keys":keys}}})
            ));
        }
        let mut agent = json!({"id":"agent_fixture","name":"Fixture","server_url":"http://localhost:4096","config":{"coding_agent":"pi","api_keys":{"openai":"__21x_api_key_set__"}},"is_default":false,"created_at":"fixture","updated_at":"fixture"});
        assert!(valid_result(
            "agent:getAll",
            &json!({"defined":true,"value":[agent.clone()]})
        ));
        agent["config"]["api_keys"]["openai"] = json!("private stored key");
        assert!(!valid_result(
            "agent:update",
            &json!({"defined":true,"value":agent})
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
    fn artifact_wire_bounds_and_paths_do_not_create_generic_file_authority() {
        assert!(valid_request(
            "artifacts:read",
            &json!({"taskId":"task_fixture","relativePath":"artifacts/report.md"})
        ));
        for path in [
            "../private",
            "/private",
            "C:/private",
            "artifacts/./report.md",
            "artifacts//report.md",
            "artifacts\\report.md",
            "artifacts/bad\0name",
        ] {
            assert!(!valid_request(
                "artifacts:read",
                &json!({"taskId":"task_fixture","relativePath":path})
            ));
        }
        assert!(!valid_request(
            "artifacts:scan",
            &json!({"taskId":"task_fixture","root":"/private"})
        ));
        for mime in ["text/markdown", "text/typescript", "application/yaml"] {
            assert!(valid_result(
                "artifacts:read",
                &json!({"defined":true,"value":{"kind":"text","content":"Owned report\n","mimeType":mime}})
            ));
        }
        assert!(valid_result(
            "artifacts:read",
            &json!({"defined":true,"value":null})
        ));
        assert!(!valid_result(
            "artifacts:read",
            &json!({"defined":true,"value":{"kind":"text","content":"x".repeat(128*1024+1)}})
        ));
        assert!(!valid_result(
            "artifacts:read",
            &json!({"defined":true,"value":{"kind":"text","content":"Owned report","privatePath":"/private"}})
        ));
        assert!(valid_result(
            "artifacts:read",
            &json!({"defined":true,"value":{"kind":"data_url","content":"data:image/png;base64,AA==","mimeType":"image/png"}})
        ));
        assert!(!valid_result(
            "artifacts:read",
            &json!({"defined":true,"value":{"kind":"data_url","content":"data:text/html;base64,AA==","mimeType":"text/html"}})
        ));
        let row = json!({"path":"report.md","title":"Report","type":"markdown","updatedAt":100.0,"size":42});
        assert!(valid_result(
            "artifacts:scan",
            &json!({"defined":true,"value":[row.clone()]})
        ));
        assert!(!valid_result(
            "artifacts:scan",
            &json!({"defined":true,"value":[row.clone(),row]})
        ));
        assert!(!valid_result(
            "artifacts:scan",
            &json!({"defined":true,"value":[],"authority":"*"})
        ));
    }
    #[test]
    fn detection_snapshots_keep_exact_metadata_without_child_output_or_credentials() {
        let mut snapshot = serde_json::Map::new();
        for key in DETECTION_KEYS {
            snapshot.insert((*key).to_owned(), json!({"installed":false,"version":null}));
        }
        snapshot.insert("pi".into(),json!({"installed":false,"version":null,"supported":false,"reason":"Pi CLI is not installed."}));
        snapshot.insert("rtk".into(),json!({"installed":false,"version":null,"configured":false,"integrations":{"claudeCode":false,"opencode":false,"codex":false,"cursor":false,"pi":false}}));
        let mut snapshot = Value::Object(snapshot);
        assert!(valid_result(
            "agent-installer:detect",
            &json!({"defined":true,"value":snapshot.clone()})
        ));
        assert!(!valid_request(
            "agent-installer:detect",
            &json!({"command":"arbitrary"})
        ));
        snapshot["claudeCode"] = json!({"installed":true,"version":"2.1.0"});
        snapshot["rtk"]["installed"] = json!(true);
        snapshot["rtk"]["version"] = json!("0.31.1");
        snapshot["rtk"]["configured"] = json!(true);
        snapshot["rtk"]["integrations"]["claudeCode"] = json!(true);
        assert!(valid_result(
            "agent-installer:detect",
            &json!({"defined":true,"value":snapshot.clone()})
        ));
        snapshot["rtk"]["configured"] = json!(false);
        assert!(!valid_result(
            "agent-installer:detect",
            &json!({"defined":true,"value":snapshot.clone()})
        ));
        snapshot["rtk"]["configured"] = json!(true);
        snapshot["codex"]["stdout"] = json!("private child output");
        assert!(!valid_result(
            "agent-installer:detect",
            &json!({"defined":true,"value":snapshot})
        ));
        for version in ["2.51.0.windows.2", "0.113.0-alpha.25", "0.80.5", "1.2"] {
            assert!(detection_version(&json!(version)));
        }
        for version in [
            "private-token",
            "1.2.3+private",
            "1.2.3.4",
            "1.2.3-dev-private",
            "1.2.3.windows.1.2",
        ] {
            assert!(!detection_version(&json!(version)));
        }
    }
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
