# Retained worktree and cleanup controls

`WorktreeRuntimeBackend` borrows the production database, `AgentManager`,
`SyncManager`, `WorktreeManager`, shared `GitProviderProcessOwner`, the three
actual provider managers, `WorkspaceCleanupSchedulerCore`, shared
`WorkspaceFileOwner`, and captured repository/workspace roots. The protected
owner lease checks those exact references. It binds six existing commands;
there is no public process, filesystem-root, provider endpoint or callback
opener.

| Command | Exact request keys | Result |
| --- | --- | --- |
| `worktree:setup` | `taskId`, `repos`, `org`, optional `provider` | Actual workspace path |
| `worktree:changes` | `taskId`, `repos` | Existing diff/file/branch/PR metadata |
| `worktree:files` | `taskId`, `repos` | Existing repository/workspace inventory |
| `worktree:readFile` | `taskId`, nullable `repoFullName`, `filePath` | `{content,size,binary,truncated}` or null |
| `worktree:cleanup` | `taskId`, `repos`, `org`, optional `removeTaskDir` | Void |
| `workspace:runCleanupNow` | None | Actual cleaned/error/dependency counts |

The codec exports are `WORKTREE_RUNTIME_CODECS`,
`WORKTREE_RUNTIME_OPERATIONS`, `WORKTREE_RUNTIME_LIMITS`,
`WORKTREE_RUNTIME_EVENT_CODECS`, and `WORKTREE_RUNTIME_EVENTS`. Optional
undefined API arguments are omitted from the wire. Unknown fields, unsafe
relative filenames, ambiguous repository basenames and arbitrary clone URL
fields are refused. The three retained events are `worktree:progress`,
`workspace:cleanup-progress`, and `workspace:cleanup-complete`; no new event
transport or fabricated observation is introduced. Cloning/fetching progress
retains the actual request task ID and errors have fixed public text.

Requests require current trusted desktop identity/epoch, available captured
owners, and every relevant task/project/agent/source/repository grant.
Mutations require write authority too. Literal group-member workspaces stay
literal; current execution anchors and members are checked without aliasing
the requested path. Captured SQL receipts include task roles, group/session
bindings, repository declarations, source configuration and provider settings.
Each receipt and the cumulative retained receipt budget are bounded below
890,000 bytes, and SQL scalar/count/aggregate checks precede materialization.
Unrelated credentials and task output are not deserialized for read-only
scopes. Global cleanup and provider-map changes require global configuration
authority plus every current project grant, including archived projects.

Requested repositories, organization and provider must match the existing
`resolveTaskRepos` result from saved task/project bindings. Branches use the
saved branch or actual bounded provider metadata. A provider-map write uses
the existing writer, scoped to all current task/source users and their actual
mutation leases; more than 128 affected tasks is explicitly refused. Task
mutations join actual send/lifecycle work and source mutations drain actual
source jobs. Active/queued sessions are conservatively refused. The trusted
`beforeWorkspaceMutation` callback additionally refuses retained heartbeat or
file-owner work. None of these writes replays on reconnect.

Portable setup accepts exact trusted HTTPS clone metadata. GitHub retains its
fixed `https://github.com/<fullName>.git` fallback. GitLab/Forgejo require real
metadata and available actual clone capability; there is no guessed host or
new SSH endpoint policy. Before a cached bare clone fetches, the actual
expanded `git remote get-url --all origin` result must exactly match that
metadata, and current authority is checked again before network use. Foreign,
missing, multiple and SSH origins are refused. Automatic setup lacking a
scoped remote authority is explicitly unavailable. Repository-controlled
external diff and text conversion are disabled for portable tracked and
untracked previews. Only the exact untracked diff command may use its real
exit-one stdout; code two remains a failure.

Portable limits include 128 repositories, 4,096 files, 8,192 scanned entries,
depth 64, 128 KiB per Git output/diff/file preview, 512 KiB aggregate command
output, and a serialized result below 890,000 bytes. Oversized file previews
retain the actual size with empty content and `truncated:true`, matching the
existing preview shape with a smaller portable cap than Electron's 512 KiB.
Binary files retain `binary:true` and empty content. The manager selects the
actual literal repository path, then the captured file owner reads through
its physical path/descriptor identity checks and retained close receipts.
Capacity refusals preserve existing bytes; no privileged viewer is added.

`WorkspaceCleanupSchedulerCore` captures an immutable portable policy used by
both manual and automatic passes. A bounded scalar store replaces unrelated
legacy task deserialization. The planner refuses aged orphans, unsupported
groups, uncertain physical roots, stale bindings, unowned dependency pruning
and active work. A nonempty cleanup requires a real captured process-idle
observer and actual mutation lease before its first removal. The current
production host has no such process-observation authority: nonempty cleanup
is explicitly unavailable; an empty pass truthfully returns zero counts.
It never falls back to ambient `ps`, `lsof`, process termination or recursive
dependency pruning. A controlled host can supply real observations and use
the actual manager cleanup algorithm. Successful directory removal is
acknowledged before the exact physical receipt is retired from owner caches;
replacement directories are preserved. Electron's existing scheduler defaults
and larger previews remain unchanged.

At most sixteen requests and one mutation are admitted. Each nested request
has its own raw-child join and expiring authority, while sharing a bounded
output/scan budget. Outer requests retain nested wrappers, rejected sibling
commands and directory close receipts until actual acknowledgment. Deadline,
caller cancellation and shutdown do not stand in for process/descriptor
closure. Domain close joins its accepted work; the production singleton
separately drains the borrowed shared Git, filesystem and scheduler owners
before releasing the protected database/profile.

Authored regressions use real SQLite, manager/sync algorithms, physical
synthetic filesystem trees/descriptors, and controlled trusted process
primitives. They cover legacy DTO shapes, bounded/redacted results, exact
origin/refusal, inherited and nested scope lifetime, raw sibling drain,
preview metadata, foreign/group/stale grants, retained cancelled reads,
SQL/receipt budgets, truthful empty and unavailable automatic cleanup, and
controlled owned removal. They are not live SDK/provider, native process
tree, installed-platform or device acceptance. Coordinator-run validation,
captured production cleanup observation, reviewed SSH/provider clone support,
full native callbacks, all-platform packaging and the broader #202/#208/
#210/#212 retirement gates remain open. This slice does not authorize a live
profile conversion, release or production cutover.
