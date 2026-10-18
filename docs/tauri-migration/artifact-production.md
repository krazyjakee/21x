# Retained production artifact reads

`ArtifactBackend` binds the two existing `artifacts:scan` and `artifacts:read`
controls to the application's actual DatabaseManager and artifact functions.
The root owner provides its captured workspace root, profile/owner assertion and
current trusted WebView/origin/epoch/task/project grants. Registration alone does
not authorize a read. No RPC accepts a filesystem root or absolute path.

The selected task must already exist. Reads derive the literal
`workspaceRoot/taskId` path without calling DatabaseManager's directory-creating
getter. Missing workspaces return the existing empty scan/null read results.
Repository worktrees remain physical children of this workspace. Task role,
project, repository declarations, session binding, project repositories, group
membership and execution-anchor bindings are captured and rechecked while work
runs and before results leave the owner. Group member artifacts stay in their
existing member directory; no alias/migration to the anchor is invented. Current
members and anchor require their own read grants. Reading retained anchor history
also requires the represented former members' grants; unresolved or oversized
history is refused without deleting stored artifacts.

The parent workspace root and selected task directory have captured filesystem
identities. Replacement, symlinked roots, ancestor/leaf symlinks or scope changes
cannot retarget an accepted read. Strict reads open with no-follow where supported,
compare the opened inode/device with the captured file, read bounded chunks,
recheck identity and size, and retain the descriptor through actual close.
Directory scans use bounded directory handles, skip dependencies/generated files,
and examine at most 4096 entries at depth ten. Scans and registries contain at most
500 artifact files. Capacity exhaustion is explicit rather than a complete-looking
truncated projection. Registry bytes are bounded before JSON parsing; malformed,
foreign-task or unsafe registry paths confer no binary read authority.

The current private transport permits a 1 MiB frame. Portable text previews are
limited to 128 KiB physical bytes and image/registered binary previews to 512 KiB.
Complete serialized results must remain below 900000 bytes, including base64,
escaping, metadata and supporting file lists. Larger otherwise previewable files
raise `FRAME_TOO_LARGE`; unsupported formats retain the existing null result.
Their contents and metadata remain untouched. Electron retains its 1 MiB text /
10 MiB image reader limits. Larger portable previews need a separate reviewed
transport contract; these controls do not open a generic byte stream.

HTML, SVG, Markdown, code, YAML and binary content cross only as finite data DTOs.
They grant no native viewer, privileged WebView, iframe, event namespace, arbitrary
resource path or OS open/copy/download capability. Production sandboxed viewer
integration and hostile native navigation/command tests are separate #217 gates.
The native app presents an unavailable HTML preview before reading content or
creating an iframe; Electron's existing HTML preview is unchanged. An explicitly
granted raw HTML read remains data, with no active native preview isolation claim.
Attachment pick/save/open/copy/download and removal are not added by this binding.

Abort and shutdown withdraw admission, then retain raw filesystem promises until
their actual handles close. A public shutdown deadline can fail; the host must
keep its database/profile lease and retry the drain before releasing them. Reads
are rehydration operations, with no uncertain mutation replay or callback owner
created for unsupported operations. Scanning never navigates saved browser panels,
replays recordings, changes canvas state or removes rollback/retired data.

Authored regressions use real portable SQLite, actual registry/filesystem trees
and opened file/directory handles with controlled close boundaries. They cover
current grants, group/member/anchor history, revocation and late binding changes,
path/identity swaps, oversized registries/content, physical containment, cancellation
and retained inactive data. These are scoped source tests, not installed/native
WebView, live SDK, OS device, renderer drag/drop, platform or release evidence.
#217/#214 remain open for their unproved production viewer/attachment/platform
criteria. No live user profile, release or data cutover is involved.

## Optional private viewer consumer

`ArtifactViewerOwner` is a Source SDK with optional sealed private native authority.
The Linux production launch can capture this authority alongside its physical
UI owner; public desktop/renderer/stdio viewer operations remain unregistered.
Without a captured native bridge it refuses before a file
read, lease allocation or observer callback. Its API accepts task ID, relative
HTML path and the captured trusted caller. It never accepts renderer-provided
HTML. The actual `ArtifactBackend.captureViewerSnapshot` obtains the immutable
UTF-8 snapshot through its normal bounded registry/read owner, retains raw read
closure, and captures the original task/project/group/workspace identity and
read grants. A snapshot is data, with no live file/resource namespace.

The private v1 contract agreed with the native owner is:

| Operation | Exact payload | Acknowledgement |
| --- | --- | --- |
| `host.artifactViewer.register` | `{ viewerId, uiLeaseId, html }` | `{ viewerId, registered: true }`; reserves only, creates no child |
| `host.artifactViewer.open` | `{ viewerId }` | `{ viewerId, opened: true }`; owned fixed document committed, no paint/user observation claim |
| `host.artifactViewer.retire` | `{ viewerId }` | `{ viewerId, retired: true }`; raw register/open/delivery and actual child destruction joined |
| `engine.artifactViewer.closed` | `{ viewerId, reason }` | `{ accepted }`; synchronous Source claim, cleanup outside delivery RPC |

The closed reasons are exactly `closed`, `parent-retired`, `expired` and `failed`.
The private schemas accept UUIDv4 IDs, a native-stamped document lease and at most
128 KiB of well-formed UTF-8 HTML. No caller title, MIME, URL, label, filesystem
path, profile/grant choice or child message exists. Native fixes those policies.
Source exposes a frozen per-view lease synchronously before raw read/register;
its observer records ownership only. Opening refuses until a matching validated
registration acknowledgement and post-ack scope check, and permits one raw open
attempt. Uncertain results do not authorize replay. Limits are 16 active leases,
4096 IDs per owner epoch and a maximum ten-minute lifetime.

Retirement fences admission synchronously, sends the original ID's retire request
even if registration has not completed, and joins retained Source work. Failed
retirement keeps the lease owned and retryable; it does not release admission or
retire unrelated viewers. A bounded owner close may report timeout while raw work
continues to drain. The parent must retain the SDK and database/profile lifetime
until close acknowledges. Successful retirement discards its HTML snapshot. The
closed delivery never invokes-and-awaits retirement inside the delivery handler.

The private native counterpart and sealed Source binding are described in
[native-artifact-viewer.md](native-artifact-viewer.md). Linux uses a separately
excluded incognito WebView with JavaScript disabled, one immutable document,
fixed CSP, exact physical-parent ownership and acknowledged destruction. The
actual Wry component fixture covers hostile resource/IPC policy and native
lifetime; separate real Source/profile tests use synthetic native receipts.
Neither proves installed all-platform integration or privileged-main iframe
isolation. macOS/Windows remain unsupported. The main `frame-src 'none'` policy
and public viewer unavailability remain. No new retained operation/grant or
external OS scheme is added; a public consumer requires a separate reviewed
contract and actual end-to-end evidence.
