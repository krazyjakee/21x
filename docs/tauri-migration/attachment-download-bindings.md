# Native saved attachment download

This slice retains exactly `attachments:download(taskId, attachmentId) -> void`.
The public payload contains the literal task ID and saved attachment UUID.
It cannot select a destination, filename, root, receipt, executable or document
lease. The Linux native host presents the actual Save dialog and alone owns
the selected destination and target writer. Dialog cancellation retains the
legacy void result; a void response does not claim a file was saved.

`TaskAttachmentBackendOptions.downloadAttachment(receipt, caller, signal, beforeEffect)`
is an optional captured native callback, independent of `openAttachment`.
Each operation is registered only when its own real callback exists. Missing
Download never removes Open, and missing Open never removes Download. The
backend rechecks the selected callback's exact captured identity before and
after every nested effect; changing another capability cannot redirect it.
Native ingress supplies the private current `uiLeaseId`; public arguments
cannot manufacture it. Shutdown fences admission and retains accepted raw
native calls even when cancellation is ignored.

Download uses the same bounded task/project/group/agent **read** scope as
Open, including the anchor, current and former members and independently
assigned group agent. It supports a task with a live agent without stopping
that agent or taking a task lifecycle mutation lease. Scalar SQL budgets and
saved attachment metadata bounds apply before materialization; unrelated
credential configurations and huge private task fields are not loaded.
Neither Download nor Open writes attachment metadata or emits task updates.
Current bindings, grants and saved metadata are reread at every effect
boundary, including after raw native completion.

`TaskAttachmentFileOwner.open` retains the exact no-follow, single-link source
FD through the whole native acknowledgement. It derives only the literal
`<captured attachment root>/<task ID>/<UUID>-<saved filename>` path and checks
physical root/task identities, saved size, lstat/fstat identity and mtime/ctime
before and after native work. Opening and downloading accept saved files up
to 64 MiB; the existing 512 KiB publication/removal limits are unchanged.
Source transfers only metadata, never file contents. Missing, linked, changed,
foreign or oversized sources refuse without altering the original bytes.
A failed FD close retains the exact handle, blocks new file effects and
requires an acknowledged explicit drain retry before profile release.

The private command validator is `isPrivateAttachmentDownload` for exact
`{taskId, attachmentId, leaseId}`. The callback schema is
`host.attachment.download {receipt, leaseId, authorizationId} -> {}`. The service
creates a private UUID ticket for the original active `beforeEffect` guard.
Native copying checks `engine.attachment.download.check {authorizationId}`
before effects, on its worker thread. The service rereads task, project, group,
agent and saved metadata bindings through that guard; missing, cancelled,
revoked or retired tickets refuse. GTK callbacks make no blocking RPC. Tickets
exist only through the raw callback and cannot be reused for another request.
Receipt remains the exact
nine-field version-one attachment receipt: `version`, `taskId`,
`attachmentId`, `filename`, `attachmentRoot`, `path`, `root`, `ancestors`,
`target`. The literal task directory is its sole ancestor and target must be a
single-link regular file. Native independently compares physical receipts
against its captured **attachment** root and document lease. No workspace
root or public destination authority is introduced.

Native owns the Linux dialog, destination descriptor and bounded copy. The
dialog asks for a new filename: this scope never replaces an existing file.
Linux publication uses an unnamed temporary file and a no-replace link from its
held descriptor. Unsupported target filesystems fail explicitly. After accepted
publication, a later scope failure preserves the saved file. Download and its
exact private transport/callback have a 180-second request budget; native work
retires further effects after 120 seconds while retaining raw ownership.
The Source backend joins that raw callback through abort, lost lease, timeout or
shutdown, then closes its retained source descriptor. Accepted or uncertain
native effects are never replayed. A later caller/identity failure cannot undo
an accepted external save and does not delete or rewrite the source. Same-user
filesystem races and real installed GTK behavior remain explicit platform
gates; this implementation does not claim all-platform atomic containment.

Authored regressions use actual portable SQLite, real temporary files and the
actual captured file owner with controlled native callbacks. They cover both
Open and Download: live agents with read-only grants; literal Captain/group
storage; former/anchor/group-agent grants; bounded metadata; foreign and
missing selectors; symlink substitution; files larger than 512 KiB without
Source reads; revoked bindings; immutable callback identity; ignored native
cancellation and raw drain; fixed private failures; and failed FD-close retry.
Pure codecs reject public destinations, paths, leases and malformed results.
Display-free fixtures establish their stated scope; installed dialog interaction
is a separate acceptance gate.

Broader #202/#208/#214/#215/#217 installed GTK, non-Linux, picking/uploading,
embedded viewer and other file controls remain outside this slice. Hosted
voice remains deferred.
