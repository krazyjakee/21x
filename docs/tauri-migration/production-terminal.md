# Production terminal domain

This is scoped #214/#202 implementation. It does not change shipping Electron
defaults, authorize a live-profile cutover, or establish installed OS parity.
The native production owner must supply its actual staged, ABI-matched
`node-pty` host and retain that one `TerminalServiceCore` through shutdown.
The backend never creates another process runtime or falls back to a fake PTY.

The [2026-10-17 streaming continuation](terminal-streaming-recovery.md) fixes
logical recent-text recovery across callback/escape boundaries, returns a
bounded recent suffix for oversized text, and retires native subscriptions at
actual exit. Its evidence supersedes the earlier unexecuted-check note below
for that tested scope; installed platform acceptance remains open.

## Exact API and owner

`src/service/terminal-backend.ts` binds the six existing APIs: create, write,
resize, kill, getCwd and getBuffer. Create returns the actual `{pid}`; cwd and
buffer preserve their existing shapes. Write, resize and kill return void.
A failed underlying write is an explicit failure rather than a successful void
reply. Data and exit use the existing `{id,data}` and `{id}` event shapes.

Every request requires the trusted current engine epoch, desktop principal,
WebView and origin. These are host-established identities, never payload
fields. Mandatory terminal read/write authority is checked before effects and
again before returning results. Each ID remains associated with its original
caller, including after exit; another caller cannot claim a closed ID, replace
a live process, read its buffer or move its event sink.

A repeated create from the same caller attaches the current owned process and
changes its dimensions without spawning or writing input. A foreign current or
retiring ID is refused. Internal process generations fence delayed cwd results,
kill receipts and replacement handles, including when native PIDs are equal.
The public API has only `expectedPid`, so a newly spawned process reusing a
previous PID for that same ID is conservatively refused and retired; it is
never returned as an accepted replacement. No virtual PID is invented. At most
256 terminal IDs and 256 historical PIDs per ID are retained per backend epoch;
exhaustion rejects allocation instead of forgetting stale authority.

## Directory and process boundaries

The owner supplies `resolveDirectory(id,caller)` with the actual authorized
workspace/repository cwd and root. Requests cannot choose a shell, environment,
project grant, PID, generation or filesystem root. A requested cwd, when
present, must canonicalize to that selected cwd. Root and cwd must be existing
absolute directories, and their canonical paths must show containment. The
checks repeat after creation; failure retires the captured new process. A raw
cwd probe is exposed only when its actual process generation is still current
and its canonical directory remains within the authorized root.

These checks reject traversal and existing symlink escapes. They do not claim
atomic directory handles against an adversary replacing directories between
filesystem checks and native spawn. A terminal is an interactive shell under
the user's OS account, not a filesystem sandbox; cwd read/start authority is
not a claim that shell commands cannot change directory.

Kill waits on `TerminalServiceCore.killAcknowledged` for the exact PID and
generation's actual native `onExit` receipt. Repeated pending kills join that
same receipt. Stale PIDs do not kill the new process. The backend emits exit
once after natural native close or the acknowledged explicit kill, never on
kill intent. Cancellation or a lost response does not replay accepted input,
create another shell, redirect a kill, or abandon the raw work.

## Output and replay bounds

`src/shared/terminal-desktop-codecs.ts` supplies exact command/result/event
schemas. Unknown identity and process fields, byte objects and unsupported
shapes are refused. Control characters and Unicode remain actual terminal
data; neither commands nor output are sanitized into different contents.

| Surface | Bound |
| --- | --- |
| Terminal ID | 256 characters |
| Directory path | 4 KiB UTF-8 |
| Input write | 64 KiB UTF-8 |
| One data event | 16 KiB UTF-8 |
| One observed process callback | 4 MiB UTF-8 |
| Buffer read | 500 lines, 512 KiB encoded JSON |
| Dimensions | 1–4096 columns/rows |

Large source callbacks are split into bounded events without splitting a
Unicode pair or changing byte order. Publication is synchronous admission to
the separately bounded production transport, not proof of WebView consumption.
Overflow or publication failure latches admission and retires owned processes;
it does not silently continue dropping output. A delivered prefix may exist
before failure, so it is not presented as complete output or automatically
replayed. This implementation does not expose a generic stream opener or
namespace grant. Native FD3/Rust terminal streaming remains separate work.

GetBuffer reads the core's existing bounded, ANSI-stripped recent text lines,
not a raw xterm screen or a complete terminal archive. An oversized native
reply fails without silently truncating that stored buffer. Reconnect requires
the renderer to subscribe before creation and explicitly read getBuffer; the
legacy `{pid}` reply cannot itself restore screen contents or guarantee that
early process output was observed by a late listener.

## Shutdown and evidence

The backend retains raw cwd reads and acknowledged kill work even after a
request is cancelled. Its close deadline reports incomplete shutdown while a
native receipt or raw probe is pending. ProductionOwner must also close/join
the actual TerminalServiceCore, native process host and service transport
before releasing its profile resources. Hiding or navigating a window alone
does not destroy backend ownership. Explicit panel cleanup remains an explicit
kill. Service crash recovery cannot attach a process by guessing an old PID.

The new codec tests cover all six shapes, bounds, control data and void/null
semantics. Backend tests use the actual core with controlled process callbacks
and real temporary directories. They cover canonical/symlink containment,
foreign live/retiring IDs, same-PID reuse, actual close receipts, reconnect,
late cwd, output sequence, publication failure, response cancellation and raw
shutdown ownership. These are controlled lifecycle tests, not real PTY, CLI,
process-tree, keyboard/focus or installed-platform evidence.

The implementing worker ran no checks. The coordinator should run the two new
test files in application and standalone configurations, typecheck/lint/build,
then the actual staged-PTY wire proof with an isolated profile. Installed
hidden-window continuation, service crash/reconnect, native input/focus,
throughput/backpressure and clean process-tree shutdown on each supported OS
remain evidence gates. #214/#202 remain open.
