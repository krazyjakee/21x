# Human authorization through delegation

Commander relay authorship and human authorization are different facts. A
machine relay remains `human_authored=false`; it can carry a reference to an
originating human instruction recorded by the platform. Textual flags, copied
envelopes, model arguments, reports and assistant summaries never create rights.

## Incident and scope

Correlations `cmd-fcf90bbd68342b0b`, `cmd-6f41cf85aa4e9f1a` and
`cmd-9a4a4a2656f4fdef` exposed this distinction. Evidence tasks are
`ysreze49jdacahwa19ez3r33` (voice input) and `q0gm69mm4zxgkcx0o6mzdl87` (TTS).
The originating message `sp51kokjre5guz3a4moxat6y` said:

> I don't want recommendations. Create tasks for this and GitHub issues. The GitHub issues will probably need to be part of the commander UI refactor.

The next utterance was “Um”. Earlier human speech named “twenty one X”. The
regression reproduces that sequence: a voice command is captured independently
of typed-only merge-grant eligibility, conversational project scope comes from
the earlier captured human turn, and the backchannel retains the preceding
instruction's identity and deadline. Assistant mentions of projects cannot set
that scope. A later substantive human turn ends backchannel reuse. Existing
child tasks retain their original chain until expiry or revocation.

This change provides provenance and its resolver. Audited GitHub issue execution,
deduplication and reconciliation belong to sibling `gnxmq4omkns1qhcj6xuh59se`;
Commander UI integration belongs to `kdeie1qpzhp5rfw3543ws0ke`. It does not publish
the historical issues, retrofit old chat rows into authorizations, or change any
merge/deployment gate.

## Records and trust boundary

Schema 23 adds an append-only ledger:

| Record | Content |
| --- | --- |
| Human node | Message ID, exact stored text, SHA-256, capture timestamp, typed/voice input mode, source/session/task, versioned capability intents, project/repository snapshot, 24-hour expiry, and human scope-origin message reference |
| Delegation node | Parent ID and hash, root ID, relay author, exact interpretation and hash, Commander correlation/session, destination task, timestamp, narrowed actions/repos, unchanged or shorter expiry |
| Transport binding | Durable delivery key, node ID, destination task and exact payload hash |
| Dispatch reservation | Monotonic sequence, idempotency key, task, node and payload hash |
| Task binding | Current dispatch sequence/turn node plus a write-once assigned-work node; machine follow-ups can replace the former but never erase the latter |
| Revocation | Append-only node ID, time and reason; applies to all descendants |

SQLite triggers forbid updates/deletes of evidence. Hashes detect inconsistent
records; they are not signatures against a process that can rewrite the database
or drop its triggers. The trusted boundary is the Electron main process and its
database. Human ingress uses the trusted desktop composer or main-process voice
submission, never a model-supplied `role=user`.
The `voice:commander:send` IPC handler authenticates the top-level app sender
before reading the transcript or initializing the voice bridge, using the same
sender boundary as typed chat. Webviews, subframes and other renderer URLs
cannot record human roots, including when the bridge is already initialized.
The existing signed MCP URL
authenticates caller scope. A separate in-process scope argument reaches task
creation; raw JSON HTTP requests cannot supply it. Host/database compromise is
outside this boundary.

## Requested actions versus effective permissions

Supported ordinary capabilities are `task.create`, `task.update`, `task.start`,
`github.pr.open`, `github.issue.create`, `github.issue.update`, and
`github.issue.link`.
Merge, review approval, deployment, deletion, migration/replay, protection bypass,
credential elevation and arbitrary messages are absent.

Version-2 human nodes use a deliberately limited, clause-aware classifier at
trusted ingress; models never classify their own authority. Each intent stores
the canonical capability, `explicit` or `necessary` basis, classifier version,
source message id, exact source range and SHA-256, immutable project/repository
snapshot, creation time and expiry. `actions` remains a derived compatibility
view. Version-1 nodes continue to resolve exactly as stored and are never
backfilled or reclassified.

Direct imperative objects are supported, including “Create 21x tasks plus
GitHub issues”, “Open gh issues and tasks”, and staged-issue commands naming
task IDs. `gh` and `GitHub` normalize to the same issue object. Creating tasks
necessarily carries their ordinary update/start lifecycle; creating an issue
necessarily carries its 21x link; an authenticated coding assignment carries
draft-PR opening. Conditional, negated, approval-dependent, mock-only, quoted,
interrogative, ambiguous, oversized and protected-action clauses retain human
evidence but produce no capability. Conditional/example prefixes carry across
punctuation to the command they qualify, while an explicit later prohibition
removes the corresponding necessary capability (for example “Refactor. Do not
open PRs.” retains task work but not `github.pr.open`). This remains a bounded
grammar, not a general natural-language consent model.

Project scope comes from a single named configured project, the trusted project
chat destination, or the last platform-captured human conversational project
scope in the same Commander session. The spoken product name “twenty one X” maps
to project name “21x”. Ambiguous scope retains provenance with empty permissions.
Repos are snapshotted and intersected again with live configuration; new relays
cannot widen them. Explicit repo names and child task repos narrow the snapshot.

