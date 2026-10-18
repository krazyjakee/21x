# Protected attachment directory syscall authority

The production Source file owner now uses verified held directory descriptors
for protected file syscalls on Linux. This extends #214's existing selection,
metadata-only copy, canonical full-array CAS, exact-ID removal and journal
contracts. No renderer argument or persisted record supplies a descriptor.

## Reproduced boundary

The whole-task retention fix in `956c5d07` prevents recursive pathname cleanup
when deleting logical tasks. A separate actual Source regression then saved a
protected copy, accepted exact-ID logical removal, and swapped the attachment
root immediately inside the final raw `unlink` boundary. The former implementation
rechecked the original file before and after the syscall, but the outside
same-name canary was deleted while the original copy survived. Restoring the
root before the postcheck did not restore the deleted bytes. The controlled
primitive executes the actual kernel unlink; it is not a simulated receipt.

## Held directories, canonical facts

The owner opens a directory with `O_DIRECTORY | O_NOFOLLOW`, retains the actual
FD before any post-await scope assertion, and compares its `fstat` identity with
the captured physical root/task directory. Private `/proc/self/fd/<FD>/<leaf>`
paths make the kernel resolve the effect through that held directory. An
ancestor pathname swap cannot redirect it into a different directory.

Task directory creation uses the held root. File open, temporary publication,
no-replace hard linking, temporary unlink, exact-ID unlink and rollback use a
held task directory. Existing file identity, size, link count, bounded readback,
digest, scope, cancellation and physical-root checks remain. The canonical
metadata, native file receipts and private journal facts retain canonical
paths/finite identities; numeric FDs and proc paths stay inside the owner.
Cleanup reacquires and verifies a fresh directory FD from its live proof. It
never reuses a numeric FD saved in a settled publication record.

Directory-close promises are raw owned work. Copy acknowledgement waits for
close; `commit` remains pure bookkeeping after acknowledgement. Late/refused
closes remain in the owner, count against admission, and keep shutdown/profile
retirement pending until acknowledged or explicitly retried. Cancellation does
not discard a late accepted descriptor. Shutdown joins file/directory closes
and existing cleanup rather than treating a close request as completion.

This concrete implementation requires Linux proc-FD authority. The default
non-Linux directory opener refuses before directory creation/file open/copy-byte
production. It never falls back to ambient pathname effects. A separately
proven supported native directory authority is required for macOS/Windows
protected read/copy/cleanup parity. Logical exact-ID metadata removal may already
be accepted before unavailable raw cleanup; its canonical event/journal/manual
review semantics remain unchanged. Whole-task deletion still deliberately
retains protected directories, including on Linux.

## Proof scope and remaining work

Actual Source and filesystem controls cover the final-unlink canary, root swaps
at directory creation/open/link/rollback, withheld/refused directory-close
acknowledgements, admission/close retry and missing authority before byte
production. The combined gate also runs existing journal/CAS/removal, production
Root/private-peer/mobile, raster/native consumer and staged entry controls.
Exact counts, Source revision, commands, failures/repairs and artifact hashes
belong to the revision-bound evidence published with this continuation.

No claim of filesystem/SQLite atomicity, automatic orphan collection, complete
legacy-file inventory, power-loss durability or installed native/all-platform
acceptance. Existing grants and managed task ownership remain authoritative.
Native viewer/voice, identity/scheme enablement, live provider/profile runs,
release/cutover and Electron retirement are not enabled. Hosted Verify remains
unavailable because repository Actions is disabled, awaiting a user decision;
no settings endpoint or workflow dispatch.
