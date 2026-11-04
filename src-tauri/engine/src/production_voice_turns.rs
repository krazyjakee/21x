//! Native outer policy for live voice: microphone turns, confirmations, spoken
//! answers and Commander voice mode. The service validates the full domain
//! shapes again (`src/shared/voice-turn-codecs.ts`); this mirrors them so a
//! malformed frame never reaches it and a malformed event never reaches the
//! window. Audio crosses as base64 PCM; nothing here stores it.
use super::{bounded_bytes, id, integer, object};
use serde_json::Value;

pub const COMMANDS: &[&str] = &[
    "voice:startTurn",
    "voice:pushAudio",
    "voice:endTurn",
    "voice:cancelTurn",
    "voice:confirm",
    "voice:dismiss",
    "voice:expectAnswer",
    "voice:answerNotExpected",
    "voice:tts:preview",
    "voice:tts:speak",
    "voice:tts:stop",
    "voice:commander:setActive",
    "voice:commander:bargeIn",
    "voice:commander:send",
];
pub const EVENTS: &[&str] = &[
    "voice:state",
    "voice:partial",
    "voice:final",
    "voice:segment",
    "voice:outcome",
    "voice:error",
    "voice:navigate",
    "voice:dictate",
    "voice:hotkey",
    "voice:speech:start",
    "voice:speech:chunk",
    "voice:speech:end",
];

const TEXT_BYTES: usize = 65536;
/// About 100 ms of 16 kHz mono PCM is 3,200 bytes; leave room for slack.
const AUDIO_BYTES: usize = 64 * 1024;
/// One synthesized chunk decodes to at most 128 KiB.
const SPEECH_BYTES: usize = 128 * 1024;
const FRAME_BYTES: usize = 256 * 1024;
const VIEWS: &[&str] = &[
    "tasks",
    "skills",
    "dashboard",
    "canvas",
    "commander",
    "overview",
    "settings",
];
const STATES: &[&str] = &[
    "disabled",
    "idle",
    "model_needed",
    "permission_needed",
    "listening",
    "transcribing",
    "awaiting_confirmation",
    "executing",
    "waiting_for_agent",
    "speaking",
    "error",
];

fn words(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|s| s.len() <= max && !s.contains('\0'))
}
fn one_of(value: &Value, set: &[&str]) -> bool {
    value.as_str().is_some_and(|s| set.contains(&s))
}
fn optional_id(value: Option<&Value>) -> bool {
    value.is_none_or(|v| v.is_null() || id(v))
}
/// Canonical padded base64 of an even number of bytes, at most `max` decoded.
fn pcm(value: &Value, max: usize) -> bool {
    let Some(s) = value.as_str() else {
        return false;
    };
    if s.is_empty() || s.len() % 4 != 0 || s.len() > max.div_ceil(3) * 4 {
        return false;
    }
    let body = s.trim_end_matches('=');
    if s.len() - body.len() > 2
        || !body
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
    {
        return false;
    }
    let decoded = s.len() / 4 * 3 - (s.len() - body.len());
    decoded >= 2 && decoded <= max && decoded % 2 == 0
}
fn context(v: &Value) -> bool {
    object(
        v,
        &[],
        &[
            "selectedTaskId",
            "view",
            "pendingApproval",
            "visibleTaskIds",
        ],
    ) && optional_id(v.get("selectedTaskId"))
        && v.get("view").is_none_or(|x| one_of(x, VIEWS))
        && v.get("pendingApproval").is_none_or(|x| {
            x.is_null()
                || object(x, &["taskId", "sessionId"], &[])
                    && id(&x["taskId"])
                    && id(&x["sessionId"])
        })
        && v.get("visibleTaskIds").is_none_or(|x| {
            x.as_array()
                .is_some_and(|items| items.len() <= 500 && items.iter().all(id))
        })
}

