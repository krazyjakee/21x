//! Attachment receipts remain observations. A separately captured native root
//! authorizes only a literal saved task/UUID/filename namespace, never a path RPC.
use crate::{
    production::contracts::{attachment_filename, attachment_uuid, id, object},
    production_files::{
        NativePinnedFileReader, NativeWorkspaceFileGuard, NativeWorkspaceFileOwner,
        NativeWorkspaceReceipt,
    },
    production_ui_contracts, EngineError,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
const MAX_BYTES: u64 = 64 * 1024 * 1024;
fn failure(code: &'static str) -> EngineError {
    EngineError {
        code,
        message: match code {
            "ATTACHMENT_INVALID_ARGUMENTS" => "Invalid attachment file receipt.",
            "ATTACHMENT_PATH_CHANGED" => "The attachment file identity changed.",
            "ATTACHMENT_DOWNLOAD_UNAVAILABLE" => {
                "The selected destination does not support secure downloads."
            }
            "ATTACHMENT_NATIVE_UNAVAILABLE" => {
                "Native attachment file authority is unavailable on this platform."
            }
            _ => "The attachment file is unavailable or refused.",
        },
        startup_phase: None,
    }
}
fn workspace_error(error: EngineError) -> EngineError {
    failure(match error.code {
        "WORKSPACE_INVALID_ARGUMENTS" => "ATTACHMENT_INVALID_ARGUMENTS",
        "WORKSPACE_PATH_CHANGED" => "ATTACHMENT_PATH_CHANGED",
        "WORKSPACE_NATIVE_UNAVAILABLE" => "ATTACHMENT_NATIVE_UNAVAILABLE",
        _ => "ATTACHMENT_PATH_REFUSED",
    })
}
pub fn request(value: &Value) -> bool {
    object(value, &["taskId", "attachmentId"], &[])
        && id(&value["taskId"])
        && attachment_uuid(&value["attachmentId"])
}
pub fn private_request(value: &Value) -> bool {
    object(value, &["taskId", "attachmentId", "leaseId"], &[])
        && id(&value["taskId"])
        && attachment_uuid(&value["attachmentId"])
        && production_ui_contracts::lease_id(&value["leaseId"])
}
pub fn callback_request(value: &Value) -> bool {
    object(value, &["receipt", "leaseId"], &[])
        && production_ui_contracts::lease_id(&value["leaseId"])
        && NativeAttachmentReceipt::from_value(&value["receipt"]).is_ok()
}
pub fn download_callback_request(value: &Value) -> bool {
    object(value, &["receipt", "leaseId", "authorizationId"], &[])
        && production_ui_contracts::lease_id(&value["leaseId"])
        && attachment_uuid(&value["authorizationId"])
        && NativeAttachmentReceipt::from_value(&value["receipt"]).is_ok()
}
#[derive(Clone, Debug)]
pub struct NativeAttachmentReceipt {
    workspace: NativeWorkspaceReceipt,
    filename: String,
}
impl NativeAttachmentReceipt {
    pub fn filename(&self) -> &str {
        &self.filename
    }
    /// Decode without opening or reading any producer-controlled file.
    pub fn from_value(value: &Value) -> Result<Self, EngineError> {
        if value.to_string().len() > 300_000
            || !object(
                value,
                &[
                    "version",
                    "taskId",
                    "attachmentId",
                    "filename",
                    "attachmentRoot",
                    "path",
                    "root",
                    "ancestors",
                    "target",
                ],
                &[],
            )
            || !id(&value["taskId"])
            || !attachment_uuid(&value["attachmentId"])
            || !attachment_filename(&value["filename"])
            || value["target"]["kind"] != "file"
            || value["target"]["nlink"] != "1"
            || !value["target"]["size"]
                .as_str()
                .and_then(|size| size.parse::<u64>().ok())
                .is_some_and(|size| size <= MAX_BYTES)
        {
            return Err(failure("ATTACHMENT_INVALID_ARGUMENTS"));
        }
        let root = value["attachmentRoot"]
            .as_str()
            .ok_or_else(|| failure("ATTACHMENT_INVALID_ARGUMENTS"))?;
        let expected = Path::new(root)
            .join(value["taskId"].as_str().unwrap())
            .join(format!(
                "{}-{}",
                value["attachmentId"].as_str().unwrap(),
                value["filename"].as_str().unwrap()
            ));
        if value["path"].as_str() != expected.to_str() {
            return Err(failure("ATTACHMENT_INVALID_ARGUMENTS"));
        }
        // Keep every exact metadata identity and all existing workspace root,
        // ancestor, decimal, no-link and canonical-path checks intact.
        let workspace=NativeWorkspaceReceipt::from_value(&json!({
            "version":value["version"],"taskId":value["taskId"],"workspaceRoot":value["attachmentRoot"],
            "path":value["path"],"root":value["root"],"ancestors":value["ancestors"],"target":value["target"]
        })).map_err(workspace_error)?;
        Ok(Self {
            workspace,
            filename: value["filename"].as_str().unwrap().to_owned(),
        })
    }
}
pub struct NativeAttachmentFileOwner {
    owner: NativeWorkspaceFileOwner,
}
impl NativeAttachmentFileOwner {
    pub fn open(root: PathBuf) -> Result<Self, EngineError> {
        NativeWorkspaceFileOwner::open(root)
            .map(|owner| Self { owner })
            .map_err(workspace_error)
    }
    pub fn validate(
        &self,
        receipt: &NativeAttachmentReceipt,
    ) -> Result<NativeAttachmentFileGuard, EngineError> {
        self.owner
            .validate(&receipt.workspace)
            .map(|guard| NativeAttachmentFileGuard { guard })
            .map_err(workspace_error)
    }
}
pub struct NativeAttachmentFileGuard {
    guard: NativeWorkspaceFileGuard,
}
impl NativeAttachmentFileGuard {
    pub fn open_pinned_reader(self) -> Result<NativePinnedFileReader, EngineError> {
        self.guard
            .open_pinned_reader(MAX_BYTES)
            .map_err(workspace_error)
    }
    pub fn path(&self) -> &Path {
        self.guard.path()
    }
    pub fn recheck(&self) -> Result<(), EngineError> {
        self.guard.recheck().map_err(workspace_error)
    }
}

/// Destination is selected solely by the actual native save callback. The
/// service never accepts or returns this path. No existing target is replaced.
#[cfg(target_os = "linux")]
pub fn copy_new_attachment(
    mut source: NativePinnedFileReader,
    destination: PathBuf,
    before_effect: impl Fn() -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    use std::{
        ffi::CString,
        fs::File,
        io::Write,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{ffi::OsStrExt, fs::MetadataExt},
        },
    };
    let refused = || failure("ATTACHMENT_PATH_REFUSED");
    before_effect()?;
    source.recheck().map_err(workspace_error)?;
    let path = destination
        .to_str()
        .filter(|path| {
            path.len() <= 4096
                && path.starts_with('/')
                && !path.ends_with('/')
                && !path.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
                && path[1..]
                    .split('/')
                    .all(|part| !part.is_empty() && part != "." && part != "..")
        })
        .ok_or_else(refused)?;
    let destination = Path::new(path);
    let name = CString::new(destination.file_name().ok_or_else(refused)?.as_bytes())
        .map_err(|_| refused())?;
    if name.as_bytes().len() > 255 {
        return Err(refused());
    }
    let parent =
        NativeWorkspaceFileOwner::open(destination.parent().ok_or_else(refused)?.to_path_buf())
            .map_err(workspace_error)?
            .into_pinned_directory();
    parent.recheck().map_err(workspace_error)?;
    before_effect()?;
    // Anonymous staging has no pathname an attacker can substitute and needs
    // no unlink cleanup. Unsupported filesystems fail before destination effects.
    let fd = unsafe {
        libc::openat(
            parent.raw_fd(),
            c".".as_ptr(),
            libc::O_TMPFILE | libc::O_RDWR | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(failure("ATTACHMENT_DOWNLOAD_UNAVAILABLE"));
    }
    let mut staged = unsafe { File::from_raw_fd(fd) };
    let initial = staged.metadata().map_err(|_| refused())?;
    if !initial.is_file() || initial.nlink() != 0 {
        return Err(refused());
    }
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        before_effect()?;
        parent.recheck().map_err(workspace_error)?;
        let count = source.read_chunk(&mut buffer).map_err(workspace_error)?;
        if count == 0 {
            break;
        }
        before_effect()?;
        staged.write_all(&buffer[..count]).map_err(|_| refused())?;
    }
    source.finish().map_err(workspace_error)?;
    before_effect()?;
    staged.sync_all().map_err(|_| refused())?;
    let ready = staged.metadata().map_err(|_| refused())?;
    if !ready.is_file()
        || ready.nlink() != 0
        || ready.dev() != initial.dev()
        || ready.ino() != initial.ino()
        || ready.size() != source.size()
    {
        return Err(refused());
    }
    source.recheck().map_err(workspace_error)?;
    parent.recheck().map_err(workspace_error)?;
    before_effect()?;
    // linkat creates exactly one new name atomically and never overwrites. Only
    // our held kernel FD link is followed; no attacker-controlled source path.
    let own_fd =
        CString::new(format!("/proc/self/fd/{}", staged.as_raw_fd())).map_err(|_| refused())?;
    if unsafe {
        libc::linkat(
            libc::AT_FDCWD,
            own_fd.as_ptr(),
            parent.raw_fd(),
            name.as_ptr(),
            libc::AT_SYMLINK_FOLLOW,
        )
    } != 0
    {
        return Err(refused());
    }
    // Publication is accepted here. Late loss is reported; no unsafe pathname
    // rollback can delete a user file substituted after this atomic effect.
    parent.recheck().map_err(workspace_error)?;
    source.recheck().map_err(workspace_error)?;
    before_effect()?;
    let check_published = || -> Result<(), EngineError> {
        let mut published: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::fstatat(
                parent.raw_fd(),
                name.as_ptr(),
                &mut published,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
            || published.st_dev != ready.dev()
            || published.st_ino != ready.ino()
            || published.st_size < 0
            || published.st_size as u64 != ready.size()
            || published.st_mode & libc::S_IFMT != libc::S_IFREG
            || published.st_nlink != 1
        {
            return Err(refused());
        }
        Ok(())
    };
    check_published()?;
    before_effect()?;
    if unsafe { libc::fsync(parent.raw_fd()) } != 0 {
        // O_PATH parent cannot fsync: reopen only its held kernel FD for sync.
        let directory =
            CString::new(format!("/proc/self/fd/{}", parent.raw_fd())).map_err(|_| refused())?;
        before_effect()?;
        let fd = unsafe {
            libc::open(
                directory.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(refused());
        }
        let directory = unsafe { File::from_raw_fd(fd) };
        parent.recheck().map_err(workspace_error)?;
        before_effect()?;
        directory.sync_all().map_err(|_| refused())?;
    }
    parent.recheck().map_err(workspace_error)?;
    source.recheck().map_err(workspace_error)?;
    before_effect()?;
    check_published()?;
    Ok(())
}
#[cfg(not(target_os = "linux"))]
pub fn copy_new_attachment(
    _source: NativePinnedFileReader,
    _destination: PathBuf,
    _before_effect: impl Fn() -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    Err(failure("ATTACHMENT_NATIVE_UNAVAILABLE"))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{symlink, MetadataExt},
        sync::atomic::{AtomicU64, Ordering},
    };
    const UUID: &str = "61f07006-c85b-438e-83a7-497c77b0dcae";
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        task: PathBuf,
        file: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!(
                "21x-native-attachments-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&base).unwrap();
            let base = fs::canonicalize(base).unwrap();
            let root = base.join("attachments");
            let task = root.join("task_1");
            fs::create_dir_all(&task).unwrap();
            let file = task.join(format!("{UUID}-写真.txt"));
            fs::write(&file, b"public attachment").unwrap();
            fs::write(base.join("private.txt"), b"unrelated private content").unwrap();
            Self {
                base,
                root,
                task,
                file,
            }
        }
        fn identity(path: &Path) -> Value {
            let m = fs::symlink_metadata(path).unwrap();
            json!({"path":path.to_str().unwrap(),"dev":m.dev().to_string(),"ino":m.ino().to_string(),"kind":if m.is_dir(){"directory"}else{"file"},"size":m.size().to_string(),"nlink":m.nlink().to_string()})
        }
        fn receipt(&self) -> Value {
            json!({"version":1,"taskId":"task_1","attachmentId":UUID,"filename":"写真.txt","attachmentRoot":self.root.to_str().unwrap(),"path":self.file.to_str().unwrap(),"root":Self::identity(&self.root),"ancestors":[Self::identity(&self.task)],"target":Self::identity(&self.file)})
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }
    #[test]
    fn literal_saved_namespace_retains_actual_root_and_file_handles_through_recheck() {
        let f = Fixture::new();
        let owner = NativeAttachmentFileOwner::open(f.root.clone()).unwrap();
        let receipt = NativeAttachmentReceipt::from_value(&f.receipt()).unwrap();
        let guard = owner.validate(&receipt).unwrap();
        assert_eq!(guard.path(), f.file);
        guard.recheck().unwrap();
        drop(owner);
        fs::write(f.task.join("unrelated.txt"), b"later task content").unwrap();
        guard.recheck().unwrap();
        assert_eq!(
            fs::read(f.base.join("private.txt")).unwrap(),
            b"unrelated private content"
        );
    }
    #[test]
    fn exact_envelope_rejects_foreign_ids_paths_kinds_aliases_and_size_before_opening() {
        let f = Fixture::new();
        let good = f.receipt();
        for key in ["owner", "profileRoot", "workspaceRoot", "leaseId", "caller"] {
            let mut bad = good.clone();
            bad[key] = json!("grant");
            assert!(NativeAttachmentReceipt::from_value(&bad).is_err());
        }
        for (field, value) in [
            ("version", json!(2)),
            ("taskId", json!("other_task")),
            (
                "attachmentId",
                json!("61f07006-c85b-638e-83a7-497c77b0dcae"),
            ),
            ("filename", json!("../private.txt")),
            ("filename", json!("CON.txt")),
            ("filename", json!("x".repeat(217))),
            ("path", json!(f.base.join("private.txt").to_str().unwrap())),
        ] {
            let mut bad = good.clone();
            bad[field] = value;
            assert!(NativeAttachmentReceipt::from_value(&bad).is_err());
        }
        for (field, value) in [
            ("kind", json!("directory")),
            ("nlink", json!("2")),
            ("size", json!((MAX_BYTES + 1).to_string())),
            ("size", json!("01")),
            ("dev", json!("18446744073709551616")),
            ("ino", json!("-1")),
        ] {
            let mut bad = good.clone();
            bad["target"][field] = value;
            assert!(NativeAttachmentReceipt::from_value(&bad).is_err());
        }
        let mut bad = good.clone();
        bad["ancestors"] = json!([]);
        assert!(NativeAttachmentReceipt::from_value(&bad).is_err());
        let mut bad = good.clone();
        bad["ancestors"] = json!(vec![good["ancestors"][0].clone(); 65]);
        assert!(NativeAttachmentReceipt::from_value(&bad).is_err());
        let mut boundary = good;
        boundary["target"]["size"] = json!(MAX_BYTES.to_string());
        assert!(NativeAttachmentReceipt::from_value(&boundary).is_ok());
    }
    #[test]
    fn root_namespace_and_target_replacement_never_retarget_captured_descriptors() {
        let f = Fixture::new();
        let owner = NativeAttachmentFileOwner::open(f.root.clone()).unwrap();
        let receipt = NativeAttachmentReceipt::from_value(&f.receipt()).unwrap();
        let guard = owner.validate(&receipt).unwrap();
        let original = f.task.join("original.txt");
        fs::rename(&f.file, &original).unwrap();
        fs::write(&f.file, b"public attachment").unwrap();
        assert!(guard.recheck().is_err());
        assert!(owner.validate(&receipt).is_err());
        fs::remove_file(&f.file).unwrap();
        fs::rename(original, &f.file).unwrap();
        guard.recheck().unwrap();
        let old = f.base.join("old-attachments");
        fs::rename(&f.root, &old).unwrap();
        fs::create_dir_all(&f.task).unwrap();
        fs::write(&f.file, b"public attachment").unwrap();
        assert!(guard.recheck().is_err());
        let replacement = NativeAttachmentReceipt::from_value(&f.receipt()).unwrap();
        assert!(owner.validate(&replacement).is_err());
        fs::remove_dir_all(&f.root).unwrap();
        fs::rename(old, &f.root).unwrap();
        guard.recheck().unwrap();
        let old_task = f.root.join("old-task");
        fs::rename(&f.task, &old_task).unwrap();
        fs::create_dir(&f.task).unwrap();
        fs::write(&f.file, b"public attachment").unwrap();
        assert!(guard.recheck().is_err());
        assert!(owner.validate(&receipt).is_err());
    }
    #[test]
    fn links_changed_sizes_and_foreign_trusted_roots_do_not_grant_private_reads() {
        let f = Fixture::new();
        let owner = NativeAttachmentFileOwner::open(f.root.clone()).unwrap();
        let receipt = NativeAttachmentReceipt::from_value(&f.receipt()).unwrap();
        let guard = owner.validate(&receipt).unwrap();
        fs::write(&f.file, b"changed size").unwrap();
        assert!(guard.recheck().is_err());
        fs::remove_file(&f.file).unwrap();
        symlink(f.base.join("private.txt"), &f.file).unwrap();
        assert!(owner.validate(&receipt).is_err());
        assert!(guard.recheck().is_err());
        fs::remove_file(&f.file).unwrap();
        fs::hard_link(f.base.join("private.txt"), &f.file).unwrap();
        assert!(NativeAttachmentReceipt::from_value(&f.receipt()).is_err());
        assert!(owner.validate(&receipt).is_err());
        fs::remove_file(&f.file).unwrap();
        fs::write(&f.file, b"public attachment").unwrap();
        let other = f.base.join("other-root");
        fs::create_dir(&other).unwrap();
        let foreign = NativeAttachmentFileOwner::open(other).unwrap();
        assert!(foreign.validate(&receipt).is_err());
        assert_eq!(
            fs::read(f.base.join("private.txt")).unwrap(),
            b"unrelated private content"
        );
    }
    #[test]
    fn substituted_task_links_and_fifo_targets_are_refused_without_reading_or_blocking() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let f = Fixture::new();
        let owner = NativeAttachmentFileOwner::open(f.root.clone()).unwrap();
        let receipt = NativeAttachmentReceipt::from_value(&f.receipt()).unwrap();
        let original = f.root.join("original-task");
        fs::rename(&f.task, &original).unwrap();
        symlink(&original, &f.task).unwrap();
        assert!(owner.validate(&receipt).is_err());
        fs::remove_file(&f.task).unwrap();
        fs::rename(&original, &f.task).unwrap();
        fs::remove_file(&f.file).unwrap();
        let name = CString::new(f.file.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(owner.validate(&receipt).is_err());
        assert_eq!(
            fs::read(f.base.join("private.txt")).unwrap(),
            b"unrelated private content"
        );
    }
    #[test]
    fn aliases_and_nonliteral_metadata_paths_cannot_bypass_attachment_namespace() {
        let f = Fixture::new();
        let value = f.receipt();
        for path in [
            format!("{}/./task_1/{}-写真.txt", f.root.display(), UUID),
            format!("{}/task_1//{}-写真.txt", f.root.display(), UUID),
            format!("{}/task_1/../{}-写真.txt", f.root.display(), UUID),
        ] {
            let mut bad = value.clone();
            bad["path"] = json!(path);
            bad["target"]["path"] = bad["path"].clone();
            assert!(NativeAttachmentReceipt::from_value(&bad).is_err());
        }
        let mut bad = value.clone();
        bad["root"]["path"] = json!(f.base.to_str().unwrap());
        assert!(NativeAttachmentReceipt::from_value(&bad).is_err());
        let mut bad = value.clone();
        bad["ancestors"][0]["kind"] = json!("file");
        assert!(NativeAttachmentReceipt::from_value(&bad).is_err());
        let mut bad = value.clone();
        bad["attachmentRoot"] = json!(format!("/{}", "x".repeat(4096)));
        assert!(NativeAttachmentReceipt::from_value(&bad).is_err());
        let mut observed = value;
        observed["root"]["size"] = json!("0");
        observed["root"]["nlink"] = json!("999");
        observed["ancestors"][0]["size"] = json!("0");
        observed["ancestors"][0]["nlink"] = json!("999");
        let owner = NativeAttachmentFileOwner::open(f.root.clone()).unwrap();
        owner
            .validate(&NativeAttachmentReceipt::from_value(&observed).unwrap())
            .unwrap();
    }
    fn reader(f: &Fixture) -> NativePinnedFileReader {
        let owner = NativeAttachmentFileOwner::open(f.root.clone()).unwrap();
        owner
            .validate(&NativeAttachmentReceipt::from_value(&f.receipt()).unwrap())
            .unwrap()
            .open_pinned_reader()
            .unwrap()
    }
    #[test]
    fn pinned_binary_and_empty_downloads_create_only_new_synced_files() {
        let f = Fixture::new();
        let destination = f.base.join("download.bin");
        let bytes = (0..65537)
            .map(|index| (index % 256) as u8)
            .collect::<Vec<_>>();
        fs::write(&f.file, &bytes).unwrap();
        copy_new_attachment(reader(&f), destination.clone(), || Ok(())).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), bytes);
        assert_eq!(fs::metadata(&destination).unwrap().nlink(), 1);
        fs::write(&f.file, b"").unwrap();
        let empty = f.base.join("empty.bin");
        copy_new_attachment(reader(&f), empty.clone(), || Ok(())).unwrap();
        assert_eq!(fs::metadata(empty).unwrap().size(), 0);
        assert_eq!(
            fs::read(f.base.join("private.txt")).unwrap(),
            b"unrelated private content"
        );
    }
    #[test]
    fn every_existing_target_kind_and_racing_user_file_is_preserved() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let f = Fixture::new();
        let ordinary = f.base.join("existing.bin");
        fs::write(&ordinary, b"user-owned").unwrap();
        assert!(copy_new_attachment(reader(&f), ordinary.clone(), || Ok(())).is_err());
        assert_eq!(fs::read(&ordinary).unwrap(), b"user-owned");
        let link = f.base.join("link.bin");
        symlink(&ordinary, &link).unwrap();
        assert!(copy_new_attachment(reader(&f), link.clone(), || Ok(())).is_err());
        assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
        let hard = f.base.join("hard.bin");
        fs::hard_link(&ordinary, &hard).unwrap();
        assert!(copy_new_attachment(reader(&f), hard, || Ok(())).is_err());
        assert_eq!(fs::read(&ordinary).unwrap(), b"user-owned");
        let fifo = f.base.join("fifo.bin");
        let name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(copy_new_attachment(reader(&f), fifo, || Ok(())).is_err());
        let directory = f.base.join("directory.bin");
        fs::create_dir(&directory).unwrap();
        assert!(copy_new_attachment(reader(&f), directory, || Ok(())).is_err());
        let racing = f.base.join("racing.bin");
        let count = std::cell::Cell::new(0);
        assert!(copy_new_attachment(reader(&f), racing.clone(), || {
            let turn = count.get() + 1;
            count.set(turn);
            if turn == 4 {
                fs::write(&racing, b"racing user file").unwrap();
            }
            Ok(())
        })
        .is_err());
        assert_eq!(fs::read(racing).unwrap(), b"racing user file");
    }
    #[test]
    fn late_target_replacement_reports_failure_without_deleting_user_or_accepted_files() {
        let f = Fixture::new();
        let destination = f.base.join("saved.bin");
        let accepted = f.base.join("accepted.bin");
        let changed = std::cell::Cell::new(false);
        assert!(copy_new_attachment(reader(&f), destination.clone(), || {
            if destination.exists() && !changed.replace(true) {
                fs::rename(&destination, &accepted).unwrap();
                fs::write(&destination, b"replacement user file").unwrap();
            }
            Ok(())
        })
        .is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"replacement user file");
        assert_eq!(fs::read(&accepted).unwrap(), b"public attachment");
        assert_eq!(fs::read(&f.file).unwrap(), b"public attachment");
    }
    #[test]
    fn source_same_size_changes_and_replacement_are_refused_by_pinned_reader() {
        let f = Fixture::new();
        let mut source = reader(&f);
        fs::write(&f.file, b"changed attachmen").unwrap(); // same 17-byte size
        use std::os::fd::AsRawFd;
        let changed = fs::File::open(&f.file).unwrap();
        let times = [
            libc::timespec {
                tv_sec: 0,
                tv_nsec: libc::UTIME_OMIT,
            },
            libc::timespec {
                tv_sec: 1,
                tv_nsec: 0,
            },
        ];
        assert_eq!(
            unsafe { libc::futimens(changed.as_raw_fd(), times.as_ptr()) },
            0
        );
        assert!(source.read_chunk(&mut [0u8; 64]).is_err());
        let old = f.task.join("old-source");
        let source = reader(&f);
        fs::rename(&f.file, &old).unwrap();
        fs::write(&f.file, b"changed attachmen").unwrap();
        assert!(copy_new_attachment(source, f.base.join("replacement.bin"), || Ok(())).is_err());
        assert!(!f.base.join("replacement.bin").exists());
        fs::remove_file(&f.file).unwrap();
        fs::rename(old, &f.file).unwrap();
        let file = fs::OpenOptions::new().write(true).open(&f.file).unwrap();
        file.set_len(MAX_BYTES + 1).unwrap();
        assert!(NativeAttachmentReceipt::from_value(&f.receipt()).is_err());
    }
    #[test]
    fn revoked_copy_and_replaced_destination_tree_leave_no_named_partial_file() {
        let f = Fixture::new();
        let destination = f.base.join("cancelled.bin");
        let effects = std::cell::Cell::new(0);
        assert!(copy_new_attachment(reader(&f), destination.clone(), || {
            let count = effects.get() + 1;
            effects.set(count);
            if count == 4 {
                Err(EngineError::new("CANCELLED"))
            } else {
                Ok(())
            }
        })
        .is_err());
        assert!(!destination.exists());
        assert_eq!(fs::read_dir(&f.base).unwrap().count(), 2); // root + private.txt only
        let folder = f.base.join("chosen");
        fs::create_dir(&folder).unwrap();
        let destination = folder.join("tree.bin");
        let moved = f.base.join("moved");
        let effects = std::cell::Cell::new(0);
        assert!(copy_new_attachment(reader(&f), destination.clone(), || {
            let count = effects.get() + 1;
            effects.set(count);
            if count == 4 {
                fs::rename(&folder, &moved).unwrap();
                fs::create_dir(&folder).unwrap();
            }
            Ok(())
        })
        .is_err());
        assert!(!destination.exists());
        assert!(!moved.join("tree.bin").exists());
        let alias = f.base.join("alias");
        symlink(&folder, &alias).unwrap();
        assert!(copy_new_attachment(reader(&f), alias.join("bad.bin"), || Ok(())).is_err());
        assert!(!folder.join("bad.bin").exists());
    }
    #[test]
    fn download_callback_requires_exact_receipt_lease_and_nonce_without_open_grants() {
        let f = Fixture::new();
        let valid = json!({"receipt":f.receipt(),"leaseId":"ui:1","authorizationId":UUID});
        assert!(download_callback_request(&valid));
        assert!(!callback_request(&valid));
        assert!(!download_callback_request(
            &json!({"receipt":f.receipt(),"leaseId":"ui:1"})
        ));
        for field in ["receipt", "leaseId", "authorizationId"] {
            let mut missing = valid.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(!download_callback_request(&missing));
        }
        for nonce in [
            Value::Null,
            json!(1),
            json!(""),
            json!("../foreign"),
            json!("ui:1"),
            json!("61f07006-c85b-038e-83a7-497c77b0dcae"),
        ] {
            let mut invalid = valid.clone();
            invalid["authorizationId"] = nonce;
            assert!(!download_callback_request(&invalid));
        }
        let mut foreign_lease = valid.clone();
        foreign_lease["leaseId"] = json!("../foreign");
        assert!(!download_callback_request(&foreign_lease));
        let mut foreign_receipt = valid.clone();
        foreign_receipt["receipt"]["taskId"] = json!("foreign_task");
        assert!(!download_callback_request(&foreign_receipt));
        for field in ["filePath", "destination", "epoch", "authorized"] {
            let mut extra = valid.clone();
            extra[field] = json!("foreign");
            assert!(!download_callback_request(&extra));
        }
        // UUID syntax is not authorization: the source checks its live nonce map.
        let mut other_nonce = valid;
        other_nonce["authorizationId"] = json!("61f07006-c85b-438e-83a7-497c77b0dca0");
        assert!(download_callback_request(&other_nonce));
    }
    #[test]
    fn public_private_and_callback_shapes_never_supply_a_general_native_path_grant() {
        let f = Fixture::new();
        assert!(request(&json!({"taskId":"task_1","attachmentId":UUID})));
        assert!(crate::production::contracts::valid_request(
            "attachments:open",
            &json!({"taskId":"task_1","attachmentId":UUID})
        ));
        assert!(crate::production::contracts::valid_result(
            "attachments:open",
            &json!({"defined":false})
        ));
        assert!(!crate::production::contracts::valid_result(
            "attachments:open",
            &json!({"defined":false,"value":null})
        ));
        assert!(!request(
            &json!({"taskId":"task_1","attachmentId":UUID,"filePath":f.file})
        ));
        assert!(!request(
            &json!({"taskId":"task_1","attachmentId":UUID,"leaseId":"ui:1"})
        ));
        assert!(private_request(
            &json!({"taskId":"task_1","attachmentId":UUID,"leaseId":"ui:1"})
        ));
        assert!(callback_request(
            &json!({"receipt":f.receipt(),"leaseId":"ui:1"})
        ));
        assert!(!callback_request(
            &json!({"receipt":f.receipt(),"leaseId":"../foreign"})
        ));
        assert!(!crate::production::contracts::COMMANDS.contains(&"engine.attachment.open"));
        assert!(!crate::production::contracts::valid_request(
            "engine.attachment.open",
            &json!({"taskId":"task_1","attachmentId":UUID,"leaseId":"ui:1"})
        ));
    }
}
#[cfg(all(test, not(target_os = "linux")))]
mod unsupported_tests {
    use super::*;
    #[test]
    fn unsupported_platform_never_fabricates_attachment_authority() {
        match NativeAttachmentFileOwner::open(PathBuf::from("/trusted-attachments")) {
            Err(error) => assert_eq!(error.code, "ATTACHMENT_NATIVE_UNAVAILABLE"),
            Ok(_) => panic!("unsupported native authority"),
        }
    }
}