Delegations are immutable children. Effective rights are the intersection of
every ancestor's rights, destination project, current configured repos, lifetime,
and revocation state. The original human words remain the substantive instruction;
the relay cannot substitute different work merely because its action class fits.
Consumers must use those words when interpreting the requested work, and enforce
their own payload/action policies at the write boundary.

For task creation, omitted `permissions` inherits that effective set. A supplied
array can only intersect it, and an explicit empty array intentionally gives the
new branch no ordinary mutation authority. Task update/start, issue writes and
draft-PR opening resolve the same live record next to execution. A status update
or automation flag that would start an agent consumes `task.start` as well as
`task.update`. Recovery uses the task's immutable assigned-work binding; recap,
wake-up and retry prose cannot mint, renew or erase rights.

## Dispatch, recovery and revocation

Outbox insertion and reservation/binding commit together. Task creation and child
inheritance also commit together. Recovery reuses the same sequence and payload;
it never renews expiry or assigns a new generation to an old delivery.

Reservation clears the current active binding before asynchronous session resume
or configuration work. An authorized message waits for confirmed backend `idle`
before activating its binding and sending. Per-task serialization covers every adapter send, including startup and
worker nudges, and adapters that await before marking a prompt busy. A worker
continuation captures both generation and active node before asynchronous
preparation, and refuses to borrow a newer human instruction. Activation rechecks the latest sequence,
expiry and revocation after asynchronous waits. Error, approval-wait, unknown
status, or a 60-second idle timeout leave turn authority inactive. Machine
Captain nudges clear earlier turn authority but fall back to the write-once
delegation assigned atomically at task creation. Normal worker continuation
therefore retains the fixed instruction assigned at creation without treating
machine prose as new authority.

The preload exposes trusted-window-only `authorization.inspectTask(taskId)` and
`authorization.revoke(nodeId)`. UI integration can display the original instruction
and revoke its root to revoke all descendants; revoking one delegation affects
only that branch. There is no model-facing grant or revoke tool. Legacy messages
are not backfilled because a transcript role is insufficient provenance.

## Resolver contract

`src/main/authorization.ts` exports:

```ts
resolveTaskAuthorization(db, {
  taskId,    // derived from signed MCP caller scope, never tool arguments
  projectId,
  action,    // action taxonomy above
  repo       // owner/name, required for github.*
}, now?)
```

The result includes `allowed`, `status`, `nodeId`, `origin`, ordered `chain`,
`effectivePermissions`, `effectiveIntents`, `scope` and `revocations`. `origin` carries `messageId`,
`text`, `textHash`, `at` and `expiresAt`; delegation nodes carry `correlationId`,
`sessionId`, `taskId`, author and transformation text. Call immediately before a
privileged operation and recheck after any approval/network wait that precedes
the write. An envelope or previously cached `allowed=true` is not a capability.
Idempotency of external side effects is the consuming issue service's concern.

A denial additionally returns `requested_capability`, `missing_capability`,
`origin_node_id`, `origin_message_id`, `effective_capabilities`,
`failure_dimension` and `safe_remediation`. A caller reports these fields; it
does not edit relay wording and retry.

## Unified boundary and retained controls

| Boundary | Contract |
| --- | --- |
| Human chat → Commander → Captain → task | One immutable origin; every hop can only narrow. Covered ordinary work needs no repeated grant. |
| Task create/update/start | Same lineage; signed caller scope and project membership remain mandatory. Admission/capacity still decides when a valid start runs. |
| GitHub issue create/update/link | Same resolver plus the existing immutable issue-write claim/ledger and restart reconciliation. |
| Draft PR opening | `open_draft_pull_request` only, available to signed nested and top-level task agents: configured task repo, clean named branch, one validated fetch/push destination with no URL rewrite, immutable source SHA/ref, post-push verification, draft creation and exact retry recovery. |
| Merge and review approval | Separate merge grant/readiness gate and GitHub branch-protection/formal approval. Ordinary capability never satisfies either. |
| Deploy/release/delete/replay/migration/protection bypass/credentials/messages | Separate explicit gate; absent from the ordinary registry. |
| Cross-project or cross-repository writes | Denied by live task/project/repository intersection. |
| OS sandbox, provider auth/network and capacity | Independent platform controls; capability lineage cannot bypass them. |

## Regression coverage

Tests cover direct chat, the actual voice/backchannel sequence, Commander relay,
signed-scope nested task creation, unresolved scope, reopened SQLite recovery,
stale generations, altered payload/wording, forged claims, live repo removal,
revocation, expiry and migration without backfill. Exhaustive action-subset
enumeration checks 1,024 nested attenuation combinations. Adapter-boundary tests
cover busy/idle transitions, delayed status and prompt acceptance, generation
races, revocation/expiry during waits, unknown/error/approval states and timeouts.
