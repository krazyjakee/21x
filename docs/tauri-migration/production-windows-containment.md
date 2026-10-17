# Windows production containment and private bootstrap

The opt-in production native path now selects a Windows Job Object. Linux keeps
its delegated cgroup-v2/guardian path. macOS still refuses production launch:
no accepted detached-descendant containment backend is implemented. This is
source and cross-compilation progress; no Windows runtime or installed preview
acceptance is claimed.

The unnamed Job handle is non-inheritable and configured with kill-on-last-close.
`CreateProcessW` receives both `PROC_THREAD_ATTRIBUTE_JOB_LIST` and an exact
`HANDLE_LIST`. Assignment occurs during process creation, before the initial
thread can run. There is no spawn-then-assign interval. No breakaway limit or
breakaway process flag is granted. Windows 10/Server 2016 or newer is needed for
this API; unavailable policy/API/nested-job assignment refuses before Source
profile/key startup. Supported platform minimums still require G0 acceptance.
See Microsoft's [process creation attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
and [Job lifecycle contract](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

Native opens and connects each local byte pipe itself, before starting the
child. Each has one instance, first-instance protection and remote clients
refused. Native verifies the connected client's process identity is this host,
then inherits only the exact stdin/stdout/null-stderr client handles. The parent
endpoints remain non-inheritable. Pipe names never enter argv, environment,
renderer messages or descriptor fields; servers never disconnect/reaccept.
A namespace race fails closed. Parent endpoints use Tokio's asynchronous
Windows pipe type and IOCP; generic blocking filesystem wrappers are avoided.
See [Tokio Windows named pipes](https://docs.rs/tokio/1.53.2/tokio/net/windows/named_pipe/index.html).

Windows sends one bounded descriptor JSON line on the private stdin channel
before ordinary RPC. The descriptor carries the existing manifest pin, paths
and explicit host capabilities; no credentials or public caller selection is
added. Source preserves every byte after the first newline for the peer and
retains the stream. Its strict descriptor/resource/runtime verification still
precedes engine/native-addon loading. Linux's separate anonymous fd3 descriptor
channel is unchanged. The child environment is a fixed native whitelist;
Node/Electron injection flags and inherited API tokens do not enter it.

Both launchers share epoch negotiation, one initialization attempt and finite
failure observation. Existing optional OAuth fields, native authority and
callback routes are preserved. The production OAuth browser and OS scheme
registration remain unavailable; app identity is unchanged.
The serialized #215 integration installs its published single-instance plugin
first on Linux and rejects bounded cold callback arguments after authority
construction. Windows and macOS do not install that plugin.

Native readiness and drain observe the exact owned process handle and Job
accounting. Drain acknowledges only a living leader with no other Job member;
normal final retirement terminates the Job and waits for zero active members
and leader exit before an exit receipt. Failed observation/retirement retains
those handles and retries. Host death closes the last Job handle. No saved PID,
process-name scan, `taskkill` or unrelated process selection authorizes cleanup.

Eight Source tests cover all descriptor split offsets, UTF-8 splits, the exact
byte limit, pipelined RPC preservation, malformed/oversized/early-EOF/error input
and listener retirement. A real child running the staged Node on Linux also
preserves the pipelined bytes on inherited stdin and closes cleanly, without
starting any database/credential owner. A Windows-only synthetic executable fixture uses the
same native implementation to check normal drain, last-handle closure, a
new detached descendant, blocked leader-only acknowledgement and survival of
an unrelated process. Its runtime command is:

```powershell
$env:TWENTYONEX_TEST_NODE = '<absolute staged Node 22.23.2 node.exe>'
cargo run --locked --manifest-path src-tauri/Cargo.toml -p twentyonex-engine --features production-service --example windows-production-containment
```

The [revision-bound evidence](evidence/issue-closing-20261017-windows-containment.json)
records exactly which checks ran and which could not. Cross-checking the engine
and fixture does not execute Win32 APIs, prove Windows pipe/Node behavior or
establish a working installed production host. Windows/macOS runtime hardware
is unavailable here, and hosted Verify/platform execution is unavailable while
repository Actions is disabled, awaiting user decision. No workflow dispatch
or settings endpoint is used. macOS containment and all remaining #208/#202
platform acceptance stay open. No release, live-profile/data cutover, Electron
retirement or hosted voice change is authorized.
