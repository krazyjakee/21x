# Retained project runtime controls

`ProjectRuntimeBackend` borrows the captured production SQLite manager,
actual `AgentManager`, shared `WorkspaceFileOwner`, and trusted workspace
root. It binds exactly ten existing controls:

| Command | Exact request keys | Result |
| --- | --- | --- |
| `project:getStatus` | `projectId` | Project status and actual live limits |
| `project:getAllStatuses` | None | Active project overview entries |
| `project:getStatusHistory` | `projectId`, optional `query` | Bounded history page |
| `project:getCaptainMemory` | `projectId` | Captain memory or null |
| `projectLimits:getState` | `projectId` | Actual project limit state |
| `projectLimits:isAllPaused` | None | Boolean |
| `projectLimits:pauseAll` | `paused` | Actual resulting pause boolean |
| `concurrency:getState` | `projectId` | Agent levels, pressure and audit |
| `concurrency:setCaptainControl` | `projectId`, `enabled` | Success or existing validation error |
| `concurrency:pin` | `projectId`, `agentId`, `level` | Success or existing validation error |

Optional history query fields retain preload semantics: absent/undefined
values are omitted from the wire, a null cursor starts from the newest page,
and unknown fields are refused. Pin levels are null for unpin or integers
from 1 through 10; the actual manager still checks the selected agent's hard
cap. Results use the existing defined-value envelope and remain below
890,000 bytes. Existing project-status and concurrency events remain owned
by their current emitter and transport bindings.

The status, overview, history, daily-limit and concurrency algorithms are
the existing application algorithms. Trusted internal bounded readers select
only the task/project/agent scalar fields those algorithms use. Optional
manager read-store arguments preserve its actual sessions, durable queue,
resource monitor, stopping/recovery ownership, serial-chain checks, events
and admission scheduling. Default Electron callers continue using their
existing database reads. The bridge does not simulate running agents,
resource pressure, queue entries, counters or successful writes.

SQL checks row counts and scalar/aggregate byte sizes before retrieving or
parsing stored JSON. Maximums include 128 projects, 4,096 distinct tasks per
request, 128 agents, 256 active queue records, 64 KiB configuration fields,
and 20 history entries per page. Finite numeric history limits retain the existing helper's floor/clamp behavior; non-JSON numbers are refused before dispatch. Agent projections use only the actual cap
inputs; unrelated encrypted API keys and task output/attachments are never
deserialized into these reads. Public queue summaries contain only task ID,
agent ID, reason, time and position; internal recovery errors and raw saved
configuration do not cross the boundary. Capacity refusals preserve stored
data and do not invent truncated status/history success.

Current trusted desktop identity, epoch, availability and exact owner leases
are checked throughout each request. Every accessed task, project and agent
requires its current read grant; pinning also requires that agent's write
grant. Project writes require project write authority. Global overview/pause
reads and pause mutations require global configuration authority and every
current project grant, including archived projects. A denied project does
not disappear into an apparently complete global result. Relevant queue
references are checked before a global change can release queued work.

Captain memory accepts only a project ID. The backend selects its actual
Captain row, requires the literal task and shared workspace-scope grants,
and reads fixed `MEMORY.md` through the captured filesystem owner. It never
creates a directory for this read or accepts a caller filename/root. A real
bounded prefix of up to 128 KiB is trimmed, passed through the existing
Captain terminology compatibility function, and clipped to 12,000 UTF-16
characters without splitting a surrogate pair. Files larger than the prefix
retain `truncated: true` and actual nonempty prefix content. Missing memory
is empty with `truncated: false`; a project with no Captain returns null.
Links, physical replacement, changed task/project/repository/session bindings
and withdrawn grants are refused after raw filesystem work as well as before
it. Content is ordinary data and gains no native or WebView capability.

At most sixteen requests and one mutation are accepted concurrently. Caller
cancellation and shutdown fence publication without abandoning accepted
reads or close receipts, and no mutation is automatically replayed. Domain
close joins its accepted operations. The filesystem owner is shared with the
workspace-file domain; the production singleton separately joins its actual
raw descriptor drain before releasing SQLite, the profile key or lock. A
failed raw close remains owned even if the public read has already rejected.
Pausing changes new-start admission; it does not stop running jobs.

Authored tests use actual SQLite, manager algorithms, an in-memory controlled
coding adapter, and real filesystem descriptors in isolated synthetic
profiles. They cover actual counts/queue/approval facts, history/recovery,
audited pins/control/global pause, no credential deserialization, current
global/agent/task grants, bounds before JSON parsing, literal memory and
links, changed bindings, cancellation and raw drain/backpressure. These are
controlled owner proofs, not live SDK, installed-device or all-platform
evidence. Production integration, native policy parity and final checks are
coordinator-owned. Full #202/#208/#210/#212 migration, installed-platform and
retirement gates remain open; no live profile conversion or release is
authorized by this slice.
