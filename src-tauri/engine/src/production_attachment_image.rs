//! Bounded private wire envelope. Source and renderer additionally admit full
//! raster container dimensions/frames before any WebView image decoding.
use super::contracts::object;
use serde_json::Value;

pub fn result(value: &Value) -> bool {
    if !object(value, &["defined", "value"], &[]) || value["defined"] != true {
        return false;
    }
    let image = &value["value"];
    if !object(image, &["mimeType", "data"], &[])
        || !matches!(
            image["mimeType"].as_str(),
            Some("image/png" | "image/jpeg" | "image/gif" | "image/webp")
        )
    {
        return false;
    }
    image["data"].as_str().is_some_and(canonical)
}
fn six(byte: u8) -> Option<u8> {
    Some(match byte {
        b'A'..=b'Z' => byte - b'A',
        b'a'..=b'z' => byte - b'a' + 26,
        b'0'..=b'9' => byte - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    })
}
fn canonical(data: &str) -> bool {
    let bytes = data.as_bytes();
    if bytes.is_empty() || bytes.len() % 4 != 0 || bytes.len() > (512 * 1024_usize).div_ceil(3) * 4
    {
        return false;
    }
    let padding = bytes.iter().rev().take_while(|v| **v == b'=').count();
    if padding > 2
        || !bytes[..bytes.len() - padding]
            .iter()
            .all(|v| six(*v).is_some())
    {
        return false;
    }
    let size = bytes.len() / 4 * 3 - padding;
    if !(3..=512 * 1024).contains(&size) {
        return false;
    }
    let last = six(bytes[bytes.len() - padding - 1]).unwrap_or(255);
    padding == 0 || padding == 1 && last & 3 == 0 || padding == 2 && last & 15 == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn exact_finite_envelope_and_canonical_padding() {
        let wrap =
            |data: &str| json!({"defined":true,"value":{"mimeType":"image/png","data":data}});
        assert!(result(&wrap("AAAA")));
        assert!(result(&wrap("AAAAAA==")));
        assert!(result(&wrap("AAAAAAA=")));
        for data in [
            "", "AA==", "AAAAAB==", "AAAAAAB=", "AAAA===", "AAAA\n", "AA_A", "=AAA",
        ] {
            assert!(!result(&wrap(data)), "{data}");
        }
        assert!(!result(&wrap(&"A".repeat(699_052))));
        assert!(!result(
            &json!({"defined":true,"value":{"mimeType":"image/svg+xml","data":"AAAA"}})
        ));
        assert!(!result(
            &json!({"defined":true,"value":{"mimeType":"image/png","data":"AAAA","path":"/etc/passwd"}})
        ));
        assert!(!result(&json!({"defined":false})));
    }
}
