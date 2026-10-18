# Native attachment selection and task import

This continuation owns the remaining picker/import boundary in #214/#215.
The retained API stays `attachments.pick(): Promise<string[]>` and
`attachments.save(taskId, filePath): Promise<FileAttachment>`. Returned paths
are display metadata. A path, web `File`, drag/drop pathname or caller-supplied
selection ID cannot mint file-read authority.

## Authority and lifetime

On Linux the actual modal GTK Open dialog belongs to the current physical main
document. Its callbacks collect at most sixteen local selections; they do no
filesystem work or blocking private RPC. The retained blocking worker waits for
both the dialog response and actual signal/timer closure retirement.

Native opens each literal ancestor with no-follow descriptor-relative operations,
refuses aliases/traversal, symlinks, nonregular files, hardlinks, protected-profile
paths, unsafe filenames and files above 64 MiB. It holds the file and ancestor
FDs, captures the native document lease, and computes a SHA-256 digest with a
64 KiB scratch buffer. This digest matters on filesystems whose timestamps can
coalesce across same-size edits. The native selection lifetime is at most five
minutes, with sixteen active receipts and a permanent 4096-ID admission ceiling.
A closed ID cannot be registered later. The only native read route accepts a
private unpredictable UUID, its original document lease and an exact sequential
bounded offset; no source pathname crosses that read route.

Native privately offers bounded selection metadata to the Source singleton
before returning paths to the renderer. Source atomically claims a selection
under the exact current literal task/project/group/agent ownership fence before
any import read. A selection may precede new-task creation; it becomes bound to
the task captured by this first authorized save. A second task or replay cannot
claim the same receipt. A fresh native selection of an unclaimed display path
retires its previous receipt; already-claimed imports cannot be superseded.
Neither renderer IDs nor path strings create a receipt.

Each native read checks current native admission/document authority and the held
file/namespace version. Source checks its captured task scope before and after
every raw native receipt and destination effect. It streams at most 64 KiB per
chunk into the protected attachment owner, verifies the destination digest,
fsyncs/closes and atomically publishes without replacing an existing filename.
An explicit native finish checks exact EOF and the selection digest, including
zero-length files. Native retirement must acknowledge before output acceptance.
The Source save returns metadata only: the existing UI separately appends that
metadata to its task. Image saves retain their separate 512 KiB input limit.

Cancellation/reload/shutdown fences new effects synchronously. Raw dialog, reads,
FD close and native retirement remain owned through public deadlines. Failed
retirement retains its one-shot Source lease for cleanup retry, never import
replay. Native cleanup remains allowed after ordinary admission closes. Cleanup
verifies every owned byte/link before unlink; changed output and unrelated files
are preserved for explicit repair. An output accepted before a later caller loss
is preserved; no unsafe pathname rollback is invented.

## Integration and bounds

`attachmentSelections` is an independent private launch capability requiring the
native UI owner. Other platforms advertise it unsupported. No plugin permission,
app identity, scheme registration, OS handler or global browser capability is
added. Only the trusted main origin/label and current physical document can
invoke the public picker/save ingress. Private offer/read/finish/retire operations
are absent from the public operation manifest and cannot be selected through the
general renderer dispatcher. Pick/save have exact finite 180-second public
budgets; the native chooser stops further work at 120 seconds. Other operations
retain their existing deadlines.

Native file drop remains unavailable until an actual native drop receipt exists.
The renderer must not fall back to browser/Electron path extraction on Tauri.
Attachment viewer URLs, keyboard/focus, window/chrome/shortcut/login-item work
and installed supported-platform acceptance remain separate open work.

## Evidence scope

[The local evidence](evidence/issue-215-214-native-attachments-local-20261017.json) records actual focused app/staged Node tests,
real temporary-file/SQLite controls, native authority and host tests, source
hashes, exact commands and failure repairs. An explicit isolated Xvfb proof exercises the real GTK chooser selection,
cancellation, revocation and owned callback retirement, followed by actual FD
reads. This controlled GTK parent is not an installed Wry/Source/profile run.
A controlled chooser or MockRuntime is not installed platform acceptance. No live profile, provider account,
OS credential, release or Electron cutover is used.

