//! Windows production containment. The process is assigned to an unnamed,
//! non-inheritable kill-on-close Job in CreateProcess itself (Windows 10+).
//! There is no post-spawn attach interval and no inherited Job authority.
use super::{problem, EngineError, DEADLINE};
use std::{
    ffi::OsStr,
    mem::{size_of, zeroed},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr::{null, null_mut},
    sync::Arc,
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{
        SetHandleInformation, GENERIC_READ, GENERIC_WRITE, HANDLE, HANDLE_FLAG_INHERIT,
        INVALID_HANDLE_VALUE, WAIT_FAILED, WAIT_OBJECT_0,
    },
    Security::SECURITY_ATTRIBUTES,
    Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    },
    System::{
        JobObjects::{
            CreateJobObjectW, IsProcessInJob, JobObjectBasicAccountingInformation,
            JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
            TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Pipes::GetNamedPipeClientProcessId,
        Threading::{
            CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcessId,
            InitializeProcThreadAttributeList, UpdateProcThreadAttribute, WaitForSingleObject,
            CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT,
            LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            PROC_THREAD_ATTRIBUTE_JOB_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
        },
    },
};

fn failure(phase: &'static str) -> EngineError {
    problem("PRODUCTION_CONTAINMENT_UNAVAILABLE", phase)
}
fn handle(raw: HANDLE, phase: &'static str) -> Result<OwnedHandle, EngineError> {
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(failure(phase));
    }
    // Each successful native creation transfers exactly one new handle here.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}
fn wide(value: &OsStr) -> Result<Vec<u16>, EngineError> {
    let mut value: Vec<u16> = value.encode_wide().collect();
    if value.contains(&0) {
        return Err(failure("production-windows-argument"));
    }
    value.push(0);
    Ok(value)
}
fn argument(value: &OsStr) -> Result<Vec<u16>, EngineError> {
    let input = wide(value)?;
    let mut out = vec![b'"' as u16];
    let mut slashes = 0;
    for unit in input.into_iter().take_while(|unit| *unit != 0) {
        if unit == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        out.extend(std::iter::repeat_n(
            b'\\' as u16,
            if unit == b'"' as u16 {
                slashes * 2 + 1
            } else {
                slashes
            },
        ));
        out.push(unit);
        slashes = 0;
    }
    out.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    out.push(b'"' as u16);
    Ok(out)
}
fn environment() -> Result<Vec<u16>, EngineError> {
    // No Electron/Node injection aliases, tokens or arbitrary inherited state.
    let mut entries = Vec::new();
    for key in [
        "APPDATA",
        "COMSPEC",
        "HOME",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "USER",
        "USERNAME",
        "USERPROFILE",
        "WINDIR",
    ] {
        if let Some(value) = std::env::var_os(key) {
            let mut entry = std::ffi::OsString::from(key);
            entry.push("=");
            entry.push(value);
            entries.extend(wide(&entry)?);
        }
    }
    entries.push(0);
    if entries.len() == 1 {
        entries.push(0);
    }
    Ok(entries)
}

struct Attributes {
    allocation: Vec<usize>,
    initialized: bool,
}
impl Attributes {
    fn new() -> Result<Self, EngineError> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes);
        }
        if bytes == 0 || bytes > 65536 {
            return Err(failure("production-windows-attributes"));
        }
        let mut value = Self {
            allocation: vec![0; bytes.div_ceil(size_of::<usize>())],
            initialized: false,
        };
        if unsafe { InitializeProcThreadAttributeList(value.as_ptr(), 2, 0, &mut bytes) } == 0 {
            return Err(failure("production-windows-attributes"));
        }
        value.initialized = true;
        Ok(value)
    }
    fn as_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.allocation.as_mut_ptr().cast()
    }
    fn add(&mut self, attribute: usize, handles: &[HANDLE]) -> Result<(), EngineError> {
        if unsafe {
            UpdateProcThreadAttribute(
                self.as_ptr(),
                0,
                attribute,
                handles.as_ptr().cast(),
                std::mem::size_of_val(handles),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(failure("production-windows-attributes"));
        }
        Ok(())
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                DeleteProcThreadAttributeList(self.as_ptr());
            }
        }
    }
}
async fn pipe(
    parent_reads: bool,
    name: &str,
) -> Result<
    (
        tokio::net::windows::named_pipe::NamedPipeServer,
        OwnedHandle,
    ),
    EngineError,
