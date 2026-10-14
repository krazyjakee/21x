# Native artifact file clipboard binding

This slice retains exactly `artifacts:copyFile(taskId, relativePath)` and its
existing `{mode: 'file' | 'image' | 'path' | 'unavailable'}` public result.
The portable Linux callback implements file URI references only, returning
`file` or `unavailable`. Image bytes and path-text fallback are separate legacy
semantics; this slice neither reads file contents nor pretends those effects
occurred. Public input cannot select a root, destination, filename, document
lease, receipt, authorization ID, executable or clipboard implementation.

`ArtifactBackendOptions` borrows the actual optional `WorkspaceFileOwner`
through `files` and a separately captured
`copyArtifact(receipt, caller, signal, beforeEffect)` native callback. The
existing exact-owner assertion receives `files` as its optional third argument.
Configured copying requires current agent read grants as well as task and
project grants. Missing native capability returns `unavailable` after bounded
scope authorization with no filesystem/native effects. A missing source also
returns `unavailable`, without creating a workspace. Scan and Read remain
available independently of clipboard capability.

Literal requested task workspaces are preserved. A member's artifact is not
silently read from its execution anchor; Captain, member and anchor paths
retain their existing storage behavior. The backend captures the shared
bounded SQL task/project/role/repository/group scope and independent assigned
group agent. It checks agent existence and current read grants using scalar
queries, avoiding full task getters and credential configuration parsing.
It rereads the exact binding and all grants at each effect boundary. Existing
huge unrelated private task fields remain stored without materialization.
There is no metadata writer, lifecycle mutation, task update or session stop.

`WorkspaceFileOwner.withCapturedFile(taskId, absolutePath, controls, invoke)`
is a trusted internal helper with a fixed 64 MiB regular-file ceiling.
The path is derived from the captured workspace root, literal task ID and
validated relative path. Root/task/ancestor identities, no-follow opened-FD
identity, single-link status and size are verified before invocation. The
actual source descriptor remains retained for the entire raw native callback;
post-callback fstat/lstat verifies identity, size, mtime and ctime before close.
Source transfers only the existing strict workspace receipt. It never reads
contents, supplies an arbitrary RPC path grant or changes Open/Reveal/text
preview capacities.

Native ingress stamps the current document lease. Root registers an opaque
private authorization ID bound to the original call's `beforeEffect` guard,
and native rechecks that guard before clipboard publication through the
private `engine.artifact.copyFile.check` path. The Source callback is
`host.artifact.copyFile {receipt, leaseId, authorizationId}` with a finite
`file`/`unavailable` result. IDs and grants cannot be chosen by public payloads.
The native Linux owner holds its actual clipboard slot and descriptor authority;
Source does not broadcast a second event or fake an acknowledgement.

Cancellation, dropped replies, scope changes and shutdown fence later effects,
while ignored raw native work and FD close remain owned. Uncertain effects
are never replayed automatically. Changed callback identity refuses rather
than invoking a replacement. Completed callbacks cannot reuse retired request
scope. Failed FD close retains the exact handle, blocks new file effects and
requires acknowledged explicit owner drain retry before profile release.
Refusal preserves source and unrelated bytes. Same-user pathname/native
clipboard lifetime races remain explicit installed-platform boundaries, not
an all-platform atomic containment claim.

Authored regressions use actual portable SQLite, real temporary files, actual
AgentManager session ownership and actual WorkspaceFileOwner descriptors with
controlled native callbacks. They cover unavailable/missing sources, files
larger than 512 KiB without Source reads, literal roles/groups, current grants,
private/oversized SQL inputs, links/replacements, revoked callback identity,
held native cancellation/shutdown, fixed diagnostics, no replay and failed
close retry. Pure codecs preserve all four legacy result modes and reject
private fields, traversal, malformed Unicode and undefined results. Validation commands and results are recorded in the batch evidence. These
fixtures do not exercise a graphical clipboard or file-manager paste.

This is partial #202/#208/#215/#217 progress. Installed Linux GTK clipboard
behavior, non-Linux targets, image/path clipboard modes, embedded artifact
viewers and full retained canvas/desktop parity remain open. Hosted voice stays
deferred.

GTK publishes only `text/uri-list` with percent-encoded UTF-8 from the captured
native path. Its owned GObject holds fixed URI bytes for future selection
requests; those requests perform no filesystem reads or authorization RPC.
The native blocking worker checks Source before queueing publication and after
actual callback retirement. GTK itself checks the captured physical document
immediately before and after its effect. Shutdown drains accepted work, clears
only a clipboard offer whose owner still matches the captured token, and waits
for payload retirement before releasing the native root. A five-second public
timeout revokes later effects without manufacturing raw completion.

This is a reference handoff, not a snapshot of file contents. A later external
paste depends on the file remaining available; subsequent pathname changes and
external consumer behavior are outside the handoff guarantee. Graphical GTK
publication/owner cleanup remains unverified by the display-free tests.
