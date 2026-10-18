# Source attachment removal and cleanup receipts

This #214 continuation keeps the existing
`attachments.remove(taskId, attachmentId): Promise<void>` signature and trusted
Source task/project/group/agent scope. It changes production removal into an
exact-ID logical metadata delta under the existing AgentManager task mutation
exclusion. Electron retains its legacy file removal and explicit UI metadata
write. No operation, grant, DTO or native permission is added.

## Reproduced failure and accepted ordering

The actual Source regression imports two files through native-selection and
protected-file owners. Original metadata is `[A]`. Old removal acknowledged
unlink of A while leaving `[A]`; a separate legitimate append accepted `[A,B]`,
and attachment CAS then correctly refused the stale removal array `[]` with
baseline `[A]`. Current metadata referenced A even though its bytes were gone.
This is a separate observed defect from the earlier stale-append lost update.

Production Source now captures the exact stored record and current metadata,
checks its scope under the existing exclusion, then commits removal of that
record from the canonical array before irreversible file cleanup. The database
transaction rechecks full current ownership/metadata after the update; a rejected
transaction rolls back without entering filesystem deletion. Other metadata
records and unrelated task fields remain intact. This exact-ID delta needs no
renderer full-array baseline; append/edit/order still use explicit attachment
CAS, and `attachments.save` stays metadata-only.

Immediately after the accepted database transaction, Source publishes the
existing canonical `task:updated {taskId,updates:{attachments}}` through its
ordinary scoped owner path. It then joins actual protected-file removal. A
later raw cleanup refusal, cancellation or unavailable waiter cannot erase the
accepted canonical state. Parent shutdown/transport loss can suppress event
delivery; persisted canonical readback remains authoritative after reconnect.
Healthy private-peer tests prove the exact metadata event, distinct from
existing `last_activity_at` observation events.

## Honest partial cleanup

A pre-unlink refusal retains the protected bytes. Actual Linux tests use a
readable, non-writable private task directory to produce kernel unlink denial;
the private peer returns an error while canonical metadata remains removed,
bytes remain intact, and the accepted metadata event is delivered. This is a
partial cleanup error, not an invented failure of the already accepted logical
delta. Repeating public removal of an absent record is refused; no uncertain
unlink or metadata write is automatically replayed.

A raw unlink already admitted before cancellation may complete. Later
cancellation/verification failure cannot manufacture byte restoration. Tests
hold the actual unlink promise, observe accepted metadata/event and original
bytes, verify overlapping Source mutations are refused, and prove a close
deadline retains the raw work/database until its acknowledgement. After raw
unlink completes, the caller may receive cancellation; canonical state remains
removed and sibling bytes survive.

This is not an atomic filesystem-plus-SQLite transaction or rollback protocol.
Protected orphan-copy/removal-intent journaling, hard-crash reconciliation and
explicit recovery of retained unreferenced bytes remain open. No cleanup of
unknown files, broad root scan or automatic metadata merge is introduced.

## Renderer handoff and proof limits

After source publication, renderer owner A removes the native second full-array
metadata write, joins canonical read-only task refresh after either receipt or
partial/unknown error, and shows a manual-review hint without replay. A diverged
edit-form draft retains unsaved text/original baseline and fences Save until
explicit close/canonical review. A new database snapshot must never silently
authorize the old full-array intent. Electron behavior is separate.

Local evidence follows in
`evidence/issue-214-source-attachment-removal-local-20261018.json`: revision,
commands, raw exits, schema/runtime versions, hashes, actual Source/SQLite and
private-peer controls, failures/repairs and remaining defects. Synthetic
profiles/files only. These checks do not establish installed supported-target
UI/platform acceptance, pending renderer integration or whole #214/#215 closure.
Hosted Verify unavailable: repository Actions disabled
(actions/permissions enabled:false), awaiting user decision. No settings endpoint,
workflow dispatch, identity/scheme choice, release, live-profile cutover or
Electron retirement is authorized; hosted voice remains deferred.