Hosted Verify unavailable: repository Actions disabled
(actions/permissions enabled:false), awaiting user decision. No settings endpoint
or workflow dispatch is authorized. Final app identity/current+legacy scheme
handler authority remains a user decision; no identifier or scheme is chosen.

## Private selection-group retirement

The native owner can revoke one exact group through private
`engine.attachment.selection.revoke {leaseId,selectionIds}`. The group has one
original document lease and one to sixteen unique UUID selection IDs; it
contains no task, path, provider or public grant. Source validates the whole
group before changing any entry, then synchronously cancels all matching
selections and tombstones unseen IDs. A delayed offer cannot recreate them.
Foreign-lease groups refuse atomically; unrelated selections remain usable.

The acknowledgement follows the actual per-entry raw read and native retirement
receipts. Failed retirement keeps the cancelled entry for explicit retry and
does not reopen a read or repeat import. Cleanup remains callable through the
original private owner while closing. It neither closes the global selection
owner nor becomes a renderer operation. The native pending-result parser accepts
only exact `{retired:true}`, and public dispatch refuses the private name.

A revoked producer's finite scope error survives protected destination rollback;
it is not reported as a destination I/O failure. Controlled private-peer/SQLite
regressions hold an accepted raw read, revoke its group, observe joined native
retirement, unchanged task metadata and no leftover destination file. Existing
regular-file/version/digest and retryable-close checks continue to apply.

This cleanup route supports the separately reviewed
[native Drop context/accept/close protocol](native-attachment-drop.md). Its
original opaque UI context is captured at the actual native event; held files
cannot be read until acceptance, and group cleanup joins raw work across context
change, refusal, ignored delivery and document loss. Renderer owner A owns UI
activation after publication. No raw path fallback or Source public operation
is granted; installed all-platform acceptance remains open. Explicit full-array
metadata update also still needs a Source cross-writer append/CAS decision and
regression; metadata-only save semantics are unchanged.

## Explicit attachment metadata compare-and-swap

Production `db.updateTask(id, data, precondition?)` now requires the separate
third argument `{ attachmentsBaseline: FileAttachment[] }` whenever
`data.attachments` is supplied. The baseline is the complete canonical metadata
array captured with the caller's replacement intent, with at most 128 records
and the existing 900,000-byte lifecycle request bound including both arrays.
It is not a database field, native file receipt, path grant or stored task field.
Field-only updates keep the existing two-argument API. Electron behavior remains
unchanged; the extra argument is a production contract precondition.

Source compares array order and every `id`, `filename`, `size`, `mime_type` and
`added_at` field under the existing AgentManager task mutation exclusion before
Stop/prepare and again immediately inside the write transaction. Object property
insertion order is irrelevant. Missing, malformed or misplaced preconditions
fail with `INVALID_ARGUMENTS`; a valid stale baseline fails with the existing
finite `INVALID_REQUEST`. A refusal emits no task update or accepted scheduler
effects and does not remove any accepted destination copy. If a raw Stop was
already legitimately admitted while the baseline was current, its ownership is
still joined; a later metadata conflict prevents persistence and follow-up
accepted effects without claiming to undo that Stop.

This preserves explicit removal and ordering. Source does not union arrays,
fabricate a baseline from current database state, retry an uncertain write or
turn metadata-only `attachments.save` into an implicit append. A caller must
review a fresh canonical task after conflict and make a new explicit decision.
Mobile attachment-array writes remain refused until that caller transport has
an explicit captured baseline; ordinary mobile field-only updates are separate.

The real Source regression imports two native selections through actual
selection/file owners and verifies protected bytes. Two independent empty task
snapshots then produce separate metadata appends: old Source accepted both and
lost the first record; the repaired Source accepts the first and refuses the
stale second while keeping both acknowledged copies. Other controls cover all
metadata fields, removal/order, existing overlapping-mutation refusal, actual
raw Stop, cancellation, scope withdrawal, old epochs and private-peer delivery.
Renderer owner A threads the exact captured baseline through task/draft/Drop
metadata writes after this source publication; this backend evidence does not
claim that UI integration or installed physical app acceptance. Protected
unreferenced-copy journaling/reconciliation remains open.