pub fn request(operation: &str, v: &Value) -> bool {
    if !bounded_bytes(v, FRAME_BYTES) {
        return false;
    }
    match operation {
        "voice:tts:stop" => object(v, &[], &[]),
        "voice:startTurn" => {
            object(v, &["mode", "context"], &[])
                && one_of(&v["mode"], &["dictation", "command", "conversation"])
                && context(&v["context"])
        }
        "voice:pushAudio" => {
            object(v, &["turnId", "chunk"], &[])
                && id(&v["turnId"])
                && pcm(&v["chunk"], AUDIO_BYTES)
        }
        "voice:endTurn" => object(v, &["turnId"], &[]) && id(&v["turnId"]),
        "voice:cancelTurn" => {
            object(v, &[], &["turnId", "turnEpoch"])
                && optional_id(v.get("turnId"))
                && optional_id(v.get("turnEpoch"))
        }
        "voice:confirm" => {
            object(v, &["turnId"], &["choice", "turnEpoch"])
                && id(&v["turnId"])
                && optional_id(v.get("turnEpoch"))
                && v.get("choice").is_none_or(|c| {
                    object(c, &[], &["taskId", "agentName"])
                        && optional_id(c.get("taskId"))
                        && c.get("agentName").is_none_or(|x| words(x, 512))
                })
        }
        "voice:dismiss" => {
            object(v, &["turnId"], &["turnEpoch"])
                && id(&v["turnId"])
                && optional_id(v.get("turnEpoch"))
        }
        "voice:expectAnswer" => {
            object(v, &["turnId"], &["taskId"]) && id(&v["turnId"]) && optional_id(v.get("taskId"))
        }
        "voice:answerNotExpected" => object(v, &[], &["taskId"]) && optional_id(v.get("taskId")),
        "voice:tts:preview" => object(v, &["voiceId"], &[]) && words(&v["voiceId"], 512),
        "voice:tts:speak" => {
            object(v, &["text"], &["taskId"])
                && words(&v["text"], TEXT_BYTES)
                && optional_id(v.get("taskId"))
        }
        "voice:commander:setActive" => {
            object(v, &["sessionId"], &[]) && (v["sessionId"].is_null() || id(&v["sessionId"]))
        }
        "voice:commander:bargeIn" => object(v, &["sessionId"], &[]) && id(&v["sessionId"]),
        "voice:commander:send" => {
            object(v, &["sessionId", "text"], &[])
                && id(&v["sessionId"])
                && words(&v["text"], TEXT_BYTES)
                && v["text"].as_str().is_some_and(|s| !s.trim().is_empty())
        }
        _ => false,
    }
}

fn void(v: &Value) -> bool {
    object(v, &["defined"], &[]) && v["defined"] == false
}
fn defined(v: &Value, check: impl Fn(&Value) -> bool) -> bool {
    object(v, &["defined", "value"], &[]) && v["defined"] == true && check(&v["value"])
}
fn flag(v: &Value, key: &str) -> bool {
    object(v, &[key], &[]) && v[key].is_boolean()
}

pub fn result(operation: &str, v: &Value) -> bool {
    if !bounded_bytes(v, FRAME_BYTES + 64) {
        return false;
    }
    match operation {
        "voice:startTurn" => defined(v, |r| {
            object(r, &["turnId"], &["turnEpoch"])
                && id(&r["turnId"])
                && optional_id(r.get("turnEpoch"))
                || object(r, &["error"], &[]) && words(&r["error"], 4096)
        }),
        "voice:pushAudio"
        | "voice:endTurn"
        | "voice:cancelTurn"
        | "voice:dismiss"
        | "voice:expectAnswer"
        | "voice:answerNotExpected"
        | "voice:tts:stop" => void(v),
        "voice:confirm" => defined(v, |r| flag(r, "success")),
        "voice:tts:preview" | "voice:tts:speak" => defined(v, |r| flag(r, "spoken")),
        "voice:commander:setActive" => defined(v, |r| {
            object(r, &["active"], &[]) && (r["active"].is_null() || id(&r["active"]))
        }),
        "voice:commander:bargeIn" => defined(v, |r| flag(r, "cancelled")),
        "voice:commander:send" => defined(v, |r| {
            object(r, &["turnId", "message"], &[]) && id(&r["turnId"]) && r["message"].is_object()
        }),
        _ => false,
    }
}

