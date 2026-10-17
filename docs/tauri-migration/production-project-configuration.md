# Production project configuration and domain reconciliation

The #210 continuation gives the retained `project:create` and `project:update`
commands a production-specific codec and backend over the existing SQLite owner
and AgentManager. The old diagnostic/content codecs still reject lifecycle
fields. The production input accepts the existing editor's name, description,
default/Captain agent, Git provider/org and settings fields. No command, event,
public signature or grant is added to #202.

| Area | Runtime binding and codec | Authorization and actual effect |
| --- | --- | --- |
| Project create/update | `ProjectConfigurationBackend`, `PROJECT_CONFIGURATION_CODECS`, matching native request validator | Current trusted epoch/caller, create or project read/write, existing authorized agent references; same DatabaseManager transaction and canonical `project:changed` |
| Captain selection | Real `runProjectConfigurationMutation` borrows the Captain's existing task exclusion | Joins accepted sends; excludes candidate switches; checks exact task/session/agent write scope before acknowledged Stop; changes selection only after raw teardown joins |
| Project settings | Bounded public JSON; strict limits, wakeups, review and concurrency draft shapes | Preserve the stored concurrency block; editor echoes cannot bypass the separately audited cap/pin operations. Create drops an unowned draft concurrency block. Real queue reconciliation follows accepted writes |
| Skills/repos/resources | Existing ConfigurationBackend, exact codecs and native authority | Same database transactions, complete child reorder sets, optimistic skill versions and current project grants. Scoped skill invalidation retains private old/new scope receipts, including deletion, without expanding the public event |
| Agent CRUD/config/models | Existing production AgentConfigurationBackend and real manager | Actual Stop/config notification and raw provider/listing lifetime; encrypted authenticated record credentials and masked public vendor keys |
| Settings/credentials | Existing ProductionSettingsBackend and captured production owner | Actual provider/secret/default-agent fences, serializers, admission and schedulers. Missing native settings owners continue to refuse writes |

Project/agent identity and public metadata reads are bounded before row
materialization. The merged settings budget is checked before writing preserved concurrency plus
new metadata. The captured project and agent-selection receipts are checked
again after asynchronous work and immediately before the transaction. A changed
row, withdrawn grant, cancelled request or shutdown cannot publish a late edit.
Raw retirement remains retained after a public timeout; a failed drain keeps the
profile owner until cleanup is acknowledged. A refused Stop leaves the old
project selection intact and retryable. Unrelated sessions survive the edit.
Canonical invalidation occurs at the accepted transaction boundary, so a later
cancel/refused reply cannot replay the write or lose its accepted notification.

The already owned OverdueNotifier now delivers its retained advisory through an
exact empty wire payload and the existing void public callback. Repeated starts
retain one 60-second timer; current project read scope gates delivery and shutdown
retires the timer. The tick contains no task/backend observation and cannot start
work or change task state. The shared lifecycle event codec is already in the
native client codec set; the explicit callback mapping is the coordinated #209
handoff.

Wakeup and scheduled-review settings are consumed by their existing background
owners. Saving a schedule does not immediately run a provider turn. Daily token
caps retain their existing documented accounting seam; this continuation does
not invent token observations. No UI, native bootstrap, microphone, hosted voice,
provider account or live profile is enabled or used.

## Reconciliation scope

`production-domain-reconciliation.ts` inspects each current retained manifest
row. The generated evidence lists runtime registration in the actual isolated
ProductionService launch, registered Source domain names, Source/native client
codec presence, declared caller and required domain authority, successful
synthetic private-peer calls, observed events and outstanding platform proof as
separate fields. It does not invoke commands while inspecting registrations.
An attached handler is not an authorization receipt or a provider outcome.
Command registration is inspected from the actual schemas. Event producer
registration is explicitly uninspected (`null`): `hasOwnerEvent()` only checks
the codec table. Observed private-peer deliveries are recorded independently,
including the real overdue timer; an unsupported voice codec cannot count as
an attached event owner.

The reconciliation launch deliberately leaves voice unsupported, connectors and
configured MCP disabled, and native UI/mobile unconfigured. Rows for absent
optional owners remain visible. Native-only codecs are listed independently;
an OS/document dispatch is not inferred from their presence. Older domain proof
records remain tied to their own revisions. #202's scope and open state remain
unchanged.

The new controls run through the actual production private peer and real owners
under both the application runtime and staged standalone Node. They cover the
full editor request, durable Captain seed, queue unpause/FIFO, concurrency
preservation, joined/refused teardown, current scope/row receipts, failed-close
retry, candidate exclusion, encrypted agent CRUD and actual model/notification
outcomes. A real controlled Pi child uses an empty PATH and synthetic protocol;
its exact exit precedes selection publication. Skill invalidation controls cover
project-only readers, foreign-scope rejection and the old side of a scope move.

Renderer facade integration is a coordinated #209 handoff to A after this
source publication. Installed supported-platform acceptance, real configured
providers and remaining native settings effects stay open. Hosted Verify is
unavailable: repository Actions disabled, awaiting user decision. No workflow or
settings endpoint is invoked. Whole #210 closure also requires #202; no release,
data cutover or Electron retirement is claimed.
