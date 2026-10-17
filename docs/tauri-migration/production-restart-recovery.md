# Production restart reconciliation

The Tauri production owner holds its shared profile lock and initializes the
one database, then calls `reconcileProductionRestart` synchronously before
constructing effect owners, APIs, adapters or schedulers. The shipping Electron
startup policy is unchanged. This is a conservative production policy: saved
backend IDs and prior process leases do not authorize a new mutation.

One SQLite transaction retires active durable start rows, all unaccepted
outbox deliveries (including unexpired claims), provider continuation/fallback
intents and active Captain runtime authority. Stable queue, delivery, intent,
session and backend identities remain. Original outbox payloads and delivery
receipts remain for inspection; provider terminalization clears its retained
prompt using the existing store contract. Accepted outbox receipts are preserved
for local acknowledgement and are never resent by startup reconciliation.

Tasks left running or triaging return to not-started with saved backend IDs.
Affected tasks and their parent chains have automatic start and completion
turned off: a flagged parent could otherwise select an interrupted child again.
Completed status, assignments, transcript, task graphs, group progress and
external outcomes are preserved. Terminal queue/runtime state and the project
status journal explain the required review. An explicit user start or new
message can use the existing continuation path; automation does not lift the
terminal queue boundary. Users should inspect actual outcomes before sending a
new instruction or re-enabling the affected automation flags.

Journal failure rolls the entire reconciliation transaction back and refuses
startup before effect owners exist. A repeat with no new interrupted work is
idempotent. Unrelated future work and its automation flags remain eligible.
No profile scan, process enumeration, saved PID signal or backend dispatch is
part of this reconciliation. Existing native containment remains the authority
for retiring descendants from an actual owned process tree.

Regressions cover old queued/retrying/claimed/starting starts; all four delivery
kinds, including accepted receipts; sending/accepted/retrying/dispatching provider
intents; Captain runtime identity; parent-chain automation; completed and
unrelated tasks; and rollback after a controlled journal refusal. An actual
production owner reopens a closed synthetic profile seeded with interrupted
claims, runs its real startup and repeated scheduler/reconciliation passes,
and admits no adapter work until an explicit user start. An actual unrelated
child still answers a request after reconciliation of a lease containing its
PID; the fixture terminates and joins only its own child afterward. This is a copied-state
restart proof, not a forced host/service crash or installed WebView proof.

See the [revision-bound local evidence](evidence/issue-closing-20261017-restart-recovery.json)
for commands, runtime versions, schema, artifact checksums and failure repairs.
All-platform containment/private bootstrap and installed crash/forced-quit,
hidden-window, native process-tree and UI/provider acceptance remain open.
Repository Actions is disabled, awaiting user decision; no workflow dispatch
or settings change is authorized. #202 remains open; this slice changes no
public command/event contract, live profile or release policy. Hosted voice
remains deferred.