fn turn_owner(v: &Value) -> bool {
    optional_id(v.get("turnId")) && optional_id(v.get("turnEpoch"))
}
fn turn_text(v: &Value, segment: bool) -> bool {
    object(
        v,
        if segment {
            &["turnId", "turnEpoch", "text", "index"]
        } else {
            &["turnId", "turnEpoch", "text"]
        },
        &[],
    ) && id(&v["turnId"])
        && (v["turnEpoch"].is_null() || id(&v["turnEpoch"]))
        && words(&v["text"], TEXT_BYTES)
        && (!segment || integer(&v["index"]))
}
fn outcome(v: &Value) -> bool {
    let base = ["status", "turnId"];
    fn with<'a>(extra: &[&'a str]) -> Vec<&'a str> {
        ["status", "turnId"]
            .into_iter()
            .chain(extra.iter().copied())
            .collect()
    }
    if !id(&v["turnId"])
        || !optional_id(v.get("turnEpoch"))
        || v.get("turnEpoch").is_some_and(Value::is_null)
    {
        return false;
    }
    match v["status"].as_str() {
        Some("cancelled") => object(v, &base, &["turnEpoch"]),
        Some("completed") => {
            object(v, &with(&["segments"]), &["turnEpoch"]) && integer(&v["segments"])
        }
        Some("dictation") => {
            object(v, &with(&["text"]), &["turnEpoch"]) && words(&v["text"], TEXT_BYTES)
        }
        Some("executed") => {
            object(v, &with(&["intent", "message"]), &["turnEpoch", "taskId"])
                && words(&v["intent"], 64)
                && words(&v["message"], TEXT_BYTES)
                && optional_id(v.get("taskId"))
        }
        Some("rejected") => {
            object(v, &with(&["reason", "message"]), &["turnEpoch"])
                && words(&v["reason"], 64)
                && words(&v["message"], TEXT_BYTES)
        }
        Some("needs_confirmation") => {
            object(
                v,
                &with(&["proposal", "reason"]),
                &["turnEpoch", "candidates"],
            ) && v["proposal"].is_object()
                && words(&v["reason"], 64)
                && v.get("candidates").is_none_or(|c| {
                    c.as_array().is_some_and(|items| {
                        items.len() <= 16
                            && items.iter().all(|item| {
                                object(item, &["id", "label", "kind"], &[])
                                    && id(&item["id"])
                                    && words(&item["label"], 4096)
                                    && one_of(&item["kind"], &["task", "agent"])
                            })
                    })
                })
        }
        _ => false,
    }
}
fn speech_head(v: &Value) -> bool {
    id(&v["speechId"]) && integer(&v["speechGeneration"])
}
fn sample_rate(v: &Value) -> bool {
    v.as_u64().is_some_and(|n| n > 0 && n <= 192_000)
}

