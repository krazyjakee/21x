# Retained workspace-file controls

`WorkspaceFileBackend` borrows the actual SQLite manager,
`WorkspaceFileOwner`, and host-selected workspace root. It preserves four
existing preload controls:

| Command | Exact arguments | Result |
| --- | --- | --- |
| `tasks:getWorkspaceDir` | `{ taskId }` | Absolute directory string |
| `shell:readTextFile` | `{ filePath }` | `{ content, size }` or `null` |
| `shell:openPath` | `{ filePath }` | Undefined |
| `shell:showItemInFolder` | `{ filePath }` | Undefined |

The codecs retain `{ defined: false }` for undefined native-action results,
never a fabricated JSON null. Requests cannot add a task ID, root, permission,
native receipt, or lifecycle override to a shell operation. Path DTOs support
bounded Unicode POSIX, Windows-drive, and UNC absolute syntax; these are
syntax checks only. The real Node owner separately checks its physical
platform, canonical paths, symlinks, hard links, and captured root/task/file
identities.

For shell requests, the backend derives the requested literal task ID from
the first segment relative to the captured workspace root. Private profile
paths, arbitrary roots, unknown tasks, traversal and another platform's
physical path syntax cannot become file authority. `tasks:getWorkspaceDir`
can create only that actual authorized task's directory through the real
owner; it never calls a caller-selected root or aliases a group member to
its execution anchor. An accepted directory creation may remain after caller
cancellation; no uncertain mutation is automatically undone or replayed.

Artifacts and workspace files now use the same `TaskWorkspaceScopeReader`.
It reads bounded SQL scalars for task/project/group/repository/session
bindings, preflights repository JSON before parsing, and avoids unrelated
task/agent credential deserialization. Current members require the relevant
execution-anchor and all current-member grants. Anchor history also requires
the relevant former-member grants after dissolution. Removed members retain
their own literal workspace. Every asynchronous filesystem/native boundary
and final publication rechecks the current caller, grants, and exact scope
snapshot; a changed binding refuses the response rather than retargeting it.

Content is capped at 128 KiB of UTF-8 text and the full optional-result
envelope remains below 890,000 bytes even with worst-case JSON escaping.
The original oversized-preview shape remains `{ content: '', size }`, with
the actual nonnegative safe-integer file size. This is metadata, not truncated
content or a nonexistent file. Missing files return null; empty files retain
size zero. Node's existing UTF-8 replacement behavior for malformed legacy
bytes is retained, while malformed Unicode DTO strings and oversized decoded
content are refused. No arbitrary byte-stream or attachment capability is
introduced.

Native open/reveal actions exist only when the actual owner has the matching
captured callback. Otherwise their schemas are omitted and invoking them
returns `UNKNOWN_OPERATION` before filesystem effects. Root contract metadata
classifies these as service-side admission with an explicit host callback;
the native callback independently verifies the narrow versioned physical
receipt and trusted epoch/caller. A path string or declared command is never
itself a native capability. This slice does not add an iframe, WebView viewer,
browser automation, arbitrary file picker, copy/download route, or live OS
action.

At most sixteen requests are admitted. Cancellation fences new work and
requests but retains accepted file opens, reads, close acknowledgements and
native callbacks. Backend shutdown fences its actual workspace-domain owner;
close separately joins accepted operations and `files.close()`. Any failed
owner close blocks drain, preserving the database/profile lease until the
exact raw descriptor acknowledgement or explicit retry succeeds. A public
timeout does not establish native closure. Late native acknowledgements are
not replayed, and already accepted OS effects cannot be claimed rolled back.

Authored tests use actual SQLite and filesystem ownership in isolated synthetic
directories, with controlled primitive and native callback acknowledgements.
They cover unavailable capabilities, bounded Unicode/large/missing text,
foreign/stale/grant loss, group/history policy, changed bindings and physical
roots, links, preserved inactive state, late opens, failed closes, and native
cancellation. No live native effects or installed-device proof are claimed.
Windows/macOS durability and callback behavior, installed native path actions,
separate sandboxed artifact viewers, and complete attachment/canvas/platform
acceptance keep #202/#208/#215/#217 open.
