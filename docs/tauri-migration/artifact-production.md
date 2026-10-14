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
