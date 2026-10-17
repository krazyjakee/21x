//! Explicit Windows-only synthetic fixture, never a production entrypoint.
//! Uses the same atomic Job/pipe implementation as production. Run only with
//! TWENTYONEX_TEST_NODE pointing at the pinned staged standalone Node resource.
#[cfg(windows)]
use twentyonex_engine::EngineError;
#[cfg(windows)]
const DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);
#[cfg(windows)]
fn token(value: &str, min: usize, max: usize, _dot: bool) -> bool {
    value.len() >= min
        && value.len() <= max
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
#[cfg(windows)]
fn problem(code: &'static str, phase: &'static str) -> EngineError {
    let mut error = EngineError::new(code);
    error.startup_phase = Some(phase);
    error
}
#[cfg(windows)]
#[path = "../src/production_windows.rs"]
mod windows;

#[cfg(windows)]
#[tokio::main(flavor = "current_thread")]
async fn main() {
    use std::{
        fs,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        path::PathBuf,
        process::{Child, Command, Stdio},
        time::Duration,
    };
    use tokio::io::{AsyncBufReadExt, BufReader};
    use windows_sys::Win32::{
        Foundation::WAIT_OBJECT_0,
        System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE,
        },
    };
    struct Unrelated(Child);
    impl Drop for Unrelated {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let node = PathBuf::from(
        std::env::var_os("TWENTYONEX_TEST_NODE").expect("explicit staged Node required"),
    );
    assert!(node.is_absolute() && node.is_file());
    assert_eq!(
        String::from_utf8(
            Command::new(&node)
                .arg("--version")
                .env_clear()
                .output()
                .unwrap()
                .stdout
        )
        .unwrap()
        .trim(),
        "v22.23.2"
    );
    let root =
        std::env::temp_dir().join(format!("21x Windows Job 🚀 Proof {}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let entry = root.join("fixture unicode 🚀.cjs");
    fs::write(&entry, r#"const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
child.unref(); process.stdout.write(JSON.stringify({pid:child.pid,root:process.pid})+'\n'); process.stdin.resume();"#).unwrap();
    let mut unrelated = Unrelated(
        Command::new(&node)
            .env_clear()
            .args(["-e", "setInterval(()=>{},1000)"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    for close_handle in [false, true] {
        let windows::Spawned {
            scope,
            stdin,
            stdout,
        } = windows::spawn(
            &node,
            &entry,
            &root,
            &format!("fixture_{}_{}", std::process::id(), close_handle),
        )
        .await
        .unwrap();
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        let receipt = serde_json::from_str::<serde_json::Value>(&line).unwrap();
        let pid = receipt["pid"].as_u64().unwrap() as u32;
        let root_pid = receipt["root"].as_u64().unwrap() as u32;
        let root_raw = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                root_pid,
            )
        };
        assert!(!root_raw.is_null());
        let root_handle = unsafe { OwnedHandle::from_raw_handle(root_raw) };
        assert!(scope.contains(&root_handle).unwrap());
        let raw = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        assert!(!raw.is_null());
        let descendant = unsafe { OwnedHandle::from_raw_handle(raw) };
        assert!(scope.contains(&descendant).unwrap());
        assert_eq!(scope.active().unwrap(), 2);
        assert!(scope.prove_ready().is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(100), scope.await_leader_only())
                .await
                .is_err()
        );
        if close_handle {
            drop(scope);
        } else {
            scope.finish().await.unwrap();
            assert_eq!(scope.active().unwrap(), 0);
            assert!(!scope.alive().unwrap());
        }
        assert_eq!(
            unsafe { WaitForSingleObject(root_handle.as_raw_handle(), 5000) },
            WAIT_OBJECT_0
        );
        assert_eq!(
            unsafe { WaitForSingleObject(descendant.as_raw_handle(), 5000) },
            WAIT_OBJECT_0
        );
        assert!(unrelated.0.try_wait().unwrap().is_none());
        drop(stdin);
        drop(reader);
    }
    drop(unrelated);
    fs::remove_dir_all(&root).unwrap();
    println!("{{\"proof\":\"windows-production-containment\",\"normalDrain\":true,\"lastJobHandleClose\":true,\"detachedDescendantExited\":true,\"unrelatedProcessSurvived\":true,\"fixtureRemoved\":true}}");
}

#[cfg(not(windows))]
fn main() {
    panic!("Windows runtime proof requires Windows; compile evidence alone does not run it");
}
