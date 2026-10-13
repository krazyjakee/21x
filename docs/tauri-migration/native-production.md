# Opt-in native production launcher

The engine's `production-service` feature exposes `production::ProductionEngine`.
It is separate from the diagnostic/synthetic engine and does not change the
Electron entry, default Tauri configuration or ordinary profile selection.
The trusted host constructs `TrustedProductionLaunch`; this lease is not a
serialized renderer command.

The launch contains a typed `ProductionDescriptor` with the six explicit
profile/workspace/attachment/repository/resource/temp paths, exact launch and
profile IDs, `CreateNew` or `LoadAuthenticatedCopy` intent, build identity,
resource-manifest digest and capability choices. It contains no key, token,
environment map, executable override or process ID. The resource gate verifies
the pinned manifest and each recorded physical file before launching its exact
Node and thin stdio entry. Writable paths must be separate from resources.
The authenticated Node gate then verifies the actual runtime/platform/ABI
preparation, pinned SDK packages and complete physical package closure before
loading SQLite and vendor code.

Linux requires `DelegatedCgroup::open` on a host-established, actually delegated
cgroup-v2 directory. A normal filesystem containing similarly named files is
insufficient. The launcher atomically creates an exclusive launch cgroup,
opens its kernel interfaces and proves `cgroup.kill` on the initially empty
scope. Node joins through a pre-opened `cgroup.procs` descriptor in `pre_exec`,
before any Node/SDK/helper code runs. `setsid`, double-forking and PTY process
groups do not remove descendants from that cgroup. This is process ownership
and cleanup containment, not a filesystem or adversarial-code sandbox.

A native guardian is forked outside the Node scope before Node starts. All
descriptor values are prepared before `fork`. Its child path uses only syscalls:
it duplicates the private parent-loss, bound `cgroup.kill` and readiness pipes;
closes unrelated inherited descriptors with `close_range`; writes the actual
readiness byte; waits for parent-pipe EOF; writes the bound kill interface and
exits with `_exit`. It performs no Rust allocation, logging, locking, unwinding
or destructors. A returned fork PID alone is not a readiness acknowledgement.
The parent requires the private readiness byte and a live unreaped guardian
receipt. The guardian never receives arbitrary PIDs, executable names, paths
or kill operations from RPC.

The guardian's parent-loss writer and original descriptor-pipe ends are
`CLOEXEC`. Only the Node child receives the actual anonymous descriptor reader
as FD3. No SDK/helper can inherit the guardian writer after `exec`, so those
children cannot keep it alive after native host death. FD3 closes after the
bounded descriptor is consumed. The Node process has private stdin/stdout,
no credential environment and only the reviewed OS/keychain environment names.
Native startup awaits `engine.ping` first, stores the exact returned epoch, and
only then sends `engine.initialize`. Native callbacks during initialization
must already carry that negotiated epoch.

`host.production.prepare` accepts only the exact launch ID and pinned manifest
digest. It proves the live unreaped Node/guardian receipts, exact Node membership
and guardian exclusion from the Node cgroup before acknowledging
`{launchId,ready:true,processTree:'supervised'}`. Unsupported containment fails
before protected-key/profile application initialization.

`host.production.drain` accepts only the exact launch ID. It fences native
commands, retains outstanding native callbacks, and waits for recursive cgroup
membership to contain only the owned Node leader. It does not signal arbitrary
members or kill the still-running application to manufacture a drain receipt.
Detached descendants and populated nested cgroups block this acknowledgement.
Only genuine leader-only membership permits `{launchId,acknowledged:true}`;
the Node owner then closes its database, protected storage and profile lease.

Orderly shutdown subsequently waits for real process-tree exit. Trusted
application-exit escalation uses `terminate_owned`: it kills the exact bound
cgroup, waits for its recursive population to become empty, closes and joins
the actual guardian, removes only empty owned cgroup directories, and reaps the
owned Node child. Failed cleanup keeps the scope, child and guardian owned and
publishes no successful exit receipt. Shutdown returns a useful blocked error
on its deadline; raw cleanup remains retained. Escalation is a native lifetime
operation and never becomes an arbitrary process-termination desktop command.
Neither failure nor disconnect automatically replays an accepted mutation.

`production_contracts.rs` enumerates the reviewed production commands and
events independently of diagnostic grants. It validates bounded frames,
exact operation-specific argument fields, explicit optional-result envelopes,
image byte envelopes, terminal dimensions/byte limits, settings keys and
masked metadata. The Node production domain codecs validate complete DTOs and
actual task/project/agent/session/request ownership again. Unknown operations,
bootstrap fields, epoch changes, duplicate callback IDs, regressing event
sequences and unreviewed events fail closed. A domain addition requires updating
both finite contracts; there is no namespace grant. Native Tauri ingress must
still authorize the actual main WebView label, origin and frame before invoking
the private production engine. A terminal's optional expected-PID field is an
equality guard on its exact owned terminal ID, never native kill authority.

External URL and notification callbacks are optional typed host functions;
declaring them supported without supplying a real function rejects startup.
Energy, UI and voice capability variants remain explicitly unsupported here.
Native callback work remains retained even when the service cancels its reply.
The launcher exposes availability, preparation/drain acknowledgements, pending
native callback count and actual tree-exit state without exposing process IDs.

Windows is explicitly unavailable because this slice does not implement a
genuinely inherited extra FD3 descriptor together with a pre-execution Job
assignment. The diagnostic Job wrapper is not borrowed as production proof.
macOS/other Unix platforms are explicitly unavailable because process groups
alone do not contain detached descendants. Neither platform silently selects a
weaker backend. The Linux slice requires actual delegation permissions and
kernel `cgroup.kill`/`close_range` support; unavailable hosts receive a concrete
containment/startup phase instead of a fabricated acknowledgement.

Ordinary module tests cover exact descriptors, private anonymous/CLOEXEC pipe
properties, lookalike delegation rejection, resource tampering and finite wire
contracts. The explicitly ignored physical cgroup fixture requires
`TWENTYONEX_TEST_DELEGATED_CGROUP` and Linux `setsid`; it checks that a detached
controlled descendant blocks drain and that only the owned cgroup cleanup kills
and reaps the fixture tree and guardian. Synthetic resource bytes are never
executed. These tests are not installed Tauri, keychain, SDK/CLI or cross-platform
acceptance evidence. The separate opt-in native main/feature wiring is present;
the actual delegated platform fixture and installed validation remain acceptance
requirements.

The separate `production_host.rs` entry and `tauri.production.conf.json` connect
the engine to the full production renderer. Native ingress checks the exact
main label and packaged origin (development uses only localhost port 1421),
wraps replies with the current epoch and targets events to that WebView.
`build.rs` embeds the staged manifest digest and build identity into the native
binary. Runtime launch compares against those compiled values before verifying
the physical closure; a replaced manifest cannot authorize itself merely by
containing newly computed file hashes.

The preview creates a fresh isolated profile under its separate application
identifier. It never imports Electron data or selects a profile through IPC.
After explicit native dependency preparation and credential-helper staging,
`pnpm tauri:production:dev` or `pnpm tauri:production:build` selects this feature
and configuration. `TWENTYONEX_PRODUCTION_CGROUP_ROOT` supplies the trusted native
provisioning path to a real delegated Linux cgroup-v2 directory, not a renderer
setting. Missing delegation yields an unavailable `engine_status` with a fixed
startup code/phase before Node, key-store or application-profile initialization.
The unavailable window remains inspectable; relaunch follows provisioning.
Windows/macOS containment and installed application acceptance remain open.
