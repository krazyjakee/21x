//! Native chooser grants; a pathname crossing the public boundary is display
//! metadata only. Regular files and every ancestor remain descriptor-bound.
use crate::{production::contracts, production_ui_contracts, EngineError};
use serde_json::{json, Value};
#[cfg(target_os = "linux")]
use sha2::{Digest, Sha256};
#[cfg(target_os = "linux")]
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
const LIMIT: u64 = 64 * 1024 * 1024;
fn refused() -> EngineError {
    EngineError::new("INVALID_REQUEST")
}
pub fn path(value: &Value) -> bool {
    value.as_str().is_some_and(|p| {
        p.len() > 1
            && p.len() <= 4096
            && p.starts_with('/')
            && !p.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
            && p[1..]
                .split('/')
                .all(|p| !p.is_empty() && p != "." && p != "..")
    })
}
pub fn selection(value: &Value) -> bool {
    contracts::object(value, &["selectionId", "path", "filename", "size"], &[])
        && contracts::attachment_uuid(&value["selectionId"])
        && path(&value["path"])
        && contracts::attachment_filename(&value["filename"])
        && value["path"]
            .as_str()
            .unwrap()
            .ends_with(&format!("/{}", value["filename"].as_str().unwrap()))
        && value["size"].as_u64().is_some_and(|s| s <= LIMIT)
}
pub fn offer(value: &Value) -> bool {
    if !contracts::object(value, &["leaseId", "selections"], &[])
        || !production_ui_contracts::lease_id(&value["leaseId"])
    {
        return false;
    }
    let Some(rows) = value["selections"]
        .as_array()
        .filter(|r| !r.is_empty() && r.len() <= 16)
    else {
        return false;
    };
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    rows.iter().all(|v| {
        selection(v)
            && ids.insert(v["selectionId"].as_str().unwrap())
            && paths.insert(v["path"].as_str().unwrap())
    })
}
pub fn revocation(value: &Value) -> bool {
    if !contracts::object(value, &["leaseId", "selectionIds"], &[])
        || !production_ui_contracts::lease_id(&value["leaseId"])
    {
        return false;
    }
    let Some(ids) = value["selectionIds"]
        .as_array()
        .filter(|ids| !ids.is_empty() && ids.len() <= 16)
    else {
        return false;
    };
    let mut seen = HashSet::new();
    ids.iter()
        .all(|id| contracts::attachment_uuid(id) && seen.insert(id.as_str().unwrap()))
}
pub fn request(operation: &str, value: &Value) -> bool {
    let read = operation == "host.attachment.selection.read";
    if !read
        && !matches!(
            operation,
            "host.attachment.selection.retire" | "host.attachment.selection.finish"
        )
    {
        return false;
    }
    if !contracts::object(
        value,
        if read {
            &["leaseId", "selectionId", "offset", "length"]
        } else {
            &["leaseId", "selectionId"]
        },
        &[],
    ) || !production_ui_contracts::lease_id(&value["leaseId"])
        || !contracts::attachment_uuid(&value["selectionId"])
    {
        return false;
    }
    !read
        || value["offset"]
            .as_u64()
            .zip(value["length"].as_u64())
            .is_some_and(|(o, l)| l > 0 && l <= 65536 && o <= LIMIT && o + l <= LIMIT)
}
pub fn result(operation: &str, value: &Value) -> bool {
    if operation == "host.attachment.selection.retire" {
        return value == &json!({"retired":true});
    }
    if operation == "host.attachment.selection.finish" {
        return value == &json!({"verified":true});
    }
    contracts::object(value, &["data"], &[])
        && value["data"].as_str().is_some_and(|s| {
            s.len() <= 87384
                && s.len() % 4 == 0
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
        })
}
pub fn save_request(value: &Value) -> bool {
    contracts::object(value, &["taskId", "filePath"], &[])
        && contracts::id(&value["taskId"])
        && value["filePath"].as_str().is_some_and(|p| {
            !p.is_empty() && p.len() <= 4096 && !p.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
        })
}
pub fn save_result(value: &Value) -> bool {
    contracts::object(value, &["defined", "value"], &[])
        && value["defined"] == true
        && contracts::valid_result(
            "chatImages:saveToTask",
            &json!({"defined":true,"value":[value["value"]]}),
        )
        && value["value"]["size"].as_u64().is_some_and(|s| s <= LIMIT)
}
#[cfg(target_os = "linux")]
fn encode(bytes: &[u8]) -> String {
    const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let (a, b, d) = (
            c[0],
            c.get(1).copied().unwrap_or(0),
            c.get(2).copied().unwrap_or(0),
        );
        out.push(ABC[(a >> 2) as usize] as char);
        out.push(ABC[(((a & 3) << 4) | (b >> 4)) as usize] as char);
        out.push(if c.len() > 1 {
            ABC[(((b & 15) << 2) | (d >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            ABC[(d & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
#[cfg(target_os = "linux")]
struct SelectedFile {
    chain: Vec<(std::fs::File, PathBuf, std::fs::Metadata)>,
    reader: std::fs::File,
    expected: std::fs::Metadata,
    offset: u64,
    selected_digest: [u8; 32],
    read_digest: Sha256,
}
#[cfg(target_os = "linux")]
impl SelectedFile {
    fn open(
        path: PathBuf,
        profile: &std::path::Path,
        current: impl Fn() -> Result<(), EngineError>,
    ) -> Result<Self, EngineError> {
        use std::{
            ffi::CString,
            os::{
                fd::{AsRawFd, FromRawFd},
                unix::{
                    ffi::OsStrExt,
                    fs::{MetadataExt, OpenOptionsExt},
                },
            },
        };
        current()?;
        if !self::path(&json!(path)) || path.starts_with(profile) {
            return Err(refused());
        }
        let mut chain: Vec<(std::fs::File, PathBuf, std::fs::Metadata)> = Vec::new();
        let mut name = PathBuf::from("/");
        let components: Vec<_> = path.components().collect();
        if components.len() > 64 {
            return Err(refused());
        }
        for (index, part) in components.iter().enumerate() {
            current()?;
            if index > 0 {
                name.push(part.as_os_str());
            }
            let directory = index + 1 < components.len();
            let component = CString::new(if index == 0 {
                b"/".as_slice()
            } else {
                part.as_os_str().as_bytes()
            })
            .map_err(|_| refused())?;
            let fd = unsafe {
                libc::openat(
                    chain.last().map_or(libc::AT_FDCWD, |v| v.0.as_raw_fd()),
                    component.as_ptr(),
                    libc::O_PATH
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC
                        | libc::O_NONBLOCK
                        | if directory { libc::O_DIRECTORY } else { 0 },
                )
            };
            if fd < 0 {
                return Err(refused());
            }
            let file = unsafe { std::fs::File::from_raw_fd(fd) };
            let info = file.metadata().map_err(|_| refused())?;
            if directory && !info.is_dir()
                || !directory && (!info.is_file() || info.nlink() != 1 || info.size() > LIMIT)
            {
                return Err(refused());
            }
            chain.push((file, name.clone(), info));
        }
        let last = chain.last().ok_or_else(refused)?;
        let expected = last.2.clone();
        let reader = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(format!("/proc/self/fd/{}", last.0.as_raw_fd()))
            .map_err(|_| refused())?;
        let mut file = Self {
            chain,
            reader,
            expected,
            offset: 0,
            selected_digest: [0; 32],
            read_digest: Sha256::new(),
        };
        file.check()?;
        // Hold the actual FD and bind the bytes with bounded scratch space.
        // Filesystem timestamps can coalesce across same-size edits.
        use std::io::{Read, Seek, SeekFrom};
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 65536];
        let mut remaining = file.expected.size();
        while remaining > 0 {
            current()?;
            file.check()?;
            let length = buffer.len().min(remaining as usize);
            let count = file
                .reader
                .read(&mut buffer[..length])
                .map_err(|_| refused())?;
            if count == 0 {
                return Err(refused());
            }
            digest.update(&buffer[..count]);
            remaining -= count as u64;
        }
        current()?;
        file.check()?;
        file.selected_digest = digest.finalize().into();
        file.reader
            .seek(SeekFrom::Start(0))
            .map_err(|_| refused())?;
        Ok(file)
    }
    fn check(&self) -> Result<(), EngineError> {
        use std::os::unix::fs::MetadataExt;
        for (fd, path, expected) in &self.chain {
            let actual = fd.metadata().map_err(|_| refused())?;
            let named = std::fs::symlink_metadata(path).map_err(|_| refused())?;
            if actual.dev() != expected.dev()
                || actual.ino() != expected.ino()
                || named.dev() != expected.dev()
                || named.ino() != expected.ino()
                || named.file_type().is_symlink()
                || expected.is_dir() && !named.is_dir()
            {
                return Err(refused());
            }
        }
        let actual = self.reader.metadata().map_err(|_| refused())?;
        let named = std::fs::symlink_metadata(&self.chain.last().ok_or_else(refused)?.1)
            .map_err(|_| refused())?;
        for m in [&actual, &named] {
            if !m.is_file()
                || m.nlink() != 1
                || m.dev() != self.expected.dev()
                || m.ino() != self.expected.ino()
                || m.size() != self.expected.size()
                || m.mtime() != self.expected.mtime()
                || m.mtime_nsec() != self.expected.mtime_nsec()
                || m.ctime() != self.expected.ctime()
                || m.ctime_nsec() != self.expected.ctime_nsec()
            {
                return Err(refused());
            }
        }
        Ok(())
    }
    fn read(&mut self, offset: u64, length: usize) -> Result<String, EngineError> {
        use std::{io::Read, os::unix::fs::MetadataExt};
        self.check()?;
        if offset != self.offset
            || length == 0
            || length > 65536
            || offset + length as u64 > self.expected.size()
        {
            return Err(refused());
        }
        let mut data = vec![0; length];
        self.reader.read_exact(&mut data).map_err(|_| refused())?;
        self.offset += length as u64;
        self.read_digest.update(&data);
        self.check()?;
        if self.offset == self.expected.size() {
            self.finish()?;
        }
        Ok(encode(&data))
    }
    fn finish(&self) -> Result<(), EngineError> {
        use std::os::unix::fs::MetadataExt;
        self.check()?;
        let digest: [u8; 32] = self.read_digest.clone().finalize().into();
        if self.offset != self.expected.size() || digest != self.selected_digest {
            return Err(refused());
        }
        Ok(())
    }
}
#[cfg(target_os = "linux")]
struct Entry {
    file: SelectedFile,
    lease: String,
    expires: Instant,
}
#[derive(Default)]
struct State {
    #[cfg(target_os = "linux")]
    entries: HashMap<String, Entry>,
    #[cfg(target_os = "linux")]
    used: HashSet<String>,
}
#[derive(Clone, Default)]
pub struct SelectionAuthority(Arc<Mutex<State>>, Arc<AtomicBool>);
impl SelectionAuthority {
    /// Called only with actual native chooser results and app-owned UUIDs.
    pub fn select(
        &self,
        path: PathBuf,
        selection_id: &str,
        lease: &str,
        profile: &std::path::Path,
    ) -> Result<Value, EngineError> {
        self.select_scoped(path, selection_id, lease, profile, || Ok(()))
    }
    pub fn select_scoped(
        &self,
        path: PathBuf,
        selection_id: &str,
        lease: &str,
        profile: &std::path::Path,
        current: impl Fn() -> Result<(), EngineError>,
    ) -> Result<Value, EngineError> {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (path, selection_id, lease, profile, current);
            Err(EngineError::new("UNKNOWN_OPERATION"))
        }
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::MetadataExt;
            let filename = path
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or_else(refused)?
                .to_owned();
            if !contracts::attachment_filename(&json!(filename))
                || !contracts::attachment_uuid(&json!(selection_id))
                || !production_ui_contracts::lease_id(&json!(lease))
            {
                return Err(refused());
            }
            let mut state = self.0.lock().map_err(|_| refused())?;
            if self.1.load(Ordering::SeqCst)
                || state.entries.len() >= 16
                || state.used.len() >= 4096
                || state.used.contains(selection_id)
            {
                return Err(refused());
            }
            // Consume the ID before filesystem acquisition, even on refusal.
            state.used.insert(selection_id.into());
            let guard = || {
                if self.1.load(Ordering::SeqCst) {
                    return Err(refused());
                }
                current()
            };
            let file = SelectedFile::open(path.clone(), profile, guard)?;
            current()?;
            let value = json!({"selectionId":selection_id,"path":path,"filename":filename,"size":file.expected.size()});
            state.entries.insert(
                selection_id.into(),
                Entry {
                    file,
                    lease: lease.into(),
                    expires: Instant::now() + Duration::from_secs(300),
                },
            );
            Ok(value)
        }
    }
    pub fn invoke(
        &self,
        operation: &str,
        value: &Value,
        current: impl Fn() -> Result<(), EngineError>,
    ) -> Result<Value, EngineError> {
        if !request(operation, value) {
            return Err(EngineError::new("INVALID_ARGUMENTS"));
        }
        let mut state = self.0.lock().map_err(|_| refused())?;
        let id = value["selectionId"].as_str().unwrap();
        let lease = value["leaseId"].as_str().unwrap();
        #[cfg(target_os = "linux")]
        {
            if operation == "host.attachment.selection.retire" {
                if state.entries.get(id).is_some_and(|e| e.lease != lease) {
                    return Err(refused());
                }
                if !state.used.contains(id) && state.used.len() < 4096 {
                    state.used.insert(id.into());
                }
                state.entries.remove(id);
                return Ok(json!({"retired":true}));
            }
            current()?;
            if self.1.load(Ordering::SeqCst) {
                return Err(refused());
            }
            let entry = state
                .entries
                .get_mut(id)
                .filter(|e| e.lease == lease && Instant::now() < e.expires)
                .ok_or_else(refused)?;
            if operation == "host.attachment.selection.finish" {
                entry.file.finish()?;
                current()?;
                return Ok(json!({"verified":true}));
            }
            let data = entry.file.read(
                value["offset"].as_u64().unwrap(),
                value["length"].as_u64().unwrap() as usize,
            )?;
            current()?;
            if self.1.load(Ordering::SeqCst) {
                return Err(refused());
            }
            Ok(json!({"data":data}))
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (&mut state, id, lease, current);
            Err(EngineError::new("UNKNOWN_OPERATION"))
        }
    }
    pub fn stop(&self) -> Result<(), EngineError> {
        self.1.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn close(&self) -> Result<(), EngineError> {
        self.stop()?;
        #[cfg(target_os = "linux")]
        self.0.lock().map_err(|_| refused())?.entries.clear();
        Ok(())
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink};
    const ID: &str = "61f07006-c85b-438e-83a7-497c77b0dcae";
    const OTHER: &str = "71f07006-c85b-438e-83a7-497c77b0dcae";
    const LEASE: &str = "ui_selection_fixture";
    struct Fixture {
        root: PathBuf,
        path: PathBuf,
        profile: PathBuf,
        owner: SelectionAuthority,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "21x-selection-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(root.join("documents")).unwrap();
            fs::create_dir(root.join("profile")).unwrap();
            let path = root.join("documents/selected.txt");
            fs::write(&path, b"abc").unwrap();
            let profile = root.join("profile");
            Self {
                root,
                path,
                profile,
                owner: SelectionAuthority::default(),
            }
        }
        fn select(&self) -> Value {
            self.owner
                .select(self.path.clone(), ID, LEASE, &self.profile)
                .unwrap()
        }
        fn read(&self, lease: &str, offset: u64, length: u64) -> Result<Value, EngineError> {
            self.owner.invoke(
                "host.attachment.selection.read",
                &json!({"selectionId":ID,"leaseId":lease,"offset":offset,"length":length}),
                || Ok(()),
            )
        }
        fn retire(&self, id: &str) -> Result<Value, EngineError> {
            self.owner.invoke(
                "host.attachment.selection.retire",
                &json!({"selectionId":id,"leaseId":LEASE}),
                || Ok(()),
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.owner.close().unwrap();
            fs::remove_dir_all(&self.root).unwrap();
        }
    }
    #[test]
    fn private_group_revocation_is_exact_bounded_and_not_public_file_authority() {
        let valid = json!({"leaseId":LEASE,"selectionIds":[ID,OTHER]});
        assert!(revocation(&valid));
        assert!(!contracts::valid_request(
            "engine.attachment.selection.revoke",
            &valid
        ));
        for invalid in [
            json!({"leaseId":LEASE,"selectionIds":[]}),
            json!({"leaseId":LEASE,"selectionIds":[ID,ID]}),
            json!({"leaseId":"../foreign","selectionIds":[ID]}),
            json!({"leaseId":LEASE,"selectionIds":["/etc/passwd"]}),
            json!({"leaseId":LEASE,"selectionIds":[ID],"path":"/etc/passwd"}),
        ] {
            assert!(!revocation(&invalid));
        }
    }
    #[test]
    fn native_offer_holds_exact_regular_file_and_enforces_document_offset_and_one_shot_reads() {
        let f = Fixture::new();
        let value = f.select();
        assert!(selection(&value));
        assert!(offer(&json!({"leaseId":LEASE,"selections":[value]})));
        assert!(f.read("ui_foreign", 0, 3).is_err());
        assert!(f.read(LEASE, 1, 2).is_err());
        assert_eq!(f.read(LEASE, 0, 3).unwrap(), json!({"data":"YWJj"}));
        assert!(f.read(LEASE, 0, 3).is_err());
        f.retire(ID).unwrap();
        assert!(f.read(LEASE, 0, 3).is_err());
        assert!(f
            .owner
            .select(f.path.clone(), ID, LEASE, &f.profile)
            .is_err());
    }
    #[test]
    fn rejects_profile_symlinks_hardlinks_directories_and_normalization_aliases() {
        let f = Fixture::new();
        fs::write(f.profile.join("private.txt"), b"private").unwrap();
        assert!(f
            .owner
            .select(f.profile.join("private.txt"), ID, LEASE, &f.profile)
            .is_err());
        assert!(f
            .owner
            .select(
                f.root.join("documents/../documents/selected.txt"),
                OTHER,
                LEASE,
                &f.profile
            )
            .is_err());
        let f = Fixture::new();
        symlink(&f.path, f.root.join("alias.txt")).unwrap();
        assert!(f
            .owner
            .select(f.root.join("alias.txt"), ID, LEASE, &f.profile)
            .is_err());
        let f = Fixture::new();
        fs::hard_link(&f.path, f.root.join("linked.txt")).unwrap();
        assert!(f
            .owner
            .select(f.path.clone(), ID, LEASE, &f.profile)
            .is_err());
        assert!(f
            .owner
            .select(f.root.join("documents"), OTHER, LEASE, &f.profile)
            .is_err());
    }
    #[test]
    fn pinned_fd_never_follows_replaced_file_or_parent_namespace() {
        for parent in [false, true] {
            let f = Fixture::new();
            f.select();
            if parent {
                fs::rename(f.root.join("documents"), f.root.join("retained")).unwrap();
                fs::create_dir(f.root.join("documents")).unwrap();
                fs::write(&f.path, b"xyz").unwrap();
            } else {
                fs::rename(&f.path, f.root.join("retained.txt")).unwrap();
                fs::write(&f.path, b"xyz").unwrap();
            }
            assert!(f.read(LEASE, 0, 3).is_err());
            assert_eq!(fs::read(&f.path).unwrap(), b"xyz");
        }
    }
    #[test]
    fn rejects_in_place_changes_new_hardlinks_expiry_and_revoked_native_scope() {
        let f = Fixture::new();
        f.select();
        fs::write(&f.path, b"xyz").unwrap();
        assert!(f.read(LEASE, 0, 3).is_err());
        let f = Fixture::new();
        f.select();
        fs::hard_link(&f.path, f.root.join("linked.txt")).unwrap();
        assert!(f.read(LEASE, 0, 3).is_err());
        let f = Fixture::new();
        f.select();
        f.owner
            .0
            .lock()
            .unwrap()
            .entries
            .get_mut(ID)
            .unwrap()
            .expires = Instant::now();
        assert!(f.read(LEASE, 0, 3).is_err());
        let f = Fixture::new();
        f.select();
        assert!(f
            .owner
            .invoke(
                "host.attachment.selection.read",
                &json!({"selectionId":ID,"leaseId":LEASE,"offset":0,"length":3}),
                || Err(EngineError::new("DISCONNECTED"))
            )
            .is_err());
        assert_eq!(f.read(LEASE, 0, 3).unwrap(), json!({"data":"YWJj"}));
    }
    #[test]
    fn stop_fences_admission_without_waiting_for_the_raw_file_mutex() {
        let f = Fixture::new();
        f.select();
        let raw = f.owner.0.lock().unwrap();
        f.owner.stop().unwrap();
        assert!(f.owner.1.load(Ordering::SeqCst));
        drop(raw);
        assert!(f.read(LEASE, 0, 3).is_err());
        f.retire(ID).unwrap();
    }
    #[test]
    fn retirement_before_delayed_select_is_permanent_and_unrelated_selection_survives() {
        let f = Fixture::new();
        f.retire(ID).unwrap();
        assert!(f
            .owner
            .select(f.path.clone(), ID, LEASE, &f.profile)
            .is_err());
        assert!(f
            .owner
            .select(f.path.clone(), OTHER, LEASE, &f.profile)
            .is_ok());
        f.owner.stop().unwrap();
        assert!(f
            .owner
            .invoke(
                "host.attachment.selection.read",
                &json!({"selectionId":OTHER,"leaseId":LEASE,"offset":0,"length":3}),
                || Ok(())
            )
            .is_err());
        f.retire(OTHER).unwrap();
        assert!(f.owner.0.lock().unwrap().entries.is_empty());
    }
    #[test]
    fn bounds_chunks_metadata_and_total_id_history() {
        let f = Fixture::new();
        let selected = f.select();
        for value in [
            json!({"selectionId":ID,"leaseId":LEASE,"offset":0,"length":65537}),
            json!({"selectionId":ID,"leaseId":LEASE,"offset":0,"length":0}),
            json!({"selectionId":ID,"leaseId":LEASE,"offset":0,"length":3,"path":"/etc/passwd"}),
        ] {
            assert!(!request("host.attachment.selection.read", &value));
        }
        assert!(!offer(
            &json!({"leaseId":LEASE,"selections":[selected.clone(),selected]})
        ));
        for i in 0..4096 {
            f.owner.0.lock().unwrap().used.insert(format!("used-{i}"));
        }
        assert!(f
            .owner
            .select(f.path.clone(), OTHER, LEASE, &f.profile)
            .is_err());
    }
}
