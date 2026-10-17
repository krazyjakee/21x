# Portable task API and shutdown ownership

## Production signed stdio continuation — issue #213, batch35

Production staging selects `src/service/production-task-mcp.ts` for
`service/production-task-mcp.mjs`. Its owned proxy requires `TASK_API_URL` and
the app-issued signed `TASK_MCP_URL`; the latter is the only destination used
for tool listing and calls. Missing/malformed URLs, non-loopback origins,
duplicate/unknown authority parameters and malformed token/signature shapes
fail before fetch. The actual server checks the per-launch token and HMAC on
every request. A valid-looking URL alone cannot advertise tools. Legacy
`TASK_SCOPE_*`/artifact environment pins and caller-supplied body scope never
replace this authority, and no plain JSON route fallback exists in this entry.

Both listing and dispatch exclude retired browser tools, including when a
legacy server advertises them. The returned list intersects the server's names
with the local retained catalog for the signed scope; schema/implementation
definitions remain shared. Other retained calls, including group tools, reach
the same actual task API scope checks. The old shipping stdio entry remains a
separate build input; production no longer adopts its legacy availability or
partial signed forwarding behavior.

Each request has a 15-second deadline and 16 MiB request/response limits,
matching the task API body budget. Four raw requests may be admitted at once.
Redirects, mismatched RPC IDs, HTTP/protocol errors, unsupported content and
non-text results fail with fixed errors that omit URLs, tokens and dependency
messages. The owning endpoint produces JSON; this private proxy does not
interpret arbitrary remote SSE. Cancellation promptly settles the public
request while retaining actual fetch/reader/cancel ownership. Shutdown revokes
admission and cancels pending requests; an incomplete bounded close retains
work for retry. The entry joins owner/server shutdown on stdin closure and
termination signals.

Regressions exercise actual loopback Task API/SQLite project and subtask
behavior, token/signature rejection, retired tools, bounds, held cancellation
and admission. The standalone proof bundles the production entry with the
same builtin-only boundary used by resource staging, launches it with the
pinned Node and empty PATH, and uses a real MCP client. It checks project
filtering, cross-project rejection, task-pinned artifact creation despite
conflicting environment/body IDs, every retired browser call, forged scope,
wrong tokens, actual child close and unrelated-child preservation. It uses
synthetic temporary profiles only.

[Exact revisions, commands and artifact hashes](evidence/batch35-213-task-stdio.json)
record the scope and results. These are local bundled integration checks,
not installed GUI/provider or supported-platform acceptance. Native OAuth
callbacks remain unavailable pending #215; #208/#202 and the full #213
acceptance checklist remain open. Repository Actions is disabled pending a
user decision, so no hosted Verify success is claimed.

## Earlier portable extraction evidence

`task-api-server-core.ts` runs the existing task/skill/session/UI/artifact/review
routes and HTTP MCP endpoint under standalone Node with an explicit portable
database. It imports no Electron host. The legacy adapter supplies the existing
embedded-browser route explicitly; the portable default excludes its tools from
MCP listing and rejects their calls before dispatch. Saved recording access
requires its separate retained-data port; this change does not delete recordings
or count production browser retirement as complete.

Bearer/query authentication and signed MCP project/task scope credentials remain
in place. Authenticated bodies are limited to 16 MiB before JSON/domain dispatch.
The existing source regressions use actual in-memory SQLite/schema and loopback
HTTP; a real MCP client lists tasks and verifies exclusion/refusal of every
legacy browser tool. Agent-controller behavior is injected, not a real model
session or native renderer binding.

`TaskApiListener` owns listener startup, native close and each raw request handler.
Stopping closes admission and sockets; a disconnected socket cannot release an
unfinished route. `closeTaskApiServer()` permanently closes each participating
database source, joins retired listeners and handlers, and refuses stale startup
publication/recreation. Its one-to-three-second deadline rejects without dropping
raw ownership; a later close may join the work.

The application teardown stops task API admission before stopping agents, then
joins the API alongside connector/source owners before SQLite close. A failed
drain follows the existing failure-exit path and retains database/profile
ownership until process exit. The prototype packaged service bundle remains
synthetic-only and unchanged by this extraction; production Tauri bootstrap,
native bindings, other API/mobile/secret owners and full process trees remain
[#208](https://github.com/krazyjakee/21x/issues/208) /
[#213](https://github.com/krazyjakee/21x/issues/213) work.

Lifetime controls stop during startup, hold a final SQLite write after client
disconnect and a failed close, retry the join, reject recreation, validate
deadlines, close unused listeners, reject oversized bodies before mutation and
close unauthenticated unfinished uploads. Source/report hashes and exact commands
are recorded in [local evidence](evidence/task-api-owner-local.json). Installed
GUI/real-provider acceptance remains separate.

Final local validation passed 1,146 complete standalone/private-pipe cases with
zero skips in 80 files and 5,281 full application cases with 20 optional skips
in 378 files. Focused standalone API/skill/lifetime checks passed 84 cases;
legacy API/MCP checks passed 338. Forced typecheck, source/contract freshness,
changed-source lint (one existing warning) and desktop/mobile build passed.
The synthetic service restage remained byte-for-byte unchanged.

The existing 23 HTTP MCP endpoint regressions also run under standalone Node,
using the portable session-config helper and joining API close before SQLite
cleanup. [MCP evidence](evidence/task-mcp-portable-local.json) records all 23
passes under each launcher, including signed scope, project/task isolation, tool
visibility and delegated fixture controllers. GitHub interactions are fixtures
and temporary local repositories; no real remote write or model call is made.

The [four-target service run](https://github.com/krazyjakee/21x/actions/runs/38364232789) passed 1,137 default portable cases with zero skips in 76 files on Windows x64, Linux x64 and both Macs at `08d495f`. [Retained evidence](evidence/task-api-service-four-target-scenarios.json) preserves the report hashes and staged native/private-service controls. This revision predates the later HTTP MCP test registration, mobile and task automation lifecycle changes.
