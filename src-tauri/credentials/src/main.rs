use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::json;
use std::io::{IsTerminal, Read, Write};
use zeroize::{Zeroize, Zeroizing};

#[cfg(unix)]
fn private_pipes() -> bool {
    use std::os::fd::AsFd;
    use std::os::unix::fs::FileTypeExt;
    let check = |descriptor: std::os::fd::OwnedFd| {
        std::fs::File::from(descriptor)
            .metadata()
            .map(|metadata| {
                let kind = metadata.file_type();
                kind.is_fifo() || kind.is_socket()
            })
            .unwrap_or(false)
    };
    let input = std::io::stdin().as_fd().try_clone_to_owned();
    let output = std::io::stdout().as_fd().try_clone_to_owned();
    match (input, output) {
        (Ok(input), Ok(output)) => check(input) && check(output),
        _ => false,
    }
}

#[cfg(windows)]
fn private_pipes() -> bool {
    use std::os::windows::io::AsRawHandle;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileType(handle: *mut std::ffi::c_void) -> u32;
    }
    // Official Win32 FILE_TYPE_PIPE includes anonymous pipes. No filesystem I/O.
    unsafe {
        GetFileType(std::io::stdin().as_raw_handle()) == 3
            && GetFileType(std::io::stdout().as_raw_handle()) == 3
    }
}

#[cfg(not(any(unix, windows)))]
fn private_pipes() -> bool {
    false
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u8,
    operation: String,
    account: String,
    key: Option<String>,
}

impl Drop for Request {
    fn drop(&mut self) {
        if let Some(key) = &mut self.key {
            key.zeroize();
        }
    }
}

fn handle(request: &Request) -> Result<serde_json::Value, &'static str> {
    if request.version != 1 {
        return Err("KEYSTORE_PROTOCOL_ERROR");
    }
    let mut response = json!({"version":1,"ok":true,"backend":twentyonex_credentials::backend()});
    match request.operation.as_str() {
        "load" if request.key.is_none() => {
            let key = twentyonex_credentials::load(&request.account)?;
            response["key"] = json!(STANDARD.encode(key.as_slice()));
        }
        "create" => {
            let encoded = request.key.as_deref().ok_or("KEYSTORE_PROTOCOL_ERROR")?;
            let key = Zeroizing::new(
                STANDARD
                    .decode(encoded)
                    .map_err(|_| "KEYSTORE_INVALID_DATA")?,
            );
            if STANDARD.encode(key.as_slice()) != encoded {
                return Err("KEYSTORE_INVALID_DATA");
            }
            twentyonex_credentials::create(&request.account, key.as_slice())?;
        }
        "delete-fixture" if request.key.is_none() => {
            twentyonex_credentials::delete_fixture(&request.account)?
        }
        _ => return Err("KEYSTORE_PROTOCOL_ERROR"),
    }
    Ok(response)
}

fn main() {
    // Never print debug/panic/provider error text, which may contain secrets.
    std::panic::set_hook(Box::new(|_| {}));
    if std::io::stdin().is_terminal() || std::io::stdout().is_terminal() || !private_pipes() {
        std::process::exit(1);
    }
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    // Non-secret attestation for Electron/Windows, whose CRT fstat view of an
    // inherited pipe can look like a file and whose process.stdin is always EOF.
    // Inspect native handles only; never consume the queued exporter control data.
    if arguments.len() == 1 && arguments[0] == "--attest-private-stdio" {
        let metadata = b"21X_PIPE_ATTEST {\"version\":1,\"privatePipes\":true}\n";
        let written = std::io::stdout()
            .write_all(metadata)
            .and_then(|_| std::io::stdout().flush());
        std::process::exit(if written.is_ok() { 0 } else { 1 });
    }
    if !arguments.is_empty() {
        std::process::exit(1);
    }
    let result = std::panic::catch_unwind(|| {
        let mut input = Zeroizing::new(Vec::new());
        std::io::stdin()
            .take(4097)
            .read_to_end(&mut input)
            .map_err(|_| "KEYSTORE_PROTOCOL_ERROR")?;
        if input.len() > 4096 {
            return Err("KEYSTORE_PROTOCOL_ERROR");
        }
        let request: Request =
            serde_json::from_slice(&input).map_err(|_| "KEYSTORE_PROTOCOL_ERROR")?;
        handle(&request)
    });
    let response = match result {
        Ok(Ok(response)) => response,
        Ok(Err(code)) => json!({"version":1,"ok":false,"code":code}),
        Err(_) => json!({"version":1,"ok":false,"code":"KEYSTORE_NO_ACCESS"}),
    };
    let ok = response["ok"] == true;
    let mut bytes = serde_json::to_vec(&response).unwrap_or_default();
    let written = std::io::stdout()
        .write_all(&bytes)
        .and_then(|_| std::io::stdout().flush());
    bytes.zeroize();
    if !ok || written.is_err() {
        std::process::exit(1);
    }
}
