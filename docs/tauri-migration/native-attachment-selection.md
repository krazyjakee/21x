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
