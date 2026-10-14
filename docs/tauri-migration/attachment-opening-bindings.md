# Native attachment opening

This slice retains exactly `attachments:open(taskId, attachmentId) -> void`.
The actual production backend resolves saved attachment metadata under current
task/project/group/agent read grants and a native-stamped document lease. It
does not expose picking, saving, downloading or an embedded attachment viewer.
Public arguments cannot choose a filename, path, executable, root or receipt.

`TaskAttachmentFileOwner.open(taskId, attachment, controls, invoke)` freezes
the saved metadata and derives only
`<captured attachment root>/<literal task ID>/<UUID>-<saved filename>`.
Opening has a separate 64 MiB ceiling, permitting existing attachments larger
than the 512 KiB image-publication limit. Existing write/remove behavior and
limits remain unchanged. Opening does not read or transfer file contents.

The owner checks captured physical root/ancestor identities, literal task
directory identity, single-link regular file status, saved size and actual
opened-FD metadata. It uses no-follow/nonblocking opening where supported,
checks lstat/fstat before native invocation, retains that exact FD through the
entire raw native acknowledgement, then repeats identity/size/mtime/ctime
checks. Missing paths, symlinks, hardlinks, replacements, unexpected sizes and
unsafe ancestors refuse. Each awaited filesystem primitive and native effect
has current caller/profile checks before and after. Same-user races between
pathname checks and external OS application behavior remain an installed
platform gate, rather than an all-platform atomic containment claim.

The private callback is exactly `host.attachment.open {receipt, leaseId} -> {}`.
The owner-produced version-one receipt has nine exact fields: `version`,
`taskId`, `attachmentId`, `filename`, `attachmentRoot`, `path`, `root`,
`ancestors`, and `target`. Identities reuse the six-field workspace identity
shape: absolute path, unsigned canonical uint64 decimal `dev`, `ino`, `size`,
`nlink`, and file/directory kind. Ancestors contain exactly the contiguous
literal task directory; target is a single-link file at the exact UUID/name
path. Path and receipt budgets remain finite. Shared validators are
browser-pure and include the separate exact private native command
`{taskId, attachmentId, leaseId}`.

Native compares these receipts against its separately captured **attachment**
root and current document lease. Reusing the existing descriptor-based file
owner after validated transformation does not grant workspace-root authority.
The native callback performs the real host operation; Node does not invent an
acknowledgement or broadcast a second event. There is no automatic replay of
an accepted or uncertain opener effect. External viewer lifetime is separate
from application ownership; the profile drains the acknowledged callback and
its own retained handles.

Cancellation, shutdown and late native responses cannot release raw work
early. Late successful FD opening is registered before any post-await guard
can throw, and its close is joined. Close failures retain the exact handle,
block new file effects and prevent final profile release until explicit retry
acknowledges closure. File bytes are preserved on refusal; opening never
deletes or rewrites them. An accepted OS effect cannot be undone by a later
scope or identity failure, so such a result remains uncertain and is never
silently repeated.

Authored real temporary-file regressions cover large metadata-only opening,
exact receipt projection, missing/wrong/linked files, cancellation before late
FD delivery, ignored native cancellation, revoked authority, replacement
files/task directories, immutable saved metadata and failed-close drain retry.
Pure schema cases cover namespace/path/UUID/filename mismatches, private
fields, canonical uint64 bounds and document lease shape. No real OS opener,
tests, builds or checks were executed by this worker. Root performs integrated
validation after all authors freeze. Installed supported-target behavior and
the remaining #202/#208/#214/#215/#217 acceptance criteria stay open.

The optional `attachmentFiles` launch capability requires the actual native
attachment callback and UI document owner. Public Source opening cannot stamp
a document lease; native forwards only private `engine.attachment.open`.
Physical main window, current epoch and the expected document receipt gate
private native effects before and after the pinned Linux opener. Callback
completion records accepted OS launch, without claiming that a separate
application has finished reading or displaying the file. Older artifacts and
other native targets remain unavailable before filesystem or opener effects.

Integrated verification is recorded in
[the attachment opening evidence](evidence/issue-closing-20261014-attachment-opening.json).
