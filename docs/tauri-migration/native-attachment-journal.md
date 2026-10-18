# Private protected attachment journal

The production Source owner now captures a private SQLite journal alongside its
real `TaskAttachmentFileOwner`. This extends #214's existing metadata-only copy,
full-array CAS and exact-ID removal contracts. It adds no public operation,
filesystem scheme, renderer grant, retry queue or second database writer.

## Observed gaps

An actual production-owner regression accepted a protected metadata-only copy,
closed its profile and reopened it with the same synthetic credential store.
The bytes survived, but no durable owner described the unreferenced copy. The
regression now requires the private publication record after that real restart.

The writer audit also reproduced a separate #213 path: authenticated loopback
`/update_task` accepted a stale attachment array, erased another accepted record
and applied its stale title. HTTP and MCP production requests now refuse any
attachment-array update before route preparation, Stop, writes or notifications.
The policy is captured when the application starts its listener, including its
MCP dispatch closure. Requests cannot replace it. Field-only requests continue;
the Electron host retains its existing route. No current-DB baseline is invented
for an old incoming array. This is explicit unavailability until a separately
reviewed import/baseline contract exists.

## Facts and live ownership

Private `__attachment_journal_v1:<UUID>` rows use the existing profile SQLite
database. They bind the profile ID, physical attachment-root identity, original
task/project/agent/parent/role/group scalars, exact canonical attachment metadata
and the publication/removal checkpoint. Stage names are finite app-generated
basenames; file identities and SHA-256 digests describe verified checkpoints.
The ledger contains no OAuth code, token, secret, arbitrary source pathname or
executable. Retained production settings codecs cannot read or replace its keys;
actual settings snapshots omit them.

Publication persists intent before opening a new exclusive temporary file,
records the held FD identity, then records verified ready/published checkpoints
before returning a copy receipt. File sync and bounded readback verification
remain owned by the existing file owner. `commit` stays pure bookkeeping after
an accepted metadata/copy boundary: it performs no new SQL or fallible I/O.

Exact-ID removal creates its private intent inside the same SQLite transaction
as the accepted logical metadata delta. Its existing canonical event still
precedes raw unlink. Only the current process's opaque live receipt authorizes
verification and cleanup; a persisted ID cannot reconstruct that receipt.
Successful verified cleanup retires its intent and matching settled facts.
Refused or uncertain raw cleanup retains the fact for manual review. It does
not restore metadata, infer rollback or automatically replay an unlink.

The task-lifecycle full-array CAS observer joins its final SQLite transaction.
Removing a legacy reference with no existing publication record creates a
bounded unreferenced fact; changing metadata does not acquire file authority or
cause unlink. A stale CAS fails before this observer. File-owner rollback also
preserves bytes if canonical metadata acquired the path while the original
request was retiring.

## Bounds and recovery meaning

SQLite bounds the ledger's key lengths, record count, largest value and total
value bytes before JavaScript materializes rows: at most 4,096 records, 8 KiB per
record and 8 MiB total. Strict finite validation follows. Invalid, changed or
full journals refuse new affected file effects; records are not truncated or
silently evicted. Root/profile replacement refuses access. Failed live copy/FD
cleanup retains its file/profile owner for explicit retry. A settled but
uncertain removal instead retains durable facts for review, without replay.

`inspect()` is private and read-only. Its classifications compare persisted
facts with current canonical metadata and scope; they do not assert that a
physical file still exists. It never follows a saved path, reads attachment
bytes, mutates task metadata, imports a copy or authorizes deletion. Restart
cannot resume an old user intent from these facts. Capacity exhaustion requires
an explicit reviewed reconciliation decision; there is no automatic garbage
collector or public repair UI in this slice.

## Local proof and limits

Actual SQLite/file-owner controls cover accepted copies, canonical-reference
preservation, verified rollback, transaction rollback, refused unlink, expired
process receipts, private settings exclusion and pre-materialization bounds.
Actual production bindings exercise CAS detachment and settings snapshots.

The standalone proof
`src-tauri/resources/node/node scripts/attachment-journal-crash-proof.mjs`
uses pinned Node 22.23.2/ABI127 and physical staged SQLite. It kills real child
processes with SIGKILL after a partial temporary write, an accepted publication,
verification before unlink and raw unlink before acknowledgement. Fresh child
processes reopen the same WAL database, retain the expected facts and perform
no automatic file mutation. The proof uses the real database schema and file
owner; it is not an installed Tauri crash/lifecycle test. The separate actual
production-owner test establishes clean protected-profile restart integration.

Filesystem publication and SQLite are not one atomic transaction. These tests
do not establish power-loss durability, safe automatic orphan deletion,
cross-platform destination authority, or an installed physical UI/device
rehearsal. Whole-task/subtree deletion still needs a separate bridge/audit for
the legacy `DatabaseManager.deleteTaskAttachments` recursive cleanup path;
this slice does not establish ownership of every task-deletion file effect.
macOS/Windows saved-file execution remains refused. The scoped Linux
mobile execution handoff published in `bd898f99` uses the same captured Source
manager/file owner; incoming nonempty mobile payloads and full-array writes
remain refused. #208/#202 prerequisites, the identity/scheme decision and
supported-target installed acceptance remain open. Native voice remains off.

Synthetic profiles/files and controlled processes only; no live profile,
provider account, release, cutover or Electron retirement. Hosted Verify is
unavailable: repository Actions disabled (`actions/permissions enabled:false`),
awaiting user decision. No settings endpoint or workflow dispatch.