pub fn event(operation: &str, v: &Value) -> bool {
    if !bounded_bytes(v, FRAME_BYTES) {
        return false;
    }
    match operation {
        "voice:state" => {
            object(v, &["state"], &["turnId", "turnEpoch", "detail"])
                && one_of(&v["state"], STATES)
                && turn_owner(v)
                && v.get("detail").is_none_or(|x| words(x, 4096))
        }
        "voice:partial" | "voice:final" => turn_text(v, false),
        "voice:segment" => turn_text(v, true),
        "voice:outcome" => outcome(v),
        "voice:error" => {
            object(v, &["message"], &["code", "turnId", "turnEpoch"])
                && words(&v["message"], 4096)
                && v.get("code").is_none_or(|x| words(x, 128))
                && turn_owner(v)
        }
        "voice:navigate" => {
            object(v, &["destination", "taskId"], &[])
                && one_of(&v["destination"], VIEWS)
                && (v["taskId"].is_null() || id(&v["taskId"]))
        }
        "voice:dictate" => {
            object(v, &["turnId", "text"], &[]) && id(&v["turnId"]) && words(&v["text"], TEXT_BYTES)
        }
        "voice:hotkey" => object(v, &["action"], &[]) && words(&v["action"], 64),
        "voice:speech:start" => {
            object(
                v,
                &[
                    "speechId",
                    "speechGeneration",
                    "source",
                    "text",
                    "sampleRate",
                    "truncated",
                ],
                &["taskId"],
            ) && speech_head(v)
                && one_of(
                    &v["source"],
                    &[
                        "agent_answer",
                        "action_result",
                        "read_last_answer",
                        "preview",
                        "manual",
                        "conversation",
                    ],
                )
                && words(&v["text"], TEXT_BYTES)
                && sample_rate(&v["sampleRate"])
                && v["truncated"].is_boolean()
                && optional_id(v.get("taskId"))
        }
        "voice:speech:chunk" => {
            object(
                v,
                &[
                    "speechId",
                    "speechGeneration",
                    "index",
                    "pcm",
                    "sampleRate",
                    "text",
                ],
                &[],
            ) && speech_head(v)
                && integer(&v["index"])
                && pcm(&v["pcm"], SPEECH_BYTES)
                && sample_rate(&v["sampleRate"])
                && words(&v["text"], TEXT_BYTES)
        }
        "voice:speech:end" => {
            object(v, &["speechId", "speechGeneration", "reason"], &["message"])
                && speech_head(v)
                && one_of(&v["reason"], &["complete", "cancelled", "error", "skipped"])
                && v.get("message").is_none_or(|x| words(x, 4096))
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_voice_operation_is_admitted_by_the_production_lists() {
        for op in COMMANDS {
            assert!(crate::production::contracts::COMMANDS.contains(op), "{op}");
        }
        for op in EVENTS {
            assert!(crate::production::contracts::EVENTS.contains(op), "{op}");
        }
    }

    #[test]
    fn turns_admit_bounded_audio_and_known_shapes_only() {
        assert!(request(
            "voice:startTurn",
            &json!({"mode":"dictation","context":{"selectedTaskId":"task_1","view":"tasks","visibleTaskIds":["a","b"]}})
        ));
        assert!(!request(
            "voice:startTurn",
            &json!({"mode":"shell","context":{}})
        ));
        assert!(!request(
            "voice:startTurn",
            &json!({"mode":"command","context":{"cwd":"/"}})
        ));
        assert!(request(
            "voice:pushAudio",
            &json!({"turnId":"t1","chunk":"AAA="})
        ));
        // Odd byte count, bad alphabet, oversize and non-string chunks refuse.
        assert!(!request(
            "voice:pushAudio",
            &json!({"turnId":"t1","chunk":"AA=="})
        ));
        assert!(!request(
            "voice:pushAudio",
            &json!({"turnId":"t1","chunk":"AA*A"})
        ));
        assert!(!request(
            "voice:pushAudio",
            &json!({"turnId":"t1","chunk":"A".repeat(90_000)})
        ));
        assert!(!request(
            "voice:pushAudio",
            &json!({"turnId":"t1","chunk":[]})
        ));
        assert!(request("voice:cancelTurn", &json!({})));
        assert!(request(
            "voice:confirm",
            &json!({"turnId":"t","choice":{"taskId":"x"},"turnEpoch":"e"})
        ));
        assert!(!request(
            "voice:confirm",
            &json!({"turnId":"t","choice":{"command":"rm"}})
        ));
        assert!(request(
            "voice:commander:setActive",
            &json!({"sessionId":null})
        ));
        assert!(!request(
            "voice:commander:send",
            &json!({"sessionId":"s","text":"  "})
        ));
    }

    #[test]
    fn results_and_events_match_the_service_codec() {
        assert!(result(
            "voice:startTurn",
            &json!({"defined":true,"value":{"turnId":"t","turnEpoch":"e"}})
        ));
        assert!(result(
            "voice:startTurn",
            &json!({"defined":true,"value":{"error":"Voice is switched off."}})
        ));
        assert!(result("voice:pushAudio", &json!({"defined":false})));
        assert!(!result(
            "voice:pushAudio",
            &json!({"defined":true,"value":null})
        ));
        assert!(event(
            "voice:state",
            &json!({"state":"listening","turnId":"t","turnEpoch":"e"})
        ));
        assert!(!event("voice:state", &json!({"state":"hacking"})));
        assert!(event(
            "voice:partial",
            &json!({"turnId":"t","turnEpoch":null,"text":"hello"})
        ));
        assert!(event(
            "voice:outcome",
            &json!({"status":"needs_confirmation","turnId":"t","turnEpoch":"e","proposal":{"intent":{"type":"cancel"}},"reason":"policy","candidates":[{"id":"x","label":"X","kind":"task"}]})
        ));
        assert!(!event(
            "voice:outcome",
            &json!({"status":"executed","turnId":"t"})
        ));
        assert!(event(
            "voice:speech:chunk",
            &json!({"speechId":"s","speechGeneration":1,"index":0,"pcm":"AAA=","sampleRate":24000,"text":"Hi."})
        ));
        assert!(!event(
            "voice:speech:chunk",
            &json!({"speechId":"s","speechGeneration":1,"index":0,"pcm":"unreviewed","sampleRate":24000,"text":""})
        ));
        assert!(event(
            "voice:navigate",
            &json!({"destination":"tasks","taskId":null})
        ));
        assert!(!event(
            "voice:navigate",
            &json!({"destination":"file:///etc","taskId":null})
        ));
    }
}
