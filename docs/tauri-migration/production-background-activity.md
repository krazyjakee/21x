# Production background activity ownership

The production service owns one AgentManager and its automation, recurrence,
heartbeat, Captain wakeup, coordination and workspace cleanup schedulers. Their
lifetime belongs to the sealed production owner, rather than a renderer window.
Repeated owner startup returns the same services. Renderer attachment does not
construct these owners or replay an agent start.

## Periodic desktop freshness

AgentManager publishes activity only after its existing adapter polling path
observes a live session. The existing five-second freshness rate, per-owner
epoch and increasing sequence numbers remain authoritative. Late polling
receipts after session retirement or shutdown cannot renew activity. A known
adapter disconnect invalidates activity with `heartbeat: true` and
`disconnected: true`; it does not assert a new task status or terminal outcome.
An adapter observation describes that adapter's session/process state. It is
not evidence of a new remote provider request or network health check.

A dedicated internal activity subscription carries these observations to the
production owner's captured native desktop event sink. The owner releases this
subscription during shutdown. The regular general event fanout, mobile clients,
voice, notifications, status-transition deduplication and project event bus do
not receive periodic freshness. No second timer, persisted status poll,
synthetic lifecycle transition or mutation replay is introduced.

The retained `agent:status` codec accepts only bounded, paired epoch/sequence
metadata. A disconnect requires a true heartbeat, and a heartbeat requires an
epoch. Terminal activity outcomes are mutually exclusive with a heartbeat and
must match the terminal status. TypeScript and the native diagnostic/production
validators reject malformed combinations, unsafe sequence numbers and extra
fields. The production private peer still applies captured task/agent/session
read authority to every desktop delivery, including after attachment changes.

The renderer already records activity observations and returns before applying
status transitions. Renderer reload/reconnect regression coverage belongs to
#209; this service change supplies the missing windowless observations to that
existing typed subscription.

## Linux regression boundary

The production-service regression uses the real Pi adapter with a controlled
JSONL child, a synthetic profile, isolated HOME and an empty PATH. Its actual
prompt requests a synthetic permission decision. Repeated coordinator polls
carry freshness through the fragmented private ServicePeer while the real
admission queue retains a second task at the agent concurrency limit. Removing
read authority suppresses delivery; restoring it permits newer observations in
the same epoch. The raw task row, project event bus, general external listeners,
prompt count and all six scheduler start counts remain unchanged during the
periodic observations. Per-task retirement joins the TERM-refusing child before
ordinary owner shutdown. A separate controlled adapter disconnect traverses the
same private peer without replaying the prompt.

Existing targeted admission, Captain, scheduler lifetime, task feedback and
production-owner tests remain the authority for their covered behavior. Queue
policy is priority ordering with FIFO within priority/project and project round
robin; this continuation does not replace that established policy with global
strict FIFO. The [restart reconciliation](production-restart-recovery.md)
introduced under #208 runs before effect owners and prevents blind replay of
interrupted durable work. Its copied-profile proof is reused rather than
introducing a second recovery writer.

## Remaining acceptance

This is Linux service-path evidence. Installed window hiding, recreation,
forced quit and interrupted native startup/shutdown across supported packaged
platforms remain integration evidence, with #208 and #210 prerequisites still
open. Real supported-provider runs require the user's account/quota approval;
only controlled provider processes are used here. The production voice owner
still refuses capture/actions/shortcuts; its management controls and the legacy
voice action service calling admission do not establish a production voice start
path. That retained local-voice integration under #218 also remains open. Hosted Verify is unavailable:
repository Actions disabled, awaiting user decision. No workflow dispatch or
settings change is performed. Hosted voice remains deferred. No live profile,
release, identity/scheme decision, or Electron retirement is part of this work.
