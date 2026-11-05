//! Linux crash log and the limit on automatic renderer reloads. An entry is built
//! only from fixed text, a termination reason and a process exit status, so it
//! cannot carry environment, arguments, credentials, prompts or message content.
//! The Node service appends to the same file: src/service/production-crash-log.ts.
use std::{
    fs::{self, OpenOptions, Permissions},
    io::{self, ErrorKind, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const RELOAD_DELAY: Duration = Duration::from_millis(1000);
pub const RELOAD_WINDOW: Duration = Duration::from_secs(60);
/// One full log plus one rotated log is the most this ever keeps on disk.
pub const MAX_LOG_BYTES: u64 = 1024 * 1024;
const LOG_FILE: &str = "crash.log";
const ROTATED_FILE: &str = "crash.log.1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Termination {
    Crashed,
    ExceededMemoryLimit,
    RequestedByApp,
    Unknown,
}
impl Termination {
    fn reason(self) -> &'static str {
        match self {
            Self::Crashed => "crashed",
            Self::ExceededMemoryLimit => "exceeded-memory-limit",
            Self::RequestedByApp => "requested-by-app",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recovery {
    Reload,
    Suppressed,
    Ignored,
}
impl Recovery {
    fn action(self) -> &'static str {
        match self {
            Self::Reload => "reload",
            Self::Suppressed => "none, already reloaded within 60 seconds; use View > Reload",
            Self::Ignored => "none, the app ended it",
        }
    }
}

/// At most one automatic reload in RELOAD_WINDOW, so a page that crashes as it
/// loads does not loop.
#[derive(Default)]
pub struct RecoveryLimit {
    last: Option<Instant>,
}
impl RecoveryLimit {
    pub fn decide(&mut self, termination: Termination, now: Instant) -> Recovery {
        if termination == Termination::RequestedByApp {
            return Recovery::Ignored;
        }
        if self
            .last
            .is_some_and(|last| now.duration_since(last) < RELOAD_WINDOW)
        {
            return Recovery::Suppressed;
        }
        self.last = Some(now);
        Recovery::Reload
    }
}

#[derive(Clone, Debug)]
pub struct CrashLog {
    directory: PathBuf,
}
impl CrashLog {
    /// Always the Tauri profile root, never the Electron one a profile may share.
    pub fn new(profile_root: &Path) -> Self {
        Self {
            directory: profile_root.join("logs"),
        }
    }
    pub fn session_started(&self, version: &str) {
        let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
        self.append(&format!(
            "\n{}\n21x v{version} — Session started {}\nPlatform: {os} {arch}\n",
            "═".repeat(60),
            timestamp(),
        ));
    }
    pub fn renderer_terminated(&self, termination: Termination, recovery: Recovery) {
        self.entry(
            "renderer-terminated",
            &format!(
                "reason={}\naction={}",
                termination.reason(),
                recovery.action()
            ),
        );
    }
    /// `code` is a fixed engine error code.
    pub fn renderer_reload_failed(&self, code: &str) {
        self.entry("renderer-reload-failed", &format!("code={code}"));
    }
    /// `status` is the process exit status, as std formats it.
    pub fn service_ended(&self, status: &str) {
        self.entry("service-ended", &format!("status={status}"));
    }
    fn entry(&self, kind: &str, detail: &str) {
        self.append(&format!(
            "\n{}\n[{}] {kind}\n{detail}\n",
            "─".repeat(60),
            timestamp(),
        ));
    }
    /// A crash log must never add a failure of its own.
    fn append(&self, entry: &str) {
        let _ = write_entry(&self.directory, entry.as_bytes());
    }
}

fn private_directory(path: &Path) -> io::Result<()> {
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Err(error) if error.kind() != ErrorKind::AlreadyExists => return Err(error),
        _ => {}
    }
    // symlink_metadata reports a link as a link, so a planted one is refused.
    if !fs::symlink_metadata(path)?.is_dir() {
        return Err(io::Error::other("not a private directory"));
    }
    fs::set_permissions(path, Permissions::from_mode(0o700))
}

/// Two writers can rotate at once. The cost is losing the older rotated entries;
/// neither file can pass the bound.
fn write_entry(directory: &Path, entry: &[u8]) -> io::Result<()> {
    private_directory(directory)?;
    let path = directory.join(LOG_FILE);
    match fs::symlink_metadata(&path) {
        Ok(metadata)
            if metadata.is_file() && metadata.len() + entry.len() as u64 > MAX_LOG_BYTES =>
        {
            fs::rename(&path, directory.join(ROTATED_FILE))?;
        }
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(io::Error::other("not a private file"));
    }
    file.set_permissions(Permissions::from_mode(0o600))?;
    file.write_all(entry)
}

fn timestamp() -> String {
    iso_timestamp(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default(),
    )
}
/// The same text as JavaScript's toISOString, without a date crate. This is
/// Howard Hinnant's civil_from_days.
fn iso_timestamp(since_epoch: Duration) -> String {
    let seconds = since_epoch.as_secs();
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    let shifted = days as i64 + 719_468;
    let era = shifted / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60,
        since_epoch.subsec_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temporary(PathBuf);
    impl Temporary {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "21x-crash-{name}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temporary {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn one_automatic_reload_in_sixty_seconds_and_a_second_crash_does_not_loop() {
        let start = Instant::now();
        let mut limit = RecoveryLimit::default();
        assert_eq!(limit.decide(Termination::Crashed, start), Recovery::Reload);
        assert_eq!(
            limit.decide(Termination::Crashed, start + Duration::from_secs(1)),
            Recovery::Suppressed
        );
        assert_eq!(
            limit.decide(Termination::Unknown, start + Duration::from_secs(59)),
            Recovery::Suppressed
        );
        assert_eq!(
            limit.decide(Termination::ExceededMemoryLimit, start + RELOAD_WINDOW),
            Recovery::Reload
        );
    }
    #[test]
    fn a_termination_the_app_caused_is_ignored_and_spends_no_reload() {
        let start = Instant::now();
        let mut limit = RecoveryLimit::default();
        assert_eq!(
            limit.decide(Termination::RequestedByApp, start),
            Recovery::Ignored
        );
        assert_eq!(limit.decide(Termination::Crashed, start), Recovery::Reload);
        assert_eq!(
            limit.decide(Termination::RequestedByApp, start),
            Recovery::Ignored
        );
    }
    #[test]
    fn entries_name_the_kind_and_reason_in_an_owner_only_log() {
        let root = Temporary::new("entries");
        let log = CrashLog::new(&root.0);
        log.renderer_terminated(Termination::Crashed, Recovery::Reload);
        log.renderer_terminated(Termination::ExceededMemoryLimit, Recovery::Suppressed);
        log.renderer_reload_failed("UNAUTHORIZED");
        log.service_ended("signal: 9 (SIGKILL)");
        let file = root.0.join("logs").join(LOG_FILE);
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.contains("] renderer-terminated\nreason=crashed\naction=reload\n"));
        assert!(text.contains("reason=exceeded-memory-limit\naction=none, already reloaded"));
        assert!(text.contains("] renderer-reload-failed\ncode=UNAUTHORIZED\n"));
        assert!(text.contains("] service-ended\nstatus=signal: 9 (SIGKILL)\n"));
        assert_eq!(mode(&file), 0o600);
        assert_eq!(mode(&root.0.join("logs")), 0o700);
    }
    #[test]
    fn existing_wide_modes_are_tightened() {
        let root = Temporary::new("modes");
        let directory = root.0.join("logs");
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, Permissions::from_mode(0o755)).unwrap();
        fs::write(directory.join(LOG_FILE), "old").unwrap();
        fs::set_permissions(directory.join(LOG_FILE), Permissions::from_mode(0o644)).unwrap();
        CrashLog::new(&root.0).service_ended("exit status: 1");
        assert_eq!(mode(&directory), 0o700);
        assert_eq!(mode(&directory.join(LOG_FILE)), 0o600);
    }
    #[test]
    fn the_log_rotates_and_never_passes_its_bound() {
        let root = Temporary::new("rotate");
        let directory = root.0.join("logs");
        let log = CrashLog::new(&root.0);
        log.service_ended("exit status: 1");
        let first = fs::read_to_string(directory.join(LOG_FILE)).unwrap();
        fs::write(
            directory.join(LOG_FILE),
            vec![b'x'; MAX_LOG_BYTES as usize - 1],
        )
        .unwrap();
        log.service_ended("exit status: 2");
        assert_eq!(
            fs::metadata(directory.join(ROTATED_FILE)).unwrap().len(),
            MAX_LOG_BYTES - 1
        );
        let current = fs::read_to_string(directory.join(LOG_FILE)).unwrap();
        assert!(current.contains("status=exit status: 2"));
        assert_eq!(current.len(), first.len());
        fs::write(directory.join(LOG_FILE), vec![b'y'; MAX_LOG_BYTES as usize]).unwrap();
        log.service_ended("exit status: 3");
        // The older rotated file is replaced, not kept beside it.
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 2);
        assert_eq!(
            fs::metadata(directory.join(ROTATED_FILE)).unwrap().len(),
            MAX_LOG_BYTES
        );
    }
    #[test]
    fn planted_links_are_not_followed_and_failures_stay_silent() {
        let root = Temporary::new("links");
        let elsewhere = root.0.join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        let linked = root.0.join("linked-directory");
        fs::create_dir(&linked).unwrap();
        std::os::unix::fs::symlink(&elsewhere, linked.join("logs")).unwrap();
        CrashLog::new(&linked).service_ended("exit status: 1");
        assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);

        let target = root.0.join("target");
        fs::write(&target, "untouched").unwrap();
        let file = root.0.join("linked-file");
        fs::create_dir_all(file.join("logs")).unwrap();
        std::os::unix::fs::symlink(&target, file.join("logs").join(LOG_FILE)).unwrap();
        CrashLog::new(&file).service_ended("exit status: 1");
        assert_eq!(fs::read_to_string(&target).unwrap(), "untouched");

        let blocked = root.0.join("blocked");
        fs::create_dir(&blocked).unwrap();
        fs::write(blocked.join("logs"), "a file where the folder goes").unwrap();
        CrashLog::new(&blocked).session_started("0.0.0");
        assert_eq!(
            fs::read_to_string(blocked.join("logs")).unwrap(),
            "a file where the folder goes"
        );
    }
    #[test]
    fn timestamps_match_javascript() {
        assert_eq!(iso_timestamp(Duration::ZERO), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_timestamp(Duration::new(1_709_251_199, 0)),
            "2024-02-29T23:59:59.000Z"
        );
        assert_eq!(
            iso_timestamp(Duration::new(1_793_898_836, 207_000_000)),
            "2026-11-05T17:13:56.207Z"
        );
    }
}
