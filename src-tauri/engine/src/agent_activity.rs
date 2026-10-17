//! Shared finite activity metadata policy; no diagnostic or production grants.
use serde_json::Value;

pub(super) fn valid_metadata(payload: &Value) -> bool {
    payload.get("epoch").is_some() == payload.get("seq").is_some()
        && payload.get("epoch").is_none_or(|value| {
            value.as_str().is_some_and(|s| {
                !s.is_empty()
                    && s.len() <= 128
                    && s.as_bytes()[0].is_ascii_alphanumeric()
                    && s.bytes().all(|c| {
                        c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b':' | b'-')
                    })
            })
        })
        && payload.get("seq").is_none_or(|value| {
            value
                .as_u64()
                .is_some_and(|n| (1..=9_007_199_254_740_991).contains(&n))
        })
        && payload
            .get("heartbeat")
            .is_none_or(|item| *item == true && payload.get("epoch").is_some())
        && payload
            .get("disconnected")
            .is_none_or(|item| *item == true && payload["heartbeat"] == true)
        && payload.get("activityOutcome").is_none_or(|outcome| {
            payload.get("epoch").is_some()
                && payload.get("heartbeat").is_none()
                && payload.get("disconnected").is_none()
                && if *outcome == "failed" {
                    payload["status"] == "error"
                } else {
                    matches!(
                        outcome.as_str(),
                        Some("completed" | "cancelled" | "interrupted")
                    ) && payload["status"] == "idle"
                }
        })
}
