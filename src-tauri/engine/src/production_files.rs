//! Trusted workspace descriptor ownership. Receipts describe observations, not grants.
use crate::EngineError;
use serde_json::Value;
use std::path::{Path, PathBuf};

const MAX_PATH_BYTES: usize = 4096;
const MAX_DEPTH: usize = 64;
fn failure(code: &'static str) -> EngineError {
    EngineError {
        code,
        message: match code {
            "WORKSPACE_INVALID_ARGUMENTS" => "Invalid workspace file receipt.",
            "WORKSPACE_PATH_CHANGED" => "The workspace file identity changed.",
            "WORKSPACE_NATIVE_UNAVAILABLE" => {
                "Native workspace file authority is unavailable on this platform."
            }
            _ => "The workspace path is unavailable or refused.",
        },
        startup_phase: None,
    }
}
fn exact(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|m| m.len() == keys.len() && keys.iter().all(|k| m.contains_key(*k)))
}
fn canonical_path(s: &str) -> bool {
    // Literal normalized Unix absolute paths; no alias, empty component or control bytes.
    s.len() <= MAX_PATH_BYTES
        && s.starts_with('/')
        && !s.chars().any(|c| c <= '\u{001f}' || c == '\u{007f}')
        && (s == "/"
            || (!s.ends_with('/')
                && s[1..]
                    .split('/')
                    .all(|p| !p.is_empty() && p != "." && p != "..")))
}
fn path_value(v: &Value) -> Result<PathBuf, EngineError> {
    v.as_str()
        .filter(|s| canonical_path(s))
        .map(PathBuf::from)
        .ok_or_else(|| failure("WORKSPACE_INVALID_ARGUMENTS"))
}
fn decimal(v: &Value) -> Result<u64, EngineError> {
    let s = v
        .as_str()
        .ok_or_else(|| failure("WORKSPACE_INVALID_ARGUMENTS"))?;
    if s.is_empty()
        || s.len() > 20
        || (s.len() > 1 && s.starts_with('0'))
        || !s.bytes().all(|c| c.is_ascii_digit())
    {
        return Err(failure("WORKSPACE_INVALID_ARGUMENTS"));
    }
    s.parse()
        .map_err(|_| failure("WORKSPACE_INVALID_ARGUMENTS"))
}
#[derive(Clone, Debug, PartialEq, Eq)]
enum Kind {
    File,
    Directory,
}
#[derive(Clone, Debug)]
struct Identity {
    path: PathBuf,
    dev: u64,
    ino: u64,
    kind: Kind,
    size: u64,
    nlink: u64,
}
impl Identity {
    fn from_value(v: &Value) -> Result<Self, EngineError> {
        if !exact(v, &["path", "dev", "ino", "kind", "size", "nlink"]) {
            return Err(failure("WORKSPACE_INVALID_ARGUMENTS"));
        }
        let kind = match v["kind"].as_str() {
            Some("directory") => Kind::Directory,
            Some("file") => Kind::File,
            _ => return Err(failure("WORKSPACE_INVALID_ARGUMENTS")),
        };
        let result = Self {
            path: path_value(&v["path"])?,
            dev: decimal(&v["dev"])?,
            ino: decimal(&v["ino"])?,
            kind,
            size: decimal(&v["size"])?,
            nlink: decimal(&v["nlink"])?,
        };
        if result.nlink == 0 || (result.kind == Kind::File && result.nlink != 1) {
            return Err(failure("WORKSPACE_INVALID_ARGUMENTS"));
        }
        Ok(result)
    }
    #[cfg(target_os = "linux")]
    fn matches(&self, metadata: &std::fs::Metadata) -> bool {
        use std::os::unix::fs::MetadataExt;
        metadata.dev() == self.dev
            && metadata.ino() == self.ino
            && match self.kind {
                Kind::Directory => metadata.is_dir(),
                Kind::File => {
                    metadata.is_file() && metadata.size() == self.size && metadata.nlink() == 1
                }
            }
    }
}
/// Strictly decoded, immutable receipt. Construction never touches the filesystem.
#[derive(Clone, Debug)]
pub struct NativeWorkspaceReceipt {
    task_id: String,
    workspace_root: PathBuf,
    path: PathBuf,
    root: Identity,
    ancestors: Vec<Identity>,
    target: Identity,
}
impl NativeWorkspaceReceipt {
    pub fn from_value(v: &Value) -> Result<Self, EngineError> {
        if v.to_string().len() > 300_000 {
            return Err(failure("WORKSPACE_INVALID_ARGUMENTS"));
        }
        if !exact(
            v,
            &[
                "version",
                "taskId",
                "workspaceRoot",
                "path",
                "root",
                "ancestors",
                "target",
            ],
        ) || v["version"].as_u64() != Some(1)
        {
            return Err(failure("WORKSPACE_INVALID_ARGUMENTS"));
        }
        let task = v["taskId"]
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 128
                    && s.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            })
            .ok_or_else(|| failure("WORKSPACE_INVALID_ARGUMENTS"))?;
        let ancestors = v["ancestors"]
            .as_array()
            .filter(|rows| rows.len() <= MAX_DEPTH)
            .ok_or_else(|| failure("WORKSPACE_INVALID_ARGUMENTS"))?
            .iter()
            .map(Identity::from_value)
            .collect::<Result<Vec<_>, _>>()?;
        let result = Self {
            task_id: task.to_owned(),
            workspace_root: path_value(&v["workspaceRoot"])?,
            path: path_value(&v["path"])?,
            root: Identity::from_value(&v["root"])?,
            ancestors,
            target: Identity::from_value(&v["target"])?,
        };
        if result.workspace_root.components().count() > MAX_DEPTH
            || result.root.path != result.workspace_root
            || result.root.kind != Kind::Directory
            || result.target.path != result.path
        {
            return Err(failure("WORKSPACE_INVALID_ARGUMENTS"));
        }
        let relative = result
            .path
            .strip_prefix(&result.workspace_root)
            .map_err(|_| failure("WORKSPACE_INVALID_ARGUMENTS"))?;
        let parts: Vec<_> = relative.components().collect();
        if parts.is_empty()
            || parts.len() > MAX_DEPTH + 1
            || parts[0].as_os_str() != std::ffi::OsStr::new(&result.task_id)
            || result.ancestors.len() != parts.len() - 1
        {
            return Err(failure("WORKSPACE_INVALID_ARGUMENTS"));
        }
        let mut path = result.workspace_root.clone();
        for (part, identity) in parts.iter().zip(result.ancestors.iter()) {
            path.push(part.as_os_str());
            if identity.path != path || identity.kind != Kind::Directory {
                return Err(failure("WORKSPACE_INVALID_ARGUMENTS"));
            }
        }
        if parts.len() == 1 && result.target.kind != Kind::Directory {
            return Err(failure("WORKSPACE_INVALID_ARGUMENTS"));
        }
        Ok(result)
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::{
        ffi::CString,
        fs::File,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{ffi::OsStrExt, fs::MetadataExt},
        },
        sync::Arc,
    };
    struct Held {
        file: File,
        identity: Identity,
    }
    fn descriptor(
        parent: Option<&File>,
        name: &Path,
        directory: bool,
    ) -> Result<File, EngineError> {
        let name = CString::new(name.as_os_str().as_bytes())
            .map_err(|_| failure("WORKSPACE_PATH_REFUSED"))?;
        // O_PATH performs no data read and does not activate a substituted device/FIFO.
        let flags = libc::O_PATH
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | libc::O_NONBLOCK
            | if directory { libc::O_DIRECTORY } else { 0 };
        let fd = unsafe {
            libc::openat(
                parent.map_or(libc::AT_FDCWD, AsRawFd::as_raw_fd),
                name.as_ptr(),
                flags,
            )
        };
        if fd < 0 {
            return Err(failure("WORKSPACE_PATH_REFUSED"));
        }
        // This exclusively owns the descriptor returned by successful openat.
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    fn metadata(file: &File) -> Result<std::fs::Metadata, EngineError> {
        file.metadata()
            .map_err(|_| failure("WORKSPACE_PATH_REFUSED"))
    }
    fn captured(path: PathBuf, file: File) -> Result<Held, EngineError> {
        let m = metadata(&file)?;
        if !m.is_dir() {
            return Err(failure("WORKSPACE_PATH_REFUSED"));
        }
        Ok(Held {
            identity: Identity {
                path,
                dev: m.dev(),
                ino: m.ino(),
                kind: Kind::Directory,
                size: m.size(),
                nlink: m.nlink(),
            },
            file,
        })
    }
    struct Owner {
        root: PathBuf,
        chain: Vec<Held>,
    }
    impl Owner {
        fn recheck(&self) -> Result<(), EngineError> {
            let mut fresh: Option<File> = None;
            for held in &self.chain {
                if !held.identity.matches(&metadata(&held.file)?) {
                    return Err(failure("WORKSPACE_PATH_CHANGED"));
                }
                let name = if fresh.is_none() {
                    Path::new("/")
                } else {
                    Path::new(
                        held.identity
                            .path
                            .file_name()
                            .ok_or_else(|| failure("WORKSPACE_PATH_CHANGED"))?,
                    )
                };
                let next = descriptor(fresh.as_ref(), name, true)
                    .map_err(|_| failure("WORKSPACE_PATH_CHANGED"))?;
                if !held.identity.matches(&metadata(&next)?) {
                    return Err(failure("WORKSPACE_PATH_CHANGED"));
                }
                fresh = Some(next);
            }
            Ok(())
        }
    }
    /// Captures a trusted root and every absolute ancestor before any receipt exists.
    pub struct NativeWorkspaceFileOwner {
        owner: Arc<Owner>,
    }
    impl NativeWorkspaceFileOwner {
        pub fn open(root: PathBuf) -> Result<Self, EngineError> {
            if !root.to_str().is_some_and(canonical_path) || root.components().count() > MAX_DEPTH {
                return Err(failure("WORKSPACE_INVALID_ARGUMENTS"));
            }
            let mut chain = vec![captured(
                PathBuf::from("/"),
                descriptor(None, Path::new("/"), true)?,
            )?];
            let mut path = PathBuf::from("/");
            for component in root.components().skip(1) {
                path.push(component.as_os_str());
                let file = descriptor(
                    Some(&chain.last().unwrap().file),
                    Path::new(component.as_os_str()),
                    true,
                )?;
                chain.push(captured(path.clone(), file)?);
            }
            let owner = Arc::new(Owner { root, chain });
            owner.recheck()?;
            Ok(Self { owner })
        }
        pub(crate) fn into_pinned_directory(self) -> NativePinnedDirectory {
            NativePinnedDirectory { owner: self.owner }
        }
        pub fn validate(
            &self,
            receipt: &NativeWorkspaceReceipt,
        ) -> Result<NativeWorkspaceFileGuard, EngineError> {
            self.owner.recheck()?;
            if receipt.workspace_root != self.owner.root
                || !receipt
                    .root
                    .matches(&metadata(&self.owner.chain.last().unwrap().file)?)
            {
                return Err(failure("WORKSPACE_PATH_CHANGED"));
            }
            let mut chain: Vec<Held> = Vec::new();
            for expected in receipt
                .ancestors
                .iter()
                .chain(std::iter::once(&receipt.target))
            {
                let parent = chain
                    .last()
                    .map(|h| &h.file)
                    .unwrap_or(&self.owner.chain.last().unwrap().file);
                let name = Path::new(
                    expected
                        .path
                        .file_name()
                        .ok_or_else(|| failure("WORKSPACE_PATH_REFUSED"))?,
                );
                let file = descriptor(Some(parent), name, expected.kind == Kind::Directory)?;
                if !expected.matches(&metadata(&file)?) {
                    return Err(failure("WORKSPACE_PATH_CHANGED"));
                }
                chain.push(Held {
                    file,
                    identity: expected.clone(),
                });
            }
            let guard = NativeWorkspaceFileGuard {
                owner: Arc::clone(&self.owner),
                receipt: receipt.clone(),
                chain,
            };
            guard.recheck()?;
            Ok(guard)
        }
    }
    /// Internal native save-target parent capability; no RPC obtains a raw FD.
    pub(crate) struct NativePinnedDirectory {
        owner: Arc<Owner>,
    }
    impl NativePinnedDirectory {
        pub(crate) fn raw_fd(&self) -> std::os::fd::RawFd {
            self.owner.chain.last().unwrap().file.as_raw_fd()
        }
        pub(crate) fn recheck(&self) -> Result<(), EngineError> {
            self.owner.recheck()
        }
    }
    pub struct NativePinnedFileReader {
        file: File,
        guard: NativeWorkspaceFileGuard,
        expected: std::fs::Metadata,
        read: u64,
    }
    impl NativePinnedFileReader {
        pub fn recheck(&self) -> Result<(), EngineError> {
            self.guard.recheck()?;
            let now = metadata(&self.file)?;
            if !now.is_file()
                || now.nlink() != 1
                || now.dev() != self.expected.dev()
                || now.ino() != self.expected.ino()
                || now.size() != self.expected.size()
                || now.mtime() != self.expected.mtime()
                || now.mtime_nsec() != self.expected.mtime_nsec()
                || now.ctime() != self.expected.ctime()
                || now.ctime_nsec() != self.expected.ctime_nsec()
            {
                return Err(failure("WORKSPACE_PATH_CHANGED"));
            }
            Ok(())
        }
        pub fn size(&self) -> u64 {
            self.expected.size()
        }
        pub fn read_chunk(&mut self, buffer: &mut [u8]) -> Result<usize, EngineError> {
            use std::io::Read;
            self.recheck()?;
            let count = self
                .file
                .read(buffer)
                .map_err(|_| failure("WORKSPACE_PATH_REFUSED"))?;
            self.read = self
                .read
                .checked_add(count as u64)
                .filter(|total| *total <= self.expected.size())
                .ok_or_else(|| failure("WORKSPACE_PATH_CHANGED"))?;
            self.recheck()?;
            Ok(count)
        }
        pub fn finish(&self) -> Result<(), EngineError> {
            self.recheck()?;
            if self.read != self.expected.size() {
                return Err(failure("WORKSPACE_PATH_CHANGED"));
            }
            Ok(())
        }
    }
    /// Holds exact owner/root, task ancestor and target descriptors through an OS call.
    pub struct NativeWorkspaceFileGuard {
        owner: Arc<Owner>,
        receipt: NativeWorkspaceReceipt,
        chain: Vec<Held>,
    }
    impl NativeWorkspaceFileGuard {
        pub fn open_pinned_reader(
            self,
            max_bytes: u64,
        ) -> Result<NativePinnedFileReader, EngineError> {
            use std::os::unix::fs::OpenOptionsExt;
            self.recheck()?;
            let held = self
                .chain
                .last()
                .ok_or_else(|| failure("WORKSPACE_PATH_REFUSED"))?;
            let expected = metadata(&held.file)?;
            if !expected.is_file() || expected.nlink() != 1 || expected.size() > max_bytes {
                return Err(failure("WORKSPACE_PATH_REFUSED"));
            }
            // Keep the O_PATH handle alive while opening its own kernel FD link.
            // Never resolve an attacker-controlled source pathname for reading.
            let file = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_CLOEXEC | libc::O_NONBLOCK)
                .open(format!("/proc/self/fd/{}", held.file.as_raw_fd()))
                .map_err(|_| failure("WORKSPACE_PATH_REFUSED"))?;
            let result = NativePinnedFileReader {
                file,
                guard: self,
                expected,
                read: 0,
            };
            result.recheck()?;
            Ok(result)
        }
        pub fn path(&self) -> &Path {
            &self.receipt.path
        }
        pub fn recheck(&self) -> Result<(), EngineError> {
            self.owner.recheck()?;
            if !self
                .receipt
                .root
                .matches(&metadata(&self.owner.chain.last().unwrap().file)?)
            {
                return Err(failure("WORKSPACE_PATH_CHANGED"));
            }
            let mut fresh: Option<File> = None;
            for held in &self.chain {
                if !held.identity.matches(&metadata(&held.file)?) {
                    return Err(failure("WORKSPACE_PATH_CHANGED"));
                }
                let parent = fresh
                    .as_ref()
                    .unwrap_or(&self.owner.chain.last().unwrap().file);
                let name = Path::new(
                    held.identity
                        .path
                        .file_name()
                        .ok_or_else(|| failure("WORKSPACE_PATH_CHANGED"))?,
                );
                let next = descriptor(Some(parent), name, held.identity.kind == Kind::Directory)
                    .map_err(|_| failure("WORKSPACE_PATH_CHANGED"))?;
                if !held.identity.matches(&metadata(&next)?) {
                    return Err(failure("WORKSPACE_PATH_CHANGED"));
                }
                fresh = Some(next);
            }
            // A last root walk detects replacement while resolving the target chain.
            self.owner.recheck()
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;
        use std::{
            fs,
            os::unix::fs::symlink,
            sync::atomic::{AtomicU64, Ordering},
        };
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        struct Fixture {
            base: PathBuf,
            root: PathBuf,
            task: PathBuf,
            nested: PathBuf,
            file: PathBuf,
        }
        impl Fixture {
            fn new() -> Self {
                let base = std::env::temp_dir().join(format!(
                    "21x-native-files-{}-{}",
                    std::process::id(),
                    SEQUENCE.fetch_add(1, Ordering::Relaxed)
                ));
                fs::create_dir(&base).unwrap();
                let base = fs::canonicalize(base).unwrap();
                let root = base.join("workspaces");
                let task = root.join("task_1");
                let nested = task.join("nested");
                let file = nested.join("public.txt");
                fs::create_dir_all(&nested).unwrap();
                fs::write(&file, b"public content").unwrap();
                fs::write(base.join("unrelated.txt"), b"untouched").unwrap();
                Self {
                    base,
                    root,
                    task,
                    nested,
                    file,
                }
            }
            fn identity(path: &Path) -> Value {
                let m = fs::symlink_metadata(path).unwrap();
                json!({"path":path.to_str().unwrap(),"dev":m.dev().to_string(),"ino":m.ino().to_string(),"kind":if m.is_dir(){"directory"}else{"file"},"size":m.size().to_string(),"nlink":m.nlink().to_string()})
            }
            fn receipt(&self, target: &Path) -> Value {
                let mut paths = Vec::new();
                let mut next = target.parent().unwrap();
                while next != self.root {
                    paths.push(next.to_path_buf());
                    next = next.parent().unwrap();
                }
                paths.reverse();
                json!({"version":1,"taskId":"task_1","workspaceRoot":self.root.to_str().unwrap(),"path":target.to_str().unwrap(),"root":Self::identity(&self.root),"ancestors":paths.iter().map(|p|Self::identity(p)).collect::<Vec<_>>(),"target":Self::identity(target)})
            }
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.base);
            }
        }
        fn decoded(v: &Value) -> NativeWorkspaceReceipt {
            NativeWorkspaceReceipt::from_value(v).unwrap()
        }
        fn code<T>(result: Result<T, EngineError>) -> &'static str {
            match result {
                Ok(_) => panic!("unexpected accepted path"),
                Err(e) => {
                    assert!(!e.message.contains('/'));
                    e.code
                }
            }
        }
        #[test]
        fn retains_actual_metadata_only_root_and_target_handles_without_reading() {
            let f = Fixture::new();
            let owner = NativeWorkspaceFileOwner::open(f.root.clone()).unwrap();
            let receipt = decoded(&f.receipt(&f.file));
            let guard = owner.validate(&receipt).unwrap();
            assert_eq!(guard.path(), f.file);
            guard.recheck().unwrap();
            assert_eq!(guard.chain.len(), 3);
            assert!(guard.owner.chain.len() >= 3);
            for h in guard.owner.chain.iter().chain(guard.chain.iter()) {
                let flags = unsafe { libc::fcntl(h.file.as_raw_fd(), libc::F_GETFL) };
                assert_ne!(flags & libc::O_PATH, 0);
                assert_ne!(flags & libc::O_NOFOLLOW, 0);
                // O_PATH ignores ordinary open flags, including O_NONBLOCK; it cannot read or block on device/FIFO data.
                assert_ne!(
                    unsafe { libc::fcntl(h.file.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
                    0
                );
            }
            let mut byte = 0u8;
            assert_eq!(
                unsafe {
                    libc::read(
                        guard.chain.last().unwrap().file.as_raw_fd(),
                        (&mut byte as *mut u8).cast(),
                        1,
                    )
                },
                -1
            );
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::EBADF)
            );
            drop(owner);
            guard.recheck().unwrap(); // guard retains the actual trusted owner.
            assert_eq!(
                fs::read(f.base.join("unrelated.txt")).unwrap(),
                b"untouched"
            );
        }
        #[test]
        fn task_directory_and_harmless_directory_content_changes_remain_valid() {
            let f = Fixture::new();
            let owner = NativeWorkspaceFileOwner::open(f.root.clone()).unwrap();
            let task_receipt = decoded(&f.receipt(&f.task));
            assert!(task_receipt.ancestors.is_empty());
            let task_guard = owner.validate(&task_receipt).unwrap();
            let mut value = f.receipt(&f.file);
            value["root"]["size"] = json!("0");
            value["root"]["nlink"] = json!("999");
            value["ancestors"][0]["size"] = json!("0");
            value["ancestors"][0]["nlink"] = json!("999");
            let guard = owner.validate(&decoded(&value)).unwrap();
            fs::write(f.task.join("later.txt"), b"later work").unwrap();
            fs::create_dir(f.nested.join("new-dir")).unwrap();
            guard.recheck().unwrap();
            task_guard.recheck().unwrap();
            owner.validate(&task_receipt).unwrap();
        }
        #[test]
        fn rejects_root_and_absolute_ancestor_replacement_even_with_new_receipt() {
            let f = Fixture::new();
            let owner = NativeWorkspaceFileOwner::open(f.root.clone()).unwrap();
            let guard = owner.validate(&decoded(&f.receipt(&f.file))).unwrap();
            let moved = f.base.join("old-workspaces");
            fs::rename(&f.root, &moved).unwrap();
            fs::create_dir_all(&f.nested).unwrap();
            fs::write(&f.file, b"private replacement").unwrap();
            assert_eq!(code(guard.recheck()), "WORKSPACE_PATH_CHANGED");
            assert_eq!(
                code(owner.validate(&decoded(&f.receipt(&f.file)))),
                "WORKSPACE_PATH_CHANGED"
            );
            fs::remove_dir_all(&f.root).unwrap();
            fs::rename(&moved, &f.root).unwrap();
            guard.recheck().unwrap();
            // Replace the absolute parent above the trusted root; retained root FD still exists.
            let old_base = f.base.with_extension("old");
            fs::rename(&f.base, &old_base).unwrap();
            fs::create_dir(&f.base).unwrap();
            assert_eq!(code(guard.recheck()), "WORKSPACE_PATH_CHANGED");
            fs::remove_dir(&f.base).unwrap();
            fs::rename(old_base, &f.base).unwrap();
            guard.recheck().unwrap();
        }
        #[test]
        fn rejects_task_ancestor_and_target_replacement_and_changed_file_size() {
            let f = Fixture::new();
            let owner = NativeWorkspaceFileOwner::open(f.root.clone()).unwrap();
            let receipt = decoded(&f.receipt(&f.file));
            let guard = owner.validate(&receipt).unwrap();
            fs::write(&f.file, b"longer modified content").unwrap();
            assert_eq!(code(guard.recheck()), "WORKSPACE_PATH_CHANGED");
            assert_eq!(code(owner.validate(&receipt)), "WORKSPACE_PATH_CHANGED");
            fs::write(&f.file, b"public content").unwrap();
            let receipt = decoded(&f.receipt(&f.file));
            let guard = owner.validate(&receipt).unwrap();
            let original = f.nested.join("original.txt");
            fs::rename(&f.file, &original).unwrap();
            fs::write(&f.file, b"public content").unwrap();
            assert_eq!(code(guard.recheck()), "WORKSPACE_PATH_CHANGED");
            assert_eq!(code(owner.validate(&receipt)), "WORKSPACE_PATH_CHANGED");
            fs::remove_file(&f.file).unwrap();
            fs::rename(original, &f.file).unwrap();
            guard.recheck().unwrap();
            let old_task = f.root.join("old-task");
            fs::rename(&f.task, &old_task).unwrap();
            fs::create_dir_all(&f.nested).unwrap();
            fs::write(&f.file, b"public content").unwrap();
            assert_eq!(code(guard.recheck()), "WORKSPACE_PATH_CHANGED");
            assert!(owner.validate(&receipt).is_err());
        }
        #[test]
        fn refuses_aliases_regular_file_ancestors_hardlinks_and_nonblocking_fifo() {
            let f = Fixture::new();
            let owner = NativeWorkspaceFileOwner::open(f.root.clone()).unwrap();
            let receipt = decoded(&f.receipt(&f.file));
            let original = f.nested.join("original.txt");
            fs::rename(&f.file, &original).unwrap();
            symlink(f.base.join("unrelated.txt"), &f.file).unwrap();
            assert!(owner.validate(&receipt).is_err());
            fs::remove_file(&f.file).unwrap();
            fs::hard_link(&original, &f.file).unwrap();
            let mut hardlink = f.receipt(&f.file);
            assert!(NativeWorkspaceReceipt::from_value(&hardlink).is_err());
            hardlink["target"]["nlink"] = json!("1");
            assert!(owner.validate(&decoded(&hardlink)).is_err());
            fs::remove_file(&f.file).unwrap();
            let name = CString::new(f.file.as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            let mut fifo = f.receipt(&f.file);
            fifo["target"]["nlink"] = json!("1");
            let started = std::time::Instant::now();
            assert!(owner.validate(&decoded(&fifo)).is_err());
            assert!(started.elapsed() < std::time::Duration::from_secs(2));
            fs::remove_file(&f.file).unwrap();
            fs::rename(original, &f.file).unwrap();
            let old_nested = f.task.join("old-nested");
            fs::rename(&f.nested, &old_nested).unwrap();
            fs::write(&f.nested, b"regular ancestor").unwrap();
            assert!(owner.validate(&receipt).is_err());
            fs::remove_file(&f.nested).unwrap();
            symlink(&old_nested, &f.nested).unwrap();
            assert!(owner.validate(&receipt).is_err());
            let root_alias = f.base.join("alias");
            symlink(&f.root, &root_alias).unwrap();
            assert!(NativeWorkspaceFileOwner::open(root_alias).is_err());
            assert_eq!(
                fs::read(f.base.join("unrelated.txt")).unwrap(),
                b"untouched"
            );
        }
        #[test]
        fn substituted_private_file_or_real_device_is_metadata_only_and_never_read() {
            let f = Fixture::new();
            let owner = NativeWorkspaceFileOwner::open(f.root.clone()).unwrap();
            let receipt = decoded(&f.receipt(&f.file));
            let guard = owner.validate(&receipt).unwrap();
            fs::rename(&f.file, f.nested.join("old-public.txt")).unwrap();
            fs::write(&f.file, b"private secret").unwrap();
            assert!(owner.validate(&receipt).is_err());
            assert!(guard.recheck().is_err());
            let fd =
                descriptor(Some(&guard.chain[1].file), Path::new("public.txt"), false).unwrap();
            let mut byte = 0u8;
            assert_eq!(
                unsafe { libc::read(fd.as_raw_fd(), (&mut byte as *mut u8).cast(), 1) },
                -1
            );
            let device = descriptor(None, Path::new("/dev/null"), false).unwrap();
            assert!(!receipt.target.matches(&metadata(&device).unwrap()));
            assert_eq!(
                unsafe { libc::read(device.as_raw_fd(), (&mut byte as *mut u8).cast(), 1) },
                -1
            );
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::EBADF)
            );
        }
        #[test]
        fn strict_receipts_refuse_wrong_roots_tasks_versions_shapes_numbers_and_depth() {
            let f = Fixture::new();
            let value = f.receipt(&f.file);
            let owner = NativeWorkspaceFileOwner::open(f.root.clone()).unwrap();
            for field in ["caller", "permissions", "program", "token"] {
                let mut bad = value.clone();
                bad[field] = json!("private");
                assert!(NativeWorkspaceReceipt::from_value(&bad).is_err());
            }
            for version in [json!(0), json!(2), json!("1"), json!(1.5)] {
                let mut bad = value.clone();
                bad["version"] = version;
                assert!(NativeWorkspaceReceipt::from_value(&bad).is_err());
            }
            let oversized_task = "x".repeat(129);
            for task in [
                "",
                "../private",
                "task_2",
                "task_1/child",
                oversized_task.as_str(),
            ] {
                let mut bad = value.clone();
                bad["taskId"] = json!(task);
                assert!(NativeWorkspaceReceipt::from_value(&bad).is_err());
            }
            for number in [
                json!(""),
                json!("01"),
                json!("-1"),
                json!("+1"),
                json!(" 1"),
                json!("1.0"),
                json!("18446744073709551616"),
                json!(1),
            ] {
                let mut bad = value.clone();
                bad["target"]["ino"] = number;
                assert!(NativeWorkspaceReceipt::from_value(&bad).is_err());
            }
            assert_eq!(decimal(&json!("18446744073709551615")).unwrap(), u64::MAX);
            assert_eq!(decimal(&json!("0")).unwrap(), 0);
            for path in [
                "relative/file",
                "/a//b",
                "/a/../b",
                "/a/./b",
                "/a/",
                "/a\u{0000}b",
            ] {
                let mut bad = value.clone();
                bad["path"] = json!(path);
                assert!(NativeWorkspaceReceipt::from_value(&bad).is_err());
            }
            let mut bad = value.clone();
            bad["ancestors"] = json!(vec![value["ancestors"][0].clone(); 65]);
            assert!(NativeWorkspaceReceipt::from_value(&bad).is_err());
            let mut bad = value.clone();
            bad["root"]["unknown"] = json!(true);
            assert!(NativeWorkspaceReceipt::from_value(&bad).is_err());
            let mut bad = value.clone();
            bad["ancestors"][0]["kind"] = json!("file");
            assert!(NativeWorkspaceReceipt::from_value(&bad).is_err());
            let mut bad = value.clone();
            bad["target"]["kind"] = json!("device");
            assert!(NativeWorkspaceReceipt::from_value(&bad).is_err());
            let other_root = f.base.join("other-root");
            let other_target = other_root.join("task_1/nested/public.txt");
            fs::create_dir_all(other_target.parent().unwrap()).unwrap();
            fs::write(&other_target, b"public content").unwrap();
            let mut foreign = value.clone();
            foreign["workspaceRoot"] = json!(other_root);
            foreign["root"] = Fixture::identity(&other_root);
            foreign["path"] = json!(other_target);
            foreign["target"] = Fixture::identity(&other_target);
            foreign["ancestors"] = json!([
                Fixture::identity(&other_root.join("task_1")),
                Fixture::identity(&other_root.join("task_1/nested"))
            ]);
            assert_eq!(
                code(owner.validate(&decoded(&foreign))),
                "WORKSPACE_PATH_CHANGED"
            );
            let mut bad = value.clone();
            bad["target"]["path"] = json!(f.base.join("unrelated.txt"));
            assert!(NativeWorkspaceReceipt::from_value(&bad).is_err());
            // Node bounds root depth and depth below the task independently.
            let mut deep = value.clone();
            let mut deep_path = f.task.clone();
            let mut ancestors = vec![Fixture::identity(&f.task)];
            for index in 0..63 {
                deep_path.push(format!("level{index}"));
                let mut identity = value["ancestors"][0].clone();
                identity["path"] = json!(deep_path);
                ancestors.push(identity);
            }
            deep_path.push("target.txt");
            deep["path"] = json!(deep_path);
            deep["target"]["path"] = json!(deep_path);
            deep["ancestors"] = json!(ancestors);
            assert!(NativeWorkspaceReceipt::from_value(&deep).is_ok());
            let mut ancestor = deep["ancestors"][0].clone();
            ancestor["path"] = deep["path"].clone();
            deep["ancestors"].as_array_mut().unwrap().push(ancestor);
            deep_path.push("too-deep.txt");
            deep["path"] = json!(deep_path);
            deep["target"]["path"] = json!(deep_path);
            assert!(NativeWorkspaceReceipt::from_value(&deep).is_err());

            assert!(canonical_path(&format!("/{}", "a/".repeat(64) + "a")));
            assert!(NativeWorkspaceFileOwner::open(PathBuf::from(format!(
                "/{}",
                "a/".repeat(64) + "a"
            )))
            .is_err());
            assert!(!canonical_path(&format!("/{}", "a".repeat(4096))));
        }
    }
}
#[cfg(target_os = "linux")]
pub use platform::{NativePinnedFileReader, NativeWorkspaceFileGuard, NativeWorkspaceFileOwner};
#[cfg(not(target_os = "linux"))]
pub struct NativePinnedFileReader {
    _private: (),
}
#[cfg(not(target_os = "linux"))]
impl NativePinnedFileReader {
    pub fn recheck(&self) -> Result<(), EngineError> {
        Err(failure("WORKSPACE_NATIVE_UNAVAILABLE"))
    }
    pub fn size(&self) -> u64 {
        0
    }
    pub fn read_chunk(&mut self, _buffer: &mut [u8]) -> Result<usize, EngineError> {
        Err(failure("WORKSPACE_NATIVE_UNAVAILABLE"))
    }
    pub fn finish(&self) -> Result<(), EngineError> {
        Err(failure("WORKSPACE_NATIVE_UNAVAILABLE"))
    }
}
#[cfg(not(target_os = "linux"))]
pub struct NativeWorkspaceFileOwner {
    _private: (),
}
#[cfg(not(target_os = "linux"))]
pub struct NativeWorkspaceFileGuard {
    path: PathBuf,
}
#[cfg(not(target_os = "linux"))]
impl NativeWorkspaceFileOwner {
    pub fn open(_root: PathBuf) -> Result<Self, EngineError> {
        Err(failure("WORKSPACE_NATIVE_UNAVAILABLE"))
    }
    pub fn validate(
        &self,
        _receipt: &NativeWorkspaceReceipt,
    ) -> Result<NativeWorkspaceFileGuard, EngineError> {
        Err(failure("WORKSPACE_NATIVE_UNAVAILABLE"))
    }
}
#[cfg(not(target_os = "linux"))]
impl NativeWorkspaceFileGuard {
    pub fn open_pinned_reader(
        self,
        _max_bytes: u64,
    ) -> Result<NativePinnedFileReader, EngineError> {
        Err(failure("WORKSPACE_NATIVE_UNAVAILABLE"))
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn recheck(&self) -> Result<(), EngineError> {
        Err(failure("WORKSPACE_NATIVE_UNAVAILABLE"))
    }
}

#[cfg(all(test, not(target_os = "linux")))]
mod unsupported_tests {
    use super::*;
    #[test]
    fn platform_never_fabricates_native_file_authority() {
        match NativeWorkspaceFileOwner::open(PathBuf::from("/trusted-workspace")) {
            Err(error) => assert_eq!(error.code, "WORKSPACE_NATIVE_UNAVAILABLE"),
            Ok(_) => panic!("unsupported platform accepted native file authority"),
        }
    }
}
