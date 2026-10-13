# Portable task API and shutdown ownership

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
