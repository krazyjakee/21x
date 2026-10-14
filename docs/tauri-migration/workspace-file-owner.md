# Captured task workspace filesystem owner

`WorkspaceFileOwner` owns the actual filesystem and native callback work for
four existing controls: `getWorkspaceDir`, `readTextFile`, `openPath` and
`showItemInFolder`. Its constructor captures the host-selected physical
workspace root and lifetime assertion. Every request carries
`{ beforeEffect, signal }`; the backend supplies current trusted caller,
database task/project/group bindings and grants through that assertion.
The owner has no database writer, task alias resolver or caller-selected root.
Group member requests use that member's literal task directory.

## Paths, reads and receipts

Task IDs use the existing ASCII database grammar
`[A-Za-z0-9_-]{1,128}`. File paths must be canonical absolute paths below
`workspaceRoot/taskId`, bounded to 4096 UTF-8 bytes and 64 descendant components.
Root and ancestor identities are captured from bigint filesystem stats;
links, special files, changed directory identities and files with multiple
hard links are refused. Root parent identities are checked as well. A
remembered task directory cannot silently be replaced or disappear.

The trusted worktree owner acknowledges legitimate task-directory removal with
its captured bigint device/inode pair. `retireWorkspace` drops only that matching
directory receipt, permitting later authorized recreation. It is not an IPC
operation and does not change any in-flight path/descriptor receipt. Unrecognized
replacements remain refused.

Only `getWorkspaceDir` may create a directory, using a nonrecursive mkdir for
the exact authorized task below the captured root. Reads and native effects
never create a missing workspace. Text reads preserve the existing result
shapes: missing returns `null`, oversized returns `{content: '', size}`, and a
bounded file returns UTF-8 content and its safe-integer byte size. The text cap
is 128 KiB, including the worst JSON escaping within a 1 MiB result bound.
Oversized files are opened and identity-checked without reading their body.

The owner opens real read-only file descriptors with no-follow/nonblocking
flags where supported. Bigint fstat proves the opened target matches the
captured path. Reads are chunked and bounded; final fstat/lstat compare inode,
device, link count, size and nanosecond modification/change times. Ancestors
and physical paths are rechecked before publication. The target descriptor
remains owned during a native callback and through actual close.

Private native receipts use the shared `WorkspacePathReceipt` version 1:

```text
{version, taskId, workspaceRoot, path, root, ancestors, target}
identity = {path, dev, ino, kind, size, nlink}
```

All paths are canonical absolute paths. Root and ancestor kinds are directory;
the target is file or directory. `ancestors` starts with the literal task
directory and ends with the target's parent, excluding root and target.
A task-directory target has an empty ancestor list. Every numeric stat field
is an unsigned canonical decimal string bounded to uint64; size is also a
safe integer. File nlink is exactly `"1"`. Receipts are immutable, pass the
shared bounded shape validator and carry no program, environment or grant.
The native owner independently checks its captured descriptor workspace root
and exact opened directory/target handles before OS effects. A receipt itself
does not grant authority.

Node's path checks and opened target FD are the implemented filesystem
boundary. Path-based mkdir cannot provide an atomic openat guarantee against
an adversarial ancestor swap between the final check and syscall. No such
cross-platform atomic containment claim is made. Native descriptor-relative
opening is a separate host boundary; unsupported host effects remain explicit.

## Lifetime and native capabilities

The captured caller assertion runs before and after every awaited filesystem
primitive and native callback, then again after cleanup before publication.
Cancellation and shutdown prevent subsequent effects or results, while
accepted raw open/read/close/native callback promises remain retained. A late
open is registered before a revoked guard can throw, then the exact descriptor
is closed. Cleanup invokes current assertions but proceeds if those assertions
refuse, so loss of authority cannot abandon an accepted handle.

`shutdown()` fences admission. `close(timeoutMs)` joins raw operations and
descriptors; a deadline reports `WORKSPACE_DRAIN_INCOMPLETE` without releasing
their ownership. A failed descriptor close reports `WORKSPACE_CLOSE_FAILED`,
retains that exact handle and blocks final drain. A subsequent explicit close
retries the retained handle. The owner never unlinks or replaces workspace
data and never retries an accepted native effect.

`canOpenPath` and `canShowItemInFolder` reflect actual captured callbacks.
Absent callbacks refuse before effects, including for missing paths. With a
callback present, an authorized missing target preserves the legacy no-op.
Callbacks must retain their own real native work until their promise settles.
There is no live OS opener or network call in the authored fixtures.

## Authored verification and remaining gates

`workspace-file-owner.test.ts` uses real temporary directories, opened file
descriptors and filesystem operations. Controlled primitive wrappers hold
actual accepted open/read/close receipts for cancellation and shutdown tests.
Coverage includes literal group member workspaces, preeffect authorization,
root/task/ancestor/leaf replacement, mismatched opened descriptors, in-place
mutation, links/hardlinks, bounded and oversized text, missing targets,
post-close revocation, failed-close retries, native callback retention and
decimal receipt shapes. Every test preserves an unrelated real file.

This worker has not executed tests or checks. The coordinator validates the
filesystem suite together with backend and native authority regressions after
all sources freeze. Installed OS opening/reveal behavior, unsupported-platform
directory FD semantics, profile cutover and broader #202/#208/#215/#217
acceptance remain separate gates.
