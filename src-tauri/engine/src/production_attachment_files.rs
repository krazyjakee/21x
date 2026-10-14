//! Attachment receipts remain observations. A separately captured native root
//! authorizes only a literal saved task/UUID/filename namespace, never a path RPC.
use crate::{
    production::contracts::{attachment_filename, attachment_uuid, id, object},
    production_files::{
        NativeWorkspaceFileGuard, NativeWorkspaceFileOwner, NativeWorkspaceReceipt,
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
#[derive(Clone, Debug)]
pub struct NativeAttachmentReceipt {
    workspace: NativeWorkspaceReceipt,
}
impl NativeAttachmentReceipt {
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
        Ok(Self { workspace })
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
    pub fn path(&self) -> &Path {
        self.guard.path()
    }
    pub fn recheck(&self) -> Result<(), EngineError> {
        self.guard.recheck().map_err(workspace_error)
    }
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