> {
    use tokio::net::windows::named_pipe::{PipeMode, ServerOptions};
    let server = ServerOptions::new()
        .pipe_mode(PipeMode::Byte)
        .access_inbound(parent_reads)
        .access_outbound(!parent_reads)
        .first_pipe_instance(true)
        .max_instances(1)
        .reject_remote_clients(true)
        .create(name)
        .map_err(|_| failure("production-windows-private-pipe"))?;
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let name = wide(OsStr::new(name))?;
    let client = handle(
        unsafe {
            CreateFileW(
                name.as_ptr(),
                if parent_reads {
                    GENERIC_WRITE
                } else {
                    GENERIC_READ
                },
                0,
                &security,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            )
        },
        "production-windows-private-pipe",
    )?;
    tokio::time::timeout(DEADLINE, server.connect())
        .await
        .map_err(|_| failure("production-windows-private-pipe"))?
        .map_err(|_| failure("production-windows-private-pipe"))?;
    let mut client_pid = 0;
    if unsafe { GetNamedPipeClientProcessId(server.as_raw_handle(), &mut client_pid) } == 0
        || client_pid != unsafe { GetCurrentProcessId() }
    {
        return Err(failure("production-windows-private-pipe-owner"));
    }
    if unsafe { SetHandleInformation(server.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(failure("production-windows-private-pipe"));
    }
    // One already-connected local instance, exact host-opened client handle.
    // Never disconnect/reaccept. No name is sent to the child or renderer.
    Ok((server, client))
}

pub(super) struct Scope {
    job: OwnedHandle,
    process: OwnedHandle,
}
pub(super) struct Spawned {
    pub(super) scope: Arc<Scope>,
    pub(super) stdin: tokio::net::windows::named_pipe::NamedPipeServer,
    pub(super) stdout: tokio::net::windows::named_pipe::NamedPipeServer,
}
impl Scope {
    pub(super) fn contains(&self, process: &OwnedHandle) -> Result<bool, EngineError> {
        let mut included = 0;
        if unsafe {
            IsProcessInJob(
                process.as_raw_handle(),
                self.job.as_raw_handle(),
                &mut included,
            )
        } == 0
        {
            return Err(failure("production-windows-job-observation"));
        }
        Ok(included != 0)
    }
    pub(super) fn active(&self) -> Result<u32, EngineError> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        if unsafe {
            QueryInformationJobObject(
                self.job.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            )
        } == 0
        {
            return Err(failure("production-windows-job-observation"));
        }
        Ok(info.ActiveProcesses)
    }
    pub(super) fn alive(&self) -> Result<bool, EngineError> {
        match unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) } {
            WAIT_OBJECT_0 => Ok(false),
            WAIT_FAILED => Err(failure("production-windows-process-observation")),
            _ => Ok(true),
        }
    }
    pub(super) fn prove_ready(&self) -> Result<(), EngineError> {
        if self.active()? != 1 || !self.alive()? || !self.contains(&self.process)? {
            return Err(failure("production-windows-job-readiness"));
        }
        Ok(())
    }
    pub(super) async fn await_leader_only(&self) -> Result<(), EngineError> {
        tokio::time::timeout(DEADLINE, async {
            loop {
                if !self.alive()? {
                    return Err(failure("production-windows-job-drain"));
                }
                if self.active()? == 1 {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .map_err(|_| failure("production-windows-job-drain"))?
    }
    pub(super) async fn finish(&self) -> Result<(), EngineError> {
        if self.active()? != 0 && unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) } == 0 {
            return Err(failure("production-windows-job-stop"));
        }
        tokio::time::timeout(DEADLINE, async {
            while self.active()? != 0 || self.alive()? {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Ok(())
        })
        .await
        .map_err(|_| failure("production-windows-job-stop"))?
    }
}

pub(super) async fn spawn(
    node: &Path,
    entry: &Path,
    cwd: &Path,
    launch_id: &str,
) -> Result<Spawned, EngineError> {
    if !super::token(launch_id, 1, 128, false) {
        return Err(failure("production-windows-private-pipe"));
    }
    let job = handle(
        unsafe { CreateJobObjectW(null(), null()) },
        "production-windows-job-create",
    )?;
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(failure("production-windows-job-limits"));
    }
    let (stdin, child_in) = pipe(false, &format!(r"\\.\pipe\21x-private-{launch_id}-in")).await?;
    let (stdout, child_out) = pipe(true, &format!(r"\\.\pipe\21x-private-{launch_id}-out")).await?;
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let nul = wide(OsStr::new("NUL"))?;
    let child_err = handle(
        unsafe {
            CreateFileW(
                nul.as_ptr(),
                GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                &security,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            )
        },
        "production-windows-private-stderr",
    )?;
    let inherited = [
        child_in.as_raw_handle(),
        child_out.as_raw_handle(),
        child_err.as_raw_handle(),
    ];
    let jobs = [job.as_raw_handle()];
    let mut attributes = Attributes::new()?;
    // Values outlive the attribute list. The Job handle itself is never inherited.
    attributes.add(PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, &inherited)?;
    attributes.add(PROC_THREAD_ATTRIBUTE_JOB_LIST as usize, &jobs)?;
    let application = wide(node.as_os_str())?;
    let directory = wide(cwd.as_os_str())?;
    let mut command = argument(node.as_os_str())?;
    command.push(b' ' as u16);
    command.extend(argument(entry.as_os_str())?);
    command.push(0);
    let environment = environment()?;
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = child_in.as_raw_handle();
    startup.StartupInfo.hStdOutput = child_out.as_raw_handle();
    startup.StartupInfo.hStdError = child_err.as_raw_handle();
    startup.lpAttributeList = attributes.as_ptr();
    let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
    if unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            environment.as_ptr().cast(),
            directory.as_ptr(),
            &startup.StartupInfo,
            &mut info,
        )
    } == 0
    {
        return Err(failure("production-windows-atomic-job-launch"));
    }
    let process = handle(info.hProcess, "production-windows-owned-process")?;
    let _thread = handle(info.hThread, "production-windows-owned-thread")?;
    let scope = Arc::new(Scope { job, process });
    // Parent endpoints use cancellable IOCP operations, never blocking fs reads.
    Ok(Spawned {
        scope,
        stdin,
        stdout,
    })
}
