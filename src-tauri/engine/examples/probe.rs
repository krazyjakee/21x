//! Run the real supervisor and native probes without compiling a WebView host.
use serde_json::json;
use std::{io, path::PathBuf, time::SystemTime};
use twentyonex_engine::Engine;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let resources = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("Pass the explicitly staged resources directory"))?;
    let stamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)?
        .as_nanos();
    let profile =
        std::env::temp_dir().join(format!("21x-native-probe-{}-{stamp}", std::process::id()));
    std::fs::create_dir(&profile)?;
    let outcome = match Engine::start(resources, profile.clone()).await {
        Ok(engine) => {
            let result = engine.request("engine.probe", json!({})).await;
            engine.shutdown().await;
            result.map_err(|_| io::Error::other("Native probe failed; inspect staged dependencies"))
        }
        Err(_) => Err(io::Error::other("Staged runtime could not initialize")),
    };
    std::fs::remove_dir_all(&profile)?;
    let report = outcome?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    if report["ok"] != true {
        return Err(io::Error::other("One or more native feasibility checks failed").into());
    }
    Ok(())
}
