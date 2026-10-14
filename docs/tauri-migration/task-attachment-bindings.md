# Retained task image saves and attachment removal

`TaskAttachmentBackend` borrows the production SQLite manager, actual
`AgentManager`, `TaskAttachmentFileOwner`, and captured attachment root.
Attachments use their own profile root, distinct from task workspaces. The
protected owner lease checks those exact references; there is no renderer
root, path, native callback, picker or clipboard capability in this domain.

| Command | Exact request keys | Result |
| --- | --- | --- |
| `chatImages:saveToTask` | `taskId`, `images` | Existing saved attachment metadata array |
| `attachments:remove` | `taskId`, `attachmentId` | Void |

`TASK_ATTACHMENT_CODECS`, `TASK_ATTACHMENT_OPERATIONS`, and
`TASK_ATTACHMENT_LIMITS` define only these retained operations. Images have
the existing `{name,mimeType,data}` shape, with base64 data and no filesystem
path. The existing validator sniffs PNG/JPEG/GIF/WebP bytes and sanitizes
Unicode names, Windows devices, separators and control characters. The
existing save algorithm reserves unique names using normalized,
case-insensitive comparison. It appends real UUID/filename/size/MIME/time
records to the actual task row and emits the ordinary `task:updated` event.
No speech, model turn, separate attachment database or new event is added.

Portable capacity is deliberately smaller than legacy Electron: five images,
512 KiB decoded per image and total, 128 saved metadata records, 128 KiB saved
metadata JSON, and a wire envelope below 890,000 bytes. Byte/count checks
precede base64 validation/decoding and output serialization. Existing larger
records stay stored; an oversized request, saved metadata set or selected
file is explicitly refused without truncation or deletion. Legacy helper
calls without the trusted portable controls retain their existing image
limits and path behavior.

The backend requires current trusted desktop identity, epoch, availability,
task/project read and write authority for the literal requested task, and
read authority for its relevant agents and current/former group members and
execution anchor. It reuses `TaskWorkspaceScopeReader`; member storage never
aliases to the group anchor. Captain image attachment semantics remain
available. Current roles, project/archive, repository, group memberships,
agent/session pointers and saved attachment references are captured and
rechecked after asynchronous work. Bounded SQL scalar sums precede group
scope parsing. All actual task and agent schema columns are checked before
the lifecycle lease or legacy full getter can materialize an oversized
unrelated field; those checks also run after waits.

One mutation is admitted at a time, within a sixteen-request ceiling. The
actual task lifecycle lease joins accepted sends and fences competing task
effects. A trusted `runAttachmentMutation` may provide that same production
lease; it must not nest a duplicate lease. The ordinary portable helper uses
the captured file owner through optional `TaskImageFileControls`, so it
never calls the ambient database `getAttachmentsDir` creator. Native
callers cannot replace these internal callbacks.

`TaskAttachmentFileOwner` captures canonical root/ancestor identities and
bounded literal task-directory receipts. It creates exclusive, no-follow
temporary descriptors, checks single-link regular files, writes bounded
chunks, verifies actual bytes and descriptor identity, fsyncs, and retains
the actual close acknowledgment before publication. An atomic hard link
publishes without replacing an existing destination; the exact temporary
link is then removed. Root/task and byte identities are rechecked throughout.
This relies on the protected private profile and cooperative physical-path
guards; Node's path-based unlink/link operations are not an adversarial
directory-swap primitive. Cross-platform filesystem/process containment
acceptance remains open. Unsupported physical roots or hard-link publication
fail explicitly; there is no rename-overwrite fallback.

Publication receipts are opaque owner-produced objects. `commit(receipt)`
releases only bookkeeping after the synchronous SQLite metadata transaction
accepts this request's exact append. A stale or concurrently changed metadata
set is conservatively refused before commit. Failure before commit rolls
back only exact verified newly owned paths and acknowledged byte prefixes;
it cannot remove pre-existing destinations, similarly prefixed files,
modified bytes or unknown links. Failed closes and uncertain retirement
receipts remain owned and block protected profile release until an exact
retry acknowledges closure/cleanup. User-modified files are preserved and
may require the user to remove their own changed file before cleanup can
finish. No broad directory scan or recursive cleanup is used.

The exact append is verified inside a SQLite transaction. Once that actual
transaction commits, the helper commits its file receipts without a fallible
permission check in between. Later caller loss or a changed session may
refuse the result/event but preserves accepted metadata and bytes; it does
not pretend to undo the accepted mutation or replay it. Stored oversized and
malformed legacy records are likewise preserved on refusal.

Removal selects the exact existing saved metadata record by UUID and reads
only `<attachmentRoot>/<literalTaskId>/<UUID>-<savedFilename>`. It checks
size, regular-file/single-link identity, physical parents, descriptor/read
receipts and concurrent changes before unlinking. Missing selected files
retain the existing void result; unknown metadata selectors are refused.
Removal remains file-only, matching the existing API: the task UI separately
updates its attachment metadata after success. It neither searches a UUID
prefix nor infers authority from a renderer filename. A larger selected
legacy file is a capacity refusal, with bytes and metadata unchanged.

Raw open/write/read/sync/link/unlink/close and cleanup promises stay retained
through cancellation, public deadlines and shutdown. Completed inherited
Promise scopes lose authority for later effects. Backend close joins its
accepted requests; the production singleton separately drains the captured
file owner before releasing the database/profile. A public error, timeout or
abort signal is not a descriptor-close acknowledgment. Borrowed database and
manager owners are not shut down by this domain.

Authored tests use actual SQLite and manager lifecycle algorithms, the real
save helper, physical synthetic profile files, real descriptors and controlled
primitive faults. Coverage includes Unicode uniqueness, exact file-only
removal, Captain/member/former grants, stale bindings, actual commit with
late grant loss, preserved concurrent ordinary attachments, bounded legacy
rows, exclusive publication, links, changed bytes, inherited callbacks,
ignored cancellation, failed close and exact retirement retry. These are
controlled owner proofs, not installed-device or all-platform evidence.
Coordinator validation and native/facade integration are separate. Arbitrary
file pick/save/open/download/clipboard services, full drag/drop/native viewer
integration and the broader #202/#208/#217 retirement gates remain open.
No live profile conversion, release or production cutover is authorized.

Production task deletion refuses while the captured attachment file owner has
pending I/O or retirement receipts. This prevents the ordinary database cleanup
from removing a namespace under an admitted attachment writer.
