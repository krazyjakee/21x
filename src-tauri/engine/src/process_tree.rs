//! Ownership is explicit; no executable-name or unowned-PID termination.
use std::{io, time::Duration};
use tokio::{
    process::{Child, Command},
    sync::watch,
    time::{sleep, timeout, Instant},
};

pub(crate) fn configure(command: &mut Command) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let parent = std::process::id() as libc::pid_t;
        // Only async-signal-safe syscalls run between fork and exec. Check the
        // parent again because it might have died before prctl was installed.
        unsafe {
            command.as_std_mut().pre_exec(move || {
                if libc::prctl(
                    libc::PR_SET_PDEATHSIG,
                    libc::SIGTERM as libc::c_ulong,
                    0 as libc::c_ulong,
                    0 as libc::c_ulong,
                    0 as libc::c_ulong,
                ) != 0
                {
                    return Err(io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    return Err(io::Error::from_raw_os_error(libc::ESRCH));
                }
                Ok(())
            });
        }
    }
    Ok(())
}

#[cfg(unix)]
struct Tree {
    pid: libc::pid_t,
    armed: bool,
}

#[cfg(unix)]
impl Tree {
    fn attach(child: &Child) -> io::Result<Self> {
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("owned child unavailable"))?;
        Ok(Self {
            pid: pid as libc::pid_t,
            armed: true,
        })
    }

    fn leader_exited(&mut self, _child: &Child) -> io::Result<bool> {
        let mut status = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        // WNOWAIT observes death while reserving the leader PID. Never signal a
        // group after reaping its leader: the identifier could have been reused.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                self.pid as libc::id_t,
                status.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT | libc::WNOHANG,
            )
        };
        if result != 0 {
            self.armed = false; // Another reaper invalidated our PID authority.
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { status.assume_init() }.si_signo == libc::SIGCHLD)
    }

    fn graceful(&self) {
        if self.armed {
            unsafe {
                libc::kill(-self.pid, libc::SIGTERM);
            }
        }
    }

    fn force(&mut self) {
        if self.armed {
            unsafe {
                libc::kill(-self.pid, libc::SIGKILL);
            }
            self.armed = false;
        }
    }
}

#[cfg(unix)]
impl Drop for Tree {
    fn drop(&mut self) {
        self.force();
    }
}

#[cfg(windows)]
struct Tree {
    job: std::os::windows::io::OwnedHandle,
}

#[cfg(windows)]
impl Tree {
    fn attach(child: &Child) -> io::Result<Self> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle};
        use windows_sys::Win32::System::JobObjects::*;
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // Unnamed and non-inheritable: host death closes the final Job handle.
        let job = unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle) };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if configured == 0 {
            return Err(io::Error::last_os_error());
        }
        let process = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("owned child unavailable"))?;
        if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { job })
    }

    fn leader_exited(&mut self, child: &Child) -> io::Result<bool> {
        use windows_sys::Win32::{
            Foundation::{WAIT_FAILED, WAIT_OBJECT_0},
            System::Threading::WaitForSingleObject,
        };
        let handle = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("owned child unavailable"))?;
        match unsafe { WaitForSingleObject(handle, 0) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            _ => Ok(false),
        }
    }

    fn graceful(&self) {} // The private shutdown request supplied the grace period.

    fn force(&mut self) {
        use std::os::windows::io::AsRawHandle;
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job.as_raw_handle(), 1);
        }
    }
}

// Field order closes/kills the tree before Child drop can enqueue a Unix reap.
pub(crate) struct OwnedChild {
    tree: Tree,
    child: Child,
}

impl OwnedChild {
    pub(crate) fn attach(mut child: Child) -> io::Result<Self> {
        let tree = match Tree::attach(&child) {
            Ok(tree) => tree,
            Err(error) => {
                let _ = child.start_kill();
                return Err(error);
            }
        };
        Ok(Self { tree, child })
    }

    pub(crate) async fn supervise(mut self, mut stop: watch::Receiver<bool>) -> bool {
        loop {
            if *stop.borrow() || self.tree.leader_exited(&self.child).unwrap_or(true) {
                break;
            }
            tokio::select! { _ = stop.changed() => break, _ = sleep(Duration::from_millis(100)) => {} }
        }
        self.tree.graceful();
        let grace = Instant::now() + Duration::from_secs(1);
        while Instant::now() < grace && !self.tree.leader_exited(&self.child).unwrap_or(true) {
            sleep(Duration::from_millis(25)).await;
        }
        // Force all still-owned descendants before the leader's PID is released.
        self.tree.force();
        let _ = self.child.start_kill();
        matches!(
            timeout(Duration::from_secs(2), self.child.wait()).await,
            Ok(Ok(_))
        )
    }
}

pub(crate) fn ownership_mode() -> &'static str {
    #[cfg(windows)]
    {
        "windows-job-kill-on-close"
    }
    #[cfg(target_os = "linux")]
    {
        "unix-process-group-linux-parent-death-signal"
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        "unix-process-group-cooperative-parent-loss"
    }
}

// Observation only: tests never signal an unrelated PID or kill by process name.
#[cfg(all(test, feature = "native-fixture-tests", unix))]
pub(crate) fn test_process_running(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    if let Ok(status) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        if status
            .rsplit_once(") ")
            .is_some_and(|(_, fields)| fields.starts_with('Z'))
        {
            return false; // Exited orphan awaiting init reap is not a running process.
        }
    }
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(all(test, feature = "native-fixture-tests", windows))]
pub(crate) fn test_process_running(pid: u32) -> bool {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::WAIT_OBJECT_0,
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return false;
    }
    let process = unsafe { OwnedHandle::from_raw_handle(handle) };
    unsafe { WaitForSingleObject(process.as_raw_handle(), 0) != WAIT_OBJECT_0 }
}
