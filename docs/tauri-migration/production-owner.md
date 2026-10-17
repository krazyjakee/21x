# Production application ownership

The [restart reconciliation continuation](production-restart-recovery.md) retires
old effect claims before service construction while preserving durable evidence.

The [startup recovery continuation](production-startup-recovery.md) carries
finite owner failures through the actual private/native status path without
reflecting error text or retrying initialization.

`src/service/production-owner.ts` supplies an application lifetime for the portable
service. It is separate from the disposable deterministic fixture in
`database-service.ts`. It does not select a live profile, change production
launch defaults, or establish Tauri platform acceptance. See the
[readiness audit](readiness-audit.md) and [validation requirements](validation.md).

A trusted host constructs `ProductionOwner` with a stable profile identity,
absolute profile/workspace/attachment/repository/resource/temporary paths, a
protected application key store, explicit `load` or `create` intent, the managed
MCP runtime, connector availability, and native callbacks. The key store may be
`NativeApplicationKeyStore` bound to a verified native helper path. `create` is
allowed only for an empty profile while holding the shared cross-host profile
lock; failed `load` never generates a replacement key. Paths and native
capabilities are bootstrap data, not renderer/RPC parameters. The owner uses the
canonical physical profile root from the lock for the database and shell wrapper.

The host supplies runtime/PATH preparation, native event and notification
delivery, browser launch, UI-command availability, and an acknowledgement that
this launch's supervised processes have exited. Unsupported window, energy,
notification, speech, or connector capabilities remain explicit. Missing connector
resources cannot silently disable an existing connector task source. Packaged
connector resources are validated before constructing their real runtime. The
shipping factory uses the five actual coding adapters and the configured chat
provider; test boundaries replace only external adapter/provider/connector
transport calls, not AgentManager or lifecycle implementations.

`start()` reserves same-process service globals before any asynchronous key
access, acquires the shared profile lock, checks disk/resources, prepares the
native runtime, and loads the protected key. Existing credential envelopes and
secret/OAuth/connector ciphertext are checked read-only before SQLite migration
or seeding. Incompatible legacy `safeStorage` or plaintext credential settings
require an explicit copied-profile migration; this bootstrap performs no
conversion. Existing agent/source configuration serialization policy is retained.
This owner is not a new guarantee that every historic configuration field is
encrypted.

The owner then opens one real DatabaseManager, SecretBroker and task API; constructs
AgentManager with explicit host seams; installs GitHub/GitLab/Forgejo and worktree
handling, OAuth, source plugins/SyncManager, task groups, Commander/Captain report
delivery, and Claude plugin management. Durable AgentManager and report/issue
reconciliation completes before automation, recurrence, heartbeat, Captain
wakeups, scheduled coordination, workspace cleanup, connector polling and reminder
timers start. Their existing settings, admission, pause/cap/daily-limit and
coordinator/heartbeat/triage exemptions remain authoritative. No window controls
their ownership. Captain reports remain quiet durable inbox updates.

Trusted service bindings call `run()` to retain their raw request promise even
when the caller disconnects or ignores abort. `getDatabaseBindingLease()` exposes
the actual lock/runtime to main-process bindings while ready; a captured lease
checks the same owner and remains held during draining. Bindings borrow the
owner's SQLite connection rather than initialize a second writer. Request
backends register their synchronous fence and actual drain with
`retainCleanup(name, stop, drain)` while ready; no unregister can abandon work.
The renderer receives existing real AgentManager and Commander observations via
the native event callback. This owner does not manufacture backend freshness or
bind a new activity transport protocol.

`close()` synchronously fences admission, callbacks, timers, report handlers and
new adapter effects. It joins late initialization, actual API requests,
schedulers, providers, OAuth callbacks, connectors, worktrees, model iterators
and registered bindings. Production adapter wrappers retain accepted native
identities/configurations until successful destruction, including a native
create that finishes after quit or a manager's best-effort destroy failure.
Only cleanup is retried; original prompts, creates and tools are never replayed
by this registry. Raw work can settle after a short drain deadline, but the
owner keeps the database, credential provider, process-global reservation and
profile lock until an explicit successful close retry. Native process exit
acknowledgement is required before database/key/lock release. Failed cleanup
cannot be replaced by a no-op lifecycle or by killing unrelated processes.

Snapshots expose an epoch, monotonic sequence, phase, stage, ownership and fixed
recovery code. Phases are `new`, `starting`, `ready`, `stopping`, `blocked`,
`stopped` and `failed`. Resource/store/profile/database failures are redacted;
blocked drain remains visible and retryable. A new owner after crash uses the
existing durable queue/outbox/generation reconciliation, which preserves
unconfirmed effects instead of blindly replaying them.

The focused tests use synthetic physical profiles, real SQLite/schema/stores,
loopback listeners, the real lifecycle stack and controlled external boundaries.
They cover duplicate ownership, deferred native/key initialization, late raw SQL,
blocked native/adapter cleanup, registered binding leases, ignored-abort Commander
work, credential reopening, accepted-delivery restart, incompatible/corrupt
profiles, and portable OAuth/worktree drains. These sources do not prove native
process-tree/job ownership, OS-store helper failure/forced-quit recovery, runtime
resource packaging, WebView/window recreation, or all supported OS families.
Those require the coordinator's physical/native evidence with versions,
checksums and retained artifacts; G2/G3 and live cutover remain separate reviews.
