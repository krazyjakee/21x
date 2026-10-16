//! Finite workspace cleanup observations, not a process-control facility.
//! A ticket pins physical roots, never promises future process absence. Source
//! must retain managed admission and request a fresh check before every effect.
use super::{contracts, EngineError};
use serde_json::{json, Value};

pub fn request(value: &Value) -> bool {
    let action = value["action"].as_str();
    contracts::object(
        value,
        &["version", "action", "taskId"],
        if action == Some("acquire") {
            &[]
        } else {
            &["leaseId"]
        },
    ) && value["version"] == 1
        && value["taskId"].as_str().is_some_and(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        })
        && match action {
            Some("acquire") => value.get("leaseId").is_none(),
            Some("check" | "release") => uuid(&value["leaseId"]),
            _ => false,
        }
}
fn uuid(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 36
            && s.bytes().enumerate().all(|(i, b)| match i {
                8 | 13 | 18 | 23 => b == b'-',
                14 => b == b'4',
                19 => matches!(b, b'8' | b'9' | b'a' | b'b'),
                _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
            })
    })
}
pub fn result(action: &str, value: &Value) -> bool {
    match action {
        "release" => value == &json!({"released":true}),
        "acquire" if value["status"] == "idle" => {
            contracts::object(value, &["status", "leaseId"], &[]) && uuid(&value["leaseId"])
        }
        "acquire" => {
            contracts::object(value, &["status"], &[])
                && matches!(value["status"].as_str(), Some("busy" | "unknown"))
        }
        "check" => {
            contracts::object(value, &["status"], &[])
                && matches!(value["status"].as_str(), Some("idle" | "busy" | "unknown"))
        }
        _ => false,
    }
}
#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::{
        collections::{HashMap, HashSet},
        ffi::CString,
        fs::{File, OpenOptions},
        io::Read,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{
                ffi::OsStrExt,
                fs::{MetadataExt, OpenOptionsExt},
            },
        },
        path::{Path, PathBuf},
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };
    const MAX_LEASES: usize = 128;
    const MAX_ENTRIES: usize = 65536;
    struct Directory {
        file: File,
        path: PathBuf,
        dev: u64,
        ino: u64,
    }
    impl Directory {
        fn open(path: &Path) -> Result<Self, ()> {
            if !path.is_absolute() || std::fs::canonicalize(path).map_err(|_| ())? != path {
                return Err(());
            }
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(path)
                .map_err(|_| ())?;
            let stat = file.metadata().map_err(|_| ())?;
            Ok(Self {
                file,
                path: path.into(),
                dev: stat.dev(),
                ino: stat.ino(),
            })
        }
        fn task(root: &Self, id: &str) -> Result<Self, ()> {
            let name = CString::new(id).map_err(|_| ())?;
            let fd = unsafe {
                libc::openat(
                    root.file.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(());
            }
            let file = unsafe { File::from_raw_fd(fd) };
            let stat = file.metadata().map_err(|_| ())?;
            let value = Self {
                file,
                path: root.path.join(id),
                dev: stat.dev(),
                ino: stat.ino(),
            };
            value.recheck()?;
            Ok(value)
        }
        fn recheck(&self) -> Result<(), ()> {
            let stat = std::fs::symlink_metadata(&self.path).map_err(|_| ())?;
            let held = self.file.metadata().map_err(|_| ())?;
            if !stat.is_dir()
                || stat.file_type().is_symlink()
                || stat.dev() != self.dev
                || stat.ino() != self.ino
                || held.dev() != self.dev
                || held.ino() != self.ino
                || std::fs::canonicalize(&self.path).map_err(|_| ())? != self.path
            {
                return Err(());
            }
            Ok(())
        }
    }
    struct Ticket {
        task_id: String,
        epoch: String,
        directory: Directory,
    }
    struct State {
        closed: bool,
        tickets: HashMap<String, Arc<Ticket>>,
    }
    pub struct Observer {
        profile: Directory,
        workspace: Directory,
        state: Mutex<State>,
        scan: Mutex<()>,
    }
    impl Observer {
        pub fn open(profile: &Path, workspace: &Path) -> Result<Self, EngineError> {
            let profile =
                Directory::open(profile).map_err(|_| EngineError::new("INVALID_ARGUMENTS"))?;
            let workspace =
                Directory::open(workspace).map_err(|_| EngineError::new("INVALID_ARGUMENTS"))?;
            if !workspace.path.starts_with(&profile.path) || workspace.path == profile.path {
                return Err(EngineError::new("INVALID_ARGUMENTS"));
            }
            Ok(Self {
                profile,
                workspace,
                state: Mutex::new(State {
                    closed: false,
                    tickets: HashMap::new(),
                }),
                scan: Mutex::new(()),
            })
        }
        pub fn close(&self) -> Result<(), EngineError> {
            let mut state = self
                .state
                .lock()
                .map_err(|_| EngineError::new("DISCONNECTED"))?;
            state.closed = true;
            // Accepted raw scans retain their Arc<Ticket> until they settle.
            state.tickets.clear();
            Ok(())
        }
        pub fn observe(&self, value: &Value, epoch: &str) -> Result<Value, EngineError> {
            if !request(value) {
                return Err(EngineError::new("INVALID_ARGUMENTS"));
            }
            // No unbounded queued raw scans. Unknown never authorizes effects.
            let action = value["action"].as_str().unwrap();
            let task = value["taskId"].as_str().unwrap();
            let mut state = self
                .state
                .lock()
                .map_err(|_| EngineError::new("DISCONNECTED"))?;
            if state.closed {
                return Err(EngineError::new("DISCONNECTED"));
            }
            if action == "release" {
                let id = value["leaseId"].as_str().unwrap();
                if let Some(ticket) = state.tickets.get(id) {
                    if ticket.task_id != task || ticket.epoch != epoch {
                        return Err(EngineError::new("INVALID_ARGUMENTS"));
                    }
                }
                // Release remains possible after removal or root replacement.
                state.tickets.remove(id);
                return Ok(json!({"released":true}));
            }
            let _scan = match self.scan.try_lock() {
                Ok(scan) => scan,
                Err(_) => return Ok(json!({"status":"unknown"})),
            };
            let ticket = if action == "acquire" {
                if state.tickets.len() >= MAX_LEASES
                    || state.tickets.values().any(|ticket| ticket.task_id == task)
                {
                    return Ok(json!({"status":"unknown"}));
                }
                let directory = match Directory::task(&self.workspace, task) {
                    Ok(value) => value,
                    Err(_) => return Ok(json!({"status":"unknown"})),
                };
                Arc::new(Ticket {
                    task_id: task.into(),
                    epoch: epoch.into(),
                    directory,
                })
            } else {
                match state.tickets.get(value["leaseId"].as_str().unwrap()) {
                    Some(ticket) if ticket.task_id == task && ticket.epoch == epoch => {
                        ticket.clone()
                    }
                    _ => return Ok(json!({"status":"unknown"})),
                }
            };
            let mut ignored = HashSet::from([
                self.profile.file.as_raw_fd(),
                self.workspace.file.as_raw_fd(),
                ticket.directory.file.as_raw_fd(),
            ]);
            // Retain every ignored FD owner during the scan: concurrent release
            // must not let an unrelated descriptor reuse an ignored number.
            let held_tickets = state.tickets.values().cloned().collect::<Vec<_>>();
            ignored.extend(
                held_tickets
                    .iter()
                    .map(|ticket| ticket.directory.file.as_raw_fd()),
            );
            drop(state);
            let status = if self.profile.recheck().is_err()
                || self.workspace.recheck().is_err()
                || ticket.directory.recheck().is_err()
            {
                "unknown"
            } else {
                observe_proc(&ticket.directory.path, &ignored)
            };
            let mut state = self
                .state
                .lock()
                .map_err(|_| EngineError::new("DISCONNECTED"))?;
            if state.closed {
                return Err(EngineError::new("DISCONNECTED"));
            }
            if action == "check"
                && !state
                    .tickets
                    .get(value["leaseId"].as_str().unwrap())
                    .is_some_and(|held| Arc::ptr_eq(held, &ticket))
            {
                return Ok(json!({"status":"unknown"}));
            }
            if status != "idle"
                || self.profile.recheck().is_err()
                || self.workspace.recheck().is_err()
                || ticket.directory.recheck().is_err()
            {
                return Ok(json!({"status":if status == "busy" { "busy" } else { "unknown" }}));
            }
            if action == "acquire" {
                let id = random_uuid().map_err(|_| EngineError::new("INTERNAL_ERROR"))?;
                state.tickets.insert(id.clone(), ticket);
                Ok(json!({"status":"idle","leaseId":id}))
            } else {
                Ok(json!({"status":"idle"}))
            }
        }
    }
    fn random_uuid() -> Result<String, ()> {
        let mut bytes = [0u8; 16];
        File::open("/dev/urandom")
            .map_err(|_| ())?
            .read_exact(&mut bytes)
            .map_err(|_| ())?;
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        let text = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Ok(format!(
            "{}-{}-{}-{}-{}",
            &text[..8],
            &text[8..12],
            &text[12..16],
            &text[16..20],
            &text[20..]
        ))
    }
    fn bounded_text(path: &Path, maximum: usize) -> Result<String, ()> {
        let mut bytes = Vec::new();
        File::open(path)
            .map_err(|_| ())?
            .take(maximum as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ())?;
        if bytes.len() > maximum {
            return Err(());
        }
        String::from_utf8(bytes).map_err(|_| ())
    }
    fn numeric_entries(path: &Path, count: &mut usize) -> Result<Vec<String>, ()> {
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(path).map_err(|_| ())? {
            let name = entry
                .map_err(|_| ())?
                .file_name()
                .into_string()
                .map_err(|_| ())?;
            if !name.is_empty() && name.bytes().all(|b| b.is_ascii_digit()) {
                *count += 1;
                if *count > MAX_ENTRIES {
                    return Err(());
                }
                entries.push(name);
            }
        }
        entries.sort();
        Ok(entries)
    }
    fn link_busy(path: &Path, workspace: &Path) -> Result<bool, ()> {
        let link = std::fs::read_link(path).map_err(|_| ())?;
        if link.as_os_str().as_bytes().len() > 4096 {
            return Err(());
        }
        if link.is_absolute() {
            return Ok(link.starts_with(workspace));
        }
        let text = link.to_str().ok_or(())?;
        if text.starts_with("socket:[")
            || text.starts_with("pipe:[")
            || text.starts_with("anon_inode:")
        {
            Ok(false)
        } else {
            Err(())
        }
    }
    fn process_busy(
        path: &Path,
        workspace: &Path,
        ignored: &HashSet<i32>,
        count: &mut usize,
        deadline: Instant,
    ) -> Result<bool, ()> {
        let stat = bounded_text(&path.join("stat"), 8192)?;
        let state = stat.rsplit_once(") ").ok_or(())?.1;
        if state.starts_with('Z') || state.starts_with('X') {
            return Ok(false);
        }
        let namespace = std::fs::metadata(path.join("ns/mnt")).map_err(|_| ())?;
        let own_namespace = std::fs::metadata("/proc/self/ns/mnt").map_err(|_| ())?;
        if namespace.dev() != own_namespace.dev() || namespace.ino() != own_namespace.ino() {
            return Err(());
        }
        if link_busy(&path.join("cwd"), workspace)? {
            return Ok(true);
        }
        if link_busy(&path.join("exe"), workspace)? {
            return Ok(true);
        }
        let pid = std::process::id().to_string();
        let own = path
            .strip_prefix("/proc")
            .ok()
            .and_then(|relative| relative.components().next())
            .is_some_and(|id| id.as_os_str() == std::ffi::OsStr::new(&pid));
        let fd_path = path.join("fd");
        // Keep our enumeration descriptor alive until all readlinks settle;
        // otherwise our own /proc fd listing contains a just-closed entry.
        let mut directory = std::fs::read_dir(&fd_path).map_err(|_| ())?;
        let mut fds = Vec::new();
        for entry in directory.by_ref() {
            let name = entry
                .map_err(|_| ())?
                .file_name()
                .into_string()
                .map_err(|_| ())?;
            if name.bytes().all(|b| b.is_ascii_digit()) {
                *count += 1;
                if *count > MAX_ENTRIES {
                    return Err(());
                }
                fds.push(name);
            }
        }
        for fd in fds {
            if Instant::now() >= deadline {
                return Err(());
            }
            if own && fd.parse::<i32>().is_ok_and(|fd| ignored.contains(&fd)) {
                continue;
            }
            if link_busy(&fd_path.join(fd), workspace)? {
                return Ok(true);
            }
        }
        let maps = bounded_text(&path.join("maps"), 4 * 1024 * 1024)?;
        for line in maps.lines() {
            let mut remaining = line;
            for _ in 0..5 {
                remaining = remaining.trim_start();
                if let Some(end) = remaining.find(char::is_whitespace) {
                    remaining = &remaining[end..];
                } else {
                    remaining = "";
                    break;
                }
            }
            let name = remaining.trim_start();
            if name.contains('\\') {
                return Err(());
            }
            if name.starts_with('/') && Path::new(name).starts_with(workspace) {
                return Ok(true);
            }
        }
        let after = bounded_text(&path.join("stat"), 8192)?;
        let identity = |text: &str| {
            text.rsplit_once(") ")
                .and_then(|(_, fields)| fields.split_whitespace().nth(19))
                .map(str::to_owned)
        };
        if identity(&stat).is_none() || identity(&after) != identity(&stat) {
            return Err(());
        }
        Ok(false)
    }
    // Positive evidence can refuse cleanup without completing a namespace
    // census. A missing link here never proves idle: the complete conservative
    // pass below still runs whenever no reference is positively observed.
    fn positive_reference(
        path: &Path,
        workspace: &Path,
        ignored: &HashSet<i32>,
        own: bool,
        count: &mut usize,
        deadline: Instant,
    ) -> bool {
        for name in ["cwd", "exe"] {
            if Instant::now() >= deadline {
                return false;
            }
            if link_busy(&path.join(name), workspace) == Ok(true) {
                return true;
            }
        }
        let mut directory = match std::fs::read_dir(path.join("fd")) {
            Ok(directory) => directory,
            Err(_) => return false,
        };
        // Retain the iterator while visiting links so its own descriptor cannot
        // disappear or be reused halfway through this positive-only probe.
        for entry in directory.by_ref() {
            if Instant::now() >= deadline || *count >= MAX_ENTRIES {
                return false;
            }
            *count += 1;
            let Ok(entry) = entry else { continue };
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Ok(fd) = name.parse::<i32>() else {
                continue;
            };
            if own && ignored.contains(&fd) {
                continue;
            }
            if link_busy(&path.join("fd").join(name), workspace) == Ok(true) {
                return true;
            }
        }
        false
    }
    fn owned_positive_reference(
        workspace: &Path,
        ignored: &HashSet<i32>,
        count: &mut usize,
        deadline: Instant,
    ) -> bool {
        // These process identities come only from the host's own identity and
        // kernel-maintained children lists, never an RPC or caller snapshot.
        let own = Path::new("/proc").join(std::process::id().to_string());
        if positive_reference(&own, workspace, ignored, true, count, deadline) {
            return true;
        }
        let mut pending = vec![own];
        let mut visited = HashSet::new();
        while let Some(parent) = pending.pop() {
            if Instant::now() >= deadline || *count >= MAX_ENTRIES {
                return false;
            }
            if !visited.insert(parent.clone()) {
                continue;
            }
            let Ok(threads) = numeric_entries(&parent.join("task"), count) else {
                continue;
            };
            for thread in threads {
                if Instant::now() >= deadline {
                    return false;
                }
                let Ok(children) =
                    bounded_text(&parent.join("task").join(thread).join("children"), 65536)
                else {
                    continue;
                };
                for child in children.split_whitespace() {
                    if *count >= MAX_ENTRIES || Instant::now() >= deadline {
                        return false;
                    }
                    *count += 1;
                    if child.is_empty() || !child.bytes().all(|byte| byte.is_ascii_digit()) {
                        continue;
                    }
                    let path = Path::new("/proc").join(child);
                    if positive_reference(&path, workspace, ignored, false, count, deadline) {
                        return true;
                    }
                    pending.push(path);
                }
            }
        }
        false
    }
    fn observe_proc(workspace: &Path, ignored: &HashSet<i32>) -> &'static str {
        // Scope: complete currently visible procfs namespace, not hidden host
        // namespaces. Foreign mount namespaces, hidepid, unreadable processes,
        // churn, deadlines and bounds are unknown, never evidence of idle.
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut count = 0;
        if owned_positive_reference(workspace, ignored, &mut count, deadline) {
            return "busy";
        }
        // The positive probe does not waive a single condition for idle. Both
        // passes share the original deadline and entry budget.
        let mounts = match bounded_text(Path::new("/proc/mounts"), 1024 * 1024) {
            Ok(text) => text,
            Err(_) => return "unknown",
        };
        if !mounts.lines().any(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            fields.len() >= 4
                && fields[1] == "/proc"
                && fields[2] == "proc"
                && !fields[3]
                    .split(',')
                    .any(|option| option.starts_with("hidepid=") && option != "hidepid=0")
        }) {
            return "unknown";
        }
        let processes = match numeric_entries(Path::new("/proc"), &mut count) {
            Ok(value) => value,
            Err(_) => return "unknown",
        };
        let mountinfo = match bounded_text(Path::new("/proc/self/mountinfo"), 1024 * 1024) {
            Ok(text) => text,
            Err(_) => return "unknown",
        };
        // A bind/subtree mount can alias a workspace under another path. This
        // narrow owner does not resolve such aliases; refuse idle rather than
        // silently treating lexical path checks as physical mount authority.
        let mut unknown = mountinfo.lines().any(|line| {
            line.split_whitespace()
                .nth(3)
                .is_none_or(|root| root != "/")
        });
        for pid in &processes {
            if Instant::now() >= deadline {
                return "unknown";
            }
            let path = Path::new("/proc").join(pid);
            let threads = match numeric_entries(&path.join("task"), &mut count) {
                Ok(value) => value,
                Err(_) => {
                    unknown = true;
                    continue;
                }
            };
            for thread in &threads {
                let thread_path = path.join("task").join(&thread);
                // The leader's /proc/<pid> spelling identifies our pinned FDs.
                let inspect = if thread == pid {
                    path.clone()
                } else {
                    thread_path
                };
                match process_busy(&inspect, workspace, ignored, &mut count, deadline) {
                    Ok(true) => return "busy",
                    Ok(false) => {}
                    Err(_) => unknown = true,
                }
            }
            if numeric_entries(&path.join("task"), &mut count)
                .ok()
                .as_ref()
                != Some(&threads)
            {
                unknown = true;
            }
        }
        if numeric_entries(Path::new("/proc"), &mut count)
            .ok()
            .as_ref()
            != Some(&processes)
        {
            unknown = true;
        }
        if unknown {
            "unknown"
        } else {
            "idle"
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        use std::process::Stdio;
        use tokio::{
            io::AsyncBufReadExt,
            process::{Child, Command},
            time::timeout,
        };
        struct Fixture {
            root: PathBuf,
            workspace: PathBuf,
        }
        impl Fixture {
            fn new() -> Self {
                let root = std::env::temp_dir()
                    .join(format!("21x-cleanup-observer-{}", random_uuid().unwrap()));
                let workspace = root.join("workspaces");
                std::fs::create_dir_all(workspace.join("task_fixture")).unwrap();
                Self { root, workspace }
            }
            fn owner(&self) -> Observer {
                Observer::open(&self.root, &self.workspace).unwrap()
            }
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.root);
            }
        }
        struct HeldChild(Child);
        impl HeldChild {
            async fn cwd(path: &Path) -> Self {
                let mut child = Command::new("/bin/sh")
                    .args(["-c", "printf 'ready\n'; IFS= read -r finish"])
                    .env_clear()
                    .current_dir(path)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .kill_on_drop(true)
                    .spawn()
                    .unwrap();
                let mut ready = String::new();
                let observed = timeout(
                    Duration::from_secs(2),
                    tokio::io::BufReader::new(child.stdout.take().unwrap()).read_line(&mut ready),
                )
                .await;
                let mut retained = Self(child);
                if !matches!(&observed, Ok(Ok(_))) || ready != "ready\n" {
                    retained.reap().await;
                    assert!(matches!(observed, Ok(Ok(_))), "fixture readiness failed");
                    assert_eq!(ready, "ready\n");
                }
                retained
            }
            async fn reap(&mut self) {
                // Only our retained private shell handle is signalled. No PID
                // lookup, process-tree termination or user workspace is used.
                if self.0.try_wait().unwrap().is_none() {
                    self.0.start_kill().unwrap();
                }
                timeout(Duration::from_secs(2), self.0.wait())
                    .await
                    .unwrap()
                    .unwrap();
            }
        }
        #[tokio::test]
        async fn actual_retained_cwd_process_is_busy_and_reaped_process_is_never_fabricated_idle() {
            let fixture = Fixture::new();
            let owner = fixture.owner();
            let request = json!({"version":1,"action":"acquire","taskId":"task_fixture"});
            let mut child = HeldChild::cwd(&fixture.workspace.join("task_fixture")).await;
            let observed = owner.observe(&request, "epoch");
            let running = child.0.try_wait();
            // Reap before any acceptance assertion can panic. A failed busy
            // observation must not leave cleanup to kill_on_drop alone.
            child.reap().await;
            assert_eq!(observed.unwrap(), json!({"status":"busy"}));
            assert!(running.unwrap().is_none());
            let result = owner.observe(&request, "epoch").unwrap();
            // Full visible-procfs access is a platform assumption, not a fake
            // fixture snapshot. Inaccessible unrelated entries MUST report
            // unknown. An actual idle result alone permits the ticket branch.
            if result["status"] == "idle" {
                assert!(super::super::result("acquire", &result));
                let check = json!({"version":1,"action":"check","taskId":"task_fixture","leaseId":result["leaseId"]});
                let status = owner.observe(&check, "epoch").unwrap();
                assert!(matches!(
                    status["status"].as_str(),
                    Some("idle" | "unknown")
                ));
                std::fs::remove_dir(fixture.workspace.join("task_fixture")).unwrap();
                let release = json!({"version":1,"action":"release","taskId":"task_fixture","leaseId":result["leaseId"]});
                assert_eq!(
                    owner.observe(&release, "epoch").unwrap(),
                    json!({"released":true})
                );
            } else {
                assert_eq!(
                    result,
                    json!({"status":"unknown"}),
                    "unreadable host observations cannot be relabelled idle"
                );
                assert!(owner.state.lock().unwrap().tickets.is_empty());
            }
            owner.close().unwrap();
        }
        #[test]
        fn actual_open_workspace_file_is_busy_even_with_process_cwd_elsewhere() {
            let fixture = Fixture::new();
            let owner = fixture.owner();
            let held = File::create(fixture.workspace.join("task_fixture/held.txt")).unwrap();
            assert_eq!(
                owner
                    .observe(
                        &json!({"version":1,"action":"acquire","taskId":"task_fixture"}),
                        "epoch"
                    )
                    .unwrap(),
                json!({"status":"busy"})
            );
            assert!(held.metadata().unwrap().is_file());
            assert!(owner.state.lock().unwrap().tickets.is_empty());
            drop(held);
            owner.close().unwrap();
        }
        #[test]
        fn captured_root_replacement_and_unknown_ticket_refuse_without_path_grants() {
            let fixture = Fixture::new();
            let owner = fixture.owner();
            std::fs::rename(&fixture.workspace, fixture.root.join("old-workspaces")).unwrap();
            std::fs::create_dir_all(fixture.workspace.join("task_fixture")).unwrap();
            assert_eq!(
                owner
                    .observe(
                        &json!({"version":1,"action":"acquire","taskId":"task_fixture"}),
                        "epoch"
                    )
                    .unwrap(),
                json!({"status":"unknown"})
            );
            assert_eq!(owner.observe(&json!({"version":1,"action":"check","taskId":"task_fixture","leaseId":random_uuid().unwrap()}),"epoch").unwrap(),json!({"status":"unknown"}));
            assert!(owner
                .observe(
                    &json!({"version":1,"action":"acquire","taskId":"../foreign"}),
                    "epoch"
                )
                .is_err());
            owner.close().unwrap();
            assert!(owner
                .observe(
                    &json!({"version":1,"action":"acquire","taskId":"task_fixture"}),
                    "epoch"
                )
                .is_err());
        }
        #[test]
        fn unreadable_observation_is_unknown_and_tickets_retain_physical_ownership_after_close() {
            let fixture = Fixture::new();
            let owner = fixture.owner();
            let ticket = Arc::new(Ticket {
                task_id: "task_fixture".into(),
                epoch: "epoch".into(),
                directory: Directory::task(&owner.workspace, "task_fixture").unwrap(),
            });
            // This test inserts only an internal held-FD lease to exercise raw
            // lifetime/release, NEVER a process-idle observation or public grant.
            let id = random_uuid().unwrap();
            owner
                .state
                .lock()
                .unwrap()
                .tickets
                .insert(id.clone(), ticket.clone());
            assert!(owner
                .observe(
                    &json!({"version":1,"action":"release","taskId":"foreign","leaseId":id}),
                    "epoch"
                )
                .is_err());
            assert_eq!(
                owner
                    .observe(
                        &json!({"version":1,"action":"check","taskId":"task_fixture","leaseId":id}),
                        "foreign-epoch"
                    )
                    .unwrap(),
                json!({"status":"unknown"})
            );
            assert!(process_busy(
                &fixture.root.join("missing-proc-entry"),
                &ticket.directory.path,
                &HashSet::new(),
                &mut 0,
                Instant::now() + Duration::from_secs(1)
            )
            .is_err());
            owner.close().unwrap();
            assert!(owner.state.lock().unwrap().tickets.is_empty());
            ticket.directory.recheck().unwrap();
            assert_eq!(Arc::strong_count(&ticket), 1);
        }
    }
}
#[cfg(target_os = "linux")]
pub use linux::Observer;

#[cfg(test)]
mod codec_tests {
    use super::*;
    #[test]
    fn exact_action_codecs_reject_path_pid_snapshot_and_foreign_versions() {
        let acquire = json!({"version":1,"action":"acquire","taskId":"task_fixture"});
        assert!(request(&acquire));
        for key in ["path", "pid", "snapshot", "leaseId"] {
            let mut injected = acquire.clone();
            injected[key] = json!("caller-grant");
            assert!(!request(&injected));
        }
        let mut version = acquire.clone();
        version["version"] = json!(2);
        assert!(!request(&version));
        let id = "00112233-4455-4677-8899-aabbccddeeff";
        assert!(request(
            &json!({"version":1,"action":"release","taskId":"task_fixture","leaseId":id})
        ));
        assert!(!request(
            &json!({"version":1,"action":"check","taskId":"task_fixture","leaseId":id.to_uppercase()})
        ));
        assert!(result("acquire", &json!({"status":"idle","leaseId":id})));
        assert!(!result("check", &json!({"status":"idle","leaseId":id})));
        assert!(!result("acquire", &json!({"status":"idle"})));
        assert!(!result("release", &json!({"status":"idle"})));
        assert!(result("release", &json!({"released":true})));
    }
}
