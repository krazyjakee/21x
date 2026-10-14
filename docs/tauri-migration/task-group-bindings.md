# Production task-group bindings

`TaskGroupBackend` binds nine existing controls to the actual database,
`TaskGroupService`, `AgentManager`, `SyncManager`, plugin registry and OAuth
owner. It does not reuse synthetic task CRUD, implement a second group writer,
or grant group approval to worker progress reports.

| Control | Exact payload | Existing result |
| --- | --- | --- |
| `taskGroups:list` | `projectId`, optional `includeDissolved` | group records |
| `taskGroups:get` | `id` | group, execution task, current/former members |
| `taskGroups:history` | `taskId` | retained group records |
| `taskGroups:create` | `data` | created group record |
| `taskGroups:add` | `id`, `taskIds` | updated group record |
| `taskGroups:remove` | `id`, `taskId` | updated group record |
| `taskGroups:dissolve` | `id` | retained dissolved group record |
| `taskGroups:move` | `id`, `status` | updated group record |
| `taskGroups:review` | `data` | group, completed task IDs, per-member failures |

These actual methods return defined records/arrays; missing groups throw rather
than inventing a null/void result. Definition edits preserve retained membership
episodes and the single execution transcript. Source completion uses the same
task output action and actual source plugin as the existing user review flow.
Send-back uses the existing durable send after releasing the mutation fence.

## Current authority and borrowed owners

The production lease checks exact database/group/session/source/plugin/OAuth
identities on every boundary. Calls require the trusted main-window principal,
current engine epoch and explicit task/project grants. Read grants are distinct
from writes. Scopes include the exact execution anchor, current members, former
members and requested added/removed tasks. A member is never silently aliased
to another task's workspace or execution ID.

Agent selection uses bounded scalar SQL for the same configured/default
precedence and passes that exact agent into the actual group service. It does
not load all saved agent configurations to select a default. Runtime starts
and send-back traverse the selected agent's bounded fallback graph and check
its configured skills, secrets and MCP references. Repositories and skills
remain project-scoped; source writes require the exact source/project/plugin
action, referenced MCP/connector scope and current source binding. Private
credentials are borrowed only by their actual owners for accepted effects.

Call-scoped guards run in both the group service and actual manager through
`withTaskGroupRequestGuard`. They recheck before/after controller waits, before
definition/review writes, before each source action and before its post-provider
local write. Actual OAuth refresh uses the source control's current assertion
as well. A lost grant, cancellation, shutdown or changed task/source/resource
binding prevents later effects, member completion, admission and sends. A
returned remote acceptance is not automatically replayed or rolled back.
Settled request scopes are marked inactive after their owned child promises
join; inherited late callbacks cannot reuse an old request's authority.

## Storage and wire bounds

`TASK_GROUP_CODECS` projects only declared public group fields and uses
`projectTaskLifecycleTask` for full public task records. Private MCP nonces,
credentials and internal storage extensions do not cross the boundary. Review
failures retain affected task IDs and a fixed `Source completion failed.`
message, excluding raw provider/CLI errors and signed URLs.

Inputs use existing ASCII database IDs, at most ten unique task IDs, a title
with 1–200 trimmed UTF-16 characters (raw input bounded to 400), and feedback
bounded to 4,000 UTF-16 characters without NUL. Move accepts only Not started,
Working, Ready for review and Completed. Optional values retain their exact
presence; unknown payload fields or caller-provided grants are refused.

Lists cap at 256 groups, snapshots/history at 128 member references/episodes,
and all public results at 900,000 UTF-8 JSON bytes. SQL length/count preflight
caps total relevant stored rows at 128,000 bytes before actual getters,
JSON.parse, decrypting owners or large legacy values are materialized. Scope
queries read finite scalar bindings and bounded related rows. Refusal preserves
stored bytes and never truncates meaning to claim a complete result. Creation
and additions also budget the generated execution description before committing it.

## Lifetime and authored evidence

Backend shutdown aborts its accepted request scopes and joins their raw work;
it does not close the borrowed manager, source, plugin or OAuth owners. The
actual group service independently fences all asynchronous methods, including
legacy/task-API calls, and retains controller/source promises through final
shutdown. Bounded close failure keeps ownership for explicit retry; accepted
cleanup is still joined after caller authority is withdrawn. The production
owner shuts down/drains the singleton before releasing SQLite/profile ownership.

Authored tests use actual portable SQLite, the real group store/service,
AgentManager, SyncManager, plugin registry and OAuth owner. A controlled adapter
and plugin provide explicit fixture backend/source effects. Coverage includes
all nine operations, retained former membership, distinct grants/foreign epochs,
pre-materialization huge-row refusal, unrelated credential preservation,
resource/source permissions, current binding revocation, actual mutation fences,
raw source retention, failed-close retry, unscoped final shutdown, single-anchor
admission and send-back. This does not establish live provider or native GUI parity.

No tests or checks were executed by this worker. The coordinator runs codec,
backend, service, manager request-scope and native parity suites after all sources
freeze. Full #202/#208/#210/#212 installed-platform, crash/recovery, background
and release/cutover acceptance remains open.
