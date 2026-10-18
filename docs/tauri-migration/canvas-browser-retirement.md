# Retained canvas data and browser retirement

The production service stores canvas and drawing JSON through the existing
`settings:get`, `settings:set` and `settings:getAll` owners. Both the historical
unscoped keys and `canvas_state:<projectId>` / `drawing_state:<projectId>` remain
data. Their URLs, old broker/session fields, panel IDs, coordinates, layering
and edges grant no navigation, recording replay, process creation or browser
control authority. Project-scoped reads and writes require the current project
grant; an unknown or withdrawn project is refused without changing its blob.

`src/service/production-canvas-retirement.test.ts` exercises the actual sealed
production service and its staged engine with real SQLite profiles and fragmented
private-peer frames. It writes and reads exact JSON strings, closes the complete
service and reopens the same authenticated synthetic profile. Saved and unfinished
historical recording manifests, ordered steps and snapshot bytes are compared by
hash before and after. In particular, production must not instantiate the retired
recording recovery owner, whose historical constructor would rewrite an unfinished
manifest. A working loopback HTTP canary supplies a positive control, then must
receive zero requests from saved panel URLs throughout load, shutdown and reopen.
These fixtures contain only synthetic URLs and page data.

The same suite sends the removed command names across the private peer with a
host that deliberately knows the old schemas. Rejection must come from the real
engine, while a retained settings positive control continues working. An actual
authenticated loopback task API and MCP client test every historical browser
tool: none is advertised or executable. The legacy JSON endpoint convention
returns HTTP 200 with `{ "error": "Unknown route" }`; this is explicit refusal,
not a successful browser action. A task list positive control proves that the
same authenticated server and MCP connection are usable.

The rollback check starts from a fully stopped production profile, copies its
SQLite database and explicitly enumerated recording resources into the existing
marked migration rehearsal directory, then interrupts candidate publication. The
real encrypted snapshot/journal owner recovers, and its candidate and rollback
database must retain the exact inactive JSON. The original database, recording
resources and read-only encrypted backup retain their hashes; repeat recovery
must keep the same backup inode. The rehearsal intentionally normalizes its
working copy from WAL to DELETE journaling before snapshotting; the copy's byte
invariant starts after that explicit fixture preparation. The fully stopped
production original is hashed separately and remains untouched. A separate copy
of rollback output is then reopened through the actual production service and
read through its private settings commands. This is a bounded synthetic copy rehearsal,
not live conversion, an OS credential-store attestation or a release rollback.

Renderer coverage remains owned by #209. Its actual typed native facade test
`native-browser-retirement.test.tsx` renders saved browser/webpage records without
preload, embedding or controls, refuses new panels/control edges and retains
dormant records/edges through settings receipts. Existing canvas/drawing tests
cover layout operations separately. Those controlled UI receipts and the real
Source persistence checks establish different boundaries; neither claims an
installed physical UI or hard-crash guarantee.

The native persistence continuation also covers refused recovery. The original
stores marked an empty placeholder loaded after a refused, corrupt, oversized or
malformed-shape read, allowing the next edit to overwrite saved records. Actual
typed-facade controls reproduced eleven failures, including pending saves crossing
a same-epoch reconnect and reads/writes after pagehide. Native persistence now
requires a successful read on the current captured connection. Connection
retirement synchronously cancels pending saves; a new ready connection retries
only the scoped read. Failed reads remain fenced, and an accepted null is the
separate authoritative empty-state case. Pagehide retires connection observers,
pending timers and future reads. Explicit edits after successful recovery retain
the saved inactive metadata/drawings. Existing Electron behavior is preserved.

Production HTML artifact viewing is still unavailable. Existing artifact reads
are bounded inert content; workspace clipboard receipts and saved raster previews
do not grant an embedded viewer. The privileged main WebView keeps
`frame-src 'none'`. A production viewer requires a separately owned unprivileged
WebView with bounded content/lifetime, no desktop/plugin/event grants, strict
resource/navigation/message policy and acknowledged close. The installed
diagnostics in [artifact authorization](artifact-authorization.md) retain their
original revisions and scope. Their relay checks do not prove privileged-main
iframe isolation or a current production viewer.

Run the new production checks after the existing physical native preparation and
production resource staging:

```sh
pnpm test:host-neutral -- --production-proofs --project=main --maxWorkers=1 src/service/production-canvas-retirement.test.ts
```

The revision-bound #217 evidence records actual commands, versions, resource
hashes, failures/repairs and results. Installed supported-target canvas/viewer
acceptance and hosted CI remain separate gates. Hosted Verify is unavailable
while repository Actions is disabled, awaiting the user's decision. No release,
live-profile cutover, browser restoration or hosted voice work is authorized by
this continuation.

Local verification on 18 October 2026 uses the adopted physical Node 22.23.2
(ABI 127) runner: 2,075 renderer tests in 158 files and 329 affected Source/staged
checks in 19 files pass without skips. Forced no-emit typecheck, lint (zero errors,
165 baseline warnings), database/production staging, both frontends and combined
923-source inventory/contracts pass. The affected count includes the actual Root
retention canaries inherited from `956c5d07`; it is separate from the full renderer
count. Eleven old-store failures, the initial rollback fixture invariant and
viewer fixture typing/lint repairs are retained in revision evidence.
