# Managed sessions: the ledger and core (B3, #99)

The Commander and the Captains are moving onto one shared session layer,
`src/main/sessions/` (epic #96). Batch B3 adds its durable core: a ledger of
generations, turns and summaries; a per-owner event inbox; a managed session
that runs one turn per owner at a time; and crash recovery at startup.

B3 **records only**. The Commander and AgentManager still run their turns
exactly as before and report what happened to the ledger. Nothing reads the
ledger back to change behaviour. B4 (Commander on ChatEngine) and B5 (Captains
on AdapterEngine) move the turns themselves onto `ManagedSession`.

## Owners, generations and turns

An **owner** is `{ kind, id }`: `commander` + a Commander session id, or
`captain` / `task` + a task id.

| Table (migration 32) | One row per | Key facts |
|---|---|---|
| `session_generations` | Backend conversation of an owner | `n` counts from 1 per owner. At most one open generation per owner (`ended_at IS NULL`, partial unique index). `backend_session_id` caches the backend's id; `tasks.session_id` stays its mirror. `end_reason`: `replaced`, `lost`, `rollover`, `closed` |
| `session_turns` | Event delivered to an owner, and the turn it ran | `dedupe_key` is UNIQUE per owner. `seq` orders the owner's turns across generations. `status`: `queued` → `running` → `done` / `failed` / `interrupted`, or `dropped` / `coalesced`. `tool_calls` (JSON) lists each call with `running` / `done` / `error` / `interrupted`. `usage_keys` links `session_usage` rows (B1) and the token columns sum them |
| `session_summaries` | Fold, handoff or failed summary of a generation | UNIQUE per (generation, `dedupe_key`). `status`: `pending`, `done`, `degraded` |

No foreign key points at `tasks` or `commander_sessions`: like
`session_usage`, the ledger is an audit record that outlives what it
measured. See [Database migrations](database-migrations.md), version 32.

## Idempotency

Every write is one SQLite transaction and every write can be repeated:

- **An event is recorded once.** `beginTurn` / `enqueueTurn` with a key the
  owner already has return the existing turn (`inserted: false`,
  `started: false`) and change nothing. That holds across restarts, because
  the check is the table's unique key.
- **A retry is explicit.** `beginTurn(..., { retry: true })` runs a `failed`
  or `interrupted` turn again (`attempts` grows). A `done` turn is never
  re-run.
- **A turn ends once.** `finishTurn` on a finished turn is a no-op and
  returns null. Tool calls still running when a turn ends become
  `interrupted`.
- **Tool calls** are keyed by id within their turn. A repeated start or
  result changes nothing.
- **Usage** is linked by `session_usage.turn_key`, and the token figures are
  re-summed from the linked rows. A replayed or cumulative report is never
  counted twice. `input_tokens` on a turn includes cache reads and writes:
  everything the model read.
- **Summaries** are keyed per generation.

## Event keys used today

| Owner | Event | `dedupe_key` | `trigger_kind` |
|---|---|---|---|
| Commander | Typed or spoken message | `user:<commander message id>` | `user` |
| Commander | Report relay (one or several reports) | `report:<report message ids>` | `report` |
| Captain, task agent | Initial prompt of a session | `start:<backend session id>` | `start` |
| Captain, task agent | Durable delivery (`sendMessage`) | `delivery:<delivery_outbox id>` | `user` when a person typed it, else `system` |
| Captain, task agent | tillDone nudge, `continue` recovery | `prompt:<random>` | `nudge` |

A durable delivery that failed and is retried (`delivery_outbox` attempt 2+)
keeps its key and records a retry of the same turn. Waker batches, subtask
completions and scheduled reviews still arrive as `system` deliveries. B5 gives
them their own triggers and keys, for example the waker's `computeDeliveryId`.

## When an adapter turn ends

AgentManager reports by backend session id (`AdapterLedgerTracker`):

- the prompt is sent: the turn starts, in the generation of that backend
  session. A different backend session id than the open generation's ends
  that generation (`replaced`) and opens the next. A temporary id that the
  backend later replaces (re-key) moves with the generation;
- polled tool parts: each tool call is recorded as it starts and finishes
  (only a changed state is written);
- a usage report: linked to the turn;
- idle: `done`; an error status: `failed`; Stop: `interrupted` (`stopped`);
- a new prompt while a turn is still open: the open turn ends `done` with
  `stop_reason = superseded`, because the backend folds the new prompt into
  its conversation.

The Commander records its tool calls from the ChatRuntime events, links its
B1 usage row, and ends the turn `done` (or `failed` when the provider errored).
A successful fold is recorded as a `fold` summary and a failed one as a
`failed` summary.

## Crash recovery

`recoverSessionLedger()` runs at startup right after the database opens
(`src/main/index.ts`), before any turn can start. Every turn that another
process left `queued` or `running` becomes `interrupted`, with
`error_kind` = `crash_before_start` or `crash_during_turn`. Its tool calls
still `running` become `interrupted`. Each turn carries the `runner_id` of the
process that ran it, so recovery never touches a turn of the current process.
Running it again, or late, is harmless.

Nothing is re-run. Per the proposal, B4/B5 decide what an interrupted event
becomes: a notice with Retry for user and report events, a re-queue for
wake-ups. The Commander does not yet persist tool calls in
`commander_messages` step by step, so no dangling tool call can reach its
history. B4 adds that persistence and closes interrupted calls there.

Recovery runs whatever the flag says, so turns recorded before the flag was
switched off are still closed.

## The modules

| Module | Role |
|---|---|
| `ledger.ts` | `SessionLedger`: every read and write of the three tables, and `recoverInterrupted()` |
| `event-inbox.ts` | `EventInbox`: per-owner queue with dedupe and coalescing. A coalescable event joins the newest waiting batch of the same kind and is recorded `coalesced` into its turn. `drop()` records a batch that will not run as `dropped` |
| `managed-session.ts` | `OwnerLocks` (a mutex per owner), `ManagedSession` (`deliver`, `drain`, `idle`, `state`: one turn per owner at a time, every turn recorded), `recoverSessionLedger()` |
| `ledger-recorder.ts` | Record-only use: `SessionLedgerRecorder` (flag check, failures swallowed) and `AdapterLedgerTracker` (backend session → open turn) |
| `flags.ts` | The `sessions.*` settings keys |

Log lines start with `[ManagedSession]`: opened and closed generations, every
finished turn (`owner= turn= event= trigger= key= tools= tokens= stop= error=`),
ignored duplicates and the recovery count.

## The flag

`sessions.ledger` (a `settings` row). The ledger records by default; set the
setting to `off` (or `false`, `0`, `no`) to stop recording new turns. A turn
that started while the flag was on is still recorded to its end. Recording can
never break a turn: every failure is logged and swallowed. Later batches add
`sessions.commander_managed`, `sessions.captain_managed` and
`sessions.rollover`. B8 adds a settings UI for them.
