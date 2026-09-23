# Captain recovery and durable starts

Captain self-healing is a platform invariant. It is implemented in the shared
main-process `AgentManager`, the SQLite start queue, and startup migrations; it
is not a prompt, skill, memory item, project preference, or optional Captain
behavior.

## One runtime and queue model

- `managed_agent_runtimes` and `delivery_outbox` are the runtime generation and
  delivery primitives introduced by #151.
- `agent_start_queue` extends #150 admission ordering. It persists stable queue
  identity, project/task/agent, priority and FIFO sequence, admission and
  dependency reasons, retry/backoff state, generation, lease, session
  acknowledgement, recovery cause/action/result, and every boundary timestamp.
- `agent_start_queue_fairness` persists the cross-project service cursor.
  Priority is critical, high, medium, then low within each project; FIFO breaks
  equal priorities; projects are served round-robin.

Migration landing order is #151/v20, #152/v21, then #148/v22. Fresh and upgraded
databases create the same tables, and the migrations are idempotent.

## Claim, start and acknowledgement

A queued row is claimed transactionally by changing its state and generation
and assigning a process lease. Starting and acknowledgement both match that
generation. A stale or late completion cannot acknowledge a newer claim; its
session is stopped. On restart, claims owned by the previous process are
classified as `crash_after_claim` or `crash_after_start` and returned to the
same durable row. If a persisted backend session is live, reconciliation
reclaims it and fences the queued start instead of starting another.

Queue draining is triggered by startup, session completion or failure, a
capacity/working-level change, agent recovery, dependency progress, file-touch
changes, and retry deadlines. Shutdown preserves queue rows and prevents the
departing process from draining them.

## Retry and terminal policy

Recoverable start failures retry at most five times. Delay begins at one second,
doubles to a maximum of sixty seconds, and includes stable 0–25% jitter. Retry
count and the next deadline are persisted before the process reports the new
state. Exhaustion becomes visible `failed` state and is never silently reset.

Automatic retry is forbidden for manual stops; completed, cancelled, or deleted
tasks; work labelled unsafe, destructive, irreversible, or with an unknown
external side effect; and work awaiting permission or approval. Those cases
become visible terminal queue/audit state. Missing authority or a genuine user
choice remains an escalation; ordinary crashes, capacity, agent availability,
and dependency completion do not.

Every recovery transition uses the same `cause`, `action`, and `result`
vocabulary in the durable queue, renderer event, task/session status response,
recent activity, and a `system_recovery` project-status journal entry. A queued
or retrying task remains `not_started`; it is never presented as running before
a live session owns it.

## Independent review hardening

Immediate admissions use the same durable claim/start/ack path as deferred
starts. In-flight starts and explicit reconnects share one per-task promise;
startup reconciliation itself is joined, and dispatch waits until it finishes.
The provider's busy or waiting-for-approval state survives reconnect and keeps
its admission slot. A stale reconnect cannot overwrite a newer session binding.

Dispatch rechecks exclusions, all unresolved transcript tools/questions, and
actual predecessor edges (including the existing review opt-in policy). A late
backend creation is checked against its original queue generation before it
registers a session or delivers a prompt. Shutdown also blocks already-scheduled
drains. Explicit manual stops and retry exhaustion remain terminal across
scheduler sweeps and restarts; an explicit continuation message is needed to
resume. Deferred outbox messages cannot bypass those recovery exclusions.

A person's own start lifts any of these terminal states: the desktop board's
start, a status change to a working status in the desktop or mobile app, and
the mobile start action pass `explicitUserStart`, which re-queues the task with
an `explicit_user_restart` audit entry. The agent task API only passes
`resumeManualStop`, so an agent can reverse a manual stop but never lifts an
exclusion that recovery made after a failure.

A failed initial prompt transport can have accepted the prompt before reporting
an error. Such an attempt stops with `prompt_delivery_unconfirmed`, preserving
an auditable user decision instead of automatically replaying unknown effects.
