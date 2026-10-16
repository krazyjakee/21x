# Production payload and recovery acceptance

The bounded acceptance harness is
`scripts/production-payload-recovery-proof.ts`, driven by its adjacent Vitest
test. Source readiness is separate from a successful run and from issue closure.
The engineer authored this harness without running checks; the primary session
owns validation after the batch inputs freeze. Do not treat the workload sizes
below as actual results. The emitted report records actual counters only after
the workload and acknowledged cleanup succeed.

## Reproduction and evidence

After staging the pinned runtime and native dependencies using the existing
project preparation procedure, the primary runs:

```sh
rtk pnpm test:tauri -- --terminal-proofs scripts/production-payload-recovery-proof.test.ts --reporter=default --reporter=json
```

The standalone configuration must include this test in its finite input list.
It runs with the existing runner, which selects staged Node/SQLite/node-pty and
rejects configuration overrides. No dependency, workflow or generator changes
are required by the harness. The integration case requires Linux and the explicit
terminal-proof flag. A skipped integration case is **not** load evidence; the
small evidence-guard cases alone do not establish production acceptance.

Preserve the command, exit status and `PRODUCTION_PAYLOAD_RECOVERY_REPORT` JSON
line from the test log. Attach the implementation revision and working-tree
source hashes, the log's SHA-256, date and exact runner configuration. The JSON
includes platform, architecture, actual Node version, selected artifact hashes,
source hashes, fixture version, expected/actual counter comparisons, sampled
memory, epoch IDs and cleanup receipts. Electron and WebView are explicitly null
in this source/Node run. Do not fill those fields with an installed platform's
versions unless that platform actually ran the relevant proof.
Keep the default reporter alongside JSON: a JSON-only reporter can omit the
console receipt and preserve only assertion outcomes.

The harness allocates its own new temporary root and reopens only its own
synthetic profile. It never accepts a user profile path. The application key
store is an isolated in-memory fixture; keys are erased after owner cleanup.
Remote providers, MCP and connectors are disabled; unexpected provider creation
throws. The real shell is `/bin/bash --noprofile --norc` with a minimal synthetic
environment and no history. Cleanup closes actual owners and requires native
PTY exit observations and zero file descriptors before removing the root.
Failed owner drain retains the disposable profile rather than deleting resources
under unfinished work. No live credential store or installed application is used.

## Actual boundaries and workload

This is the **source production service/private-peer boundary**, running under
the staged standalone runtime. It constructs `ProductionService` through its
existing sealed host, starts the actual `ProductionOwner` singleton and invokes
the finite production codecs over actual `ServicePeer` NDJSON framing. Every
frame is fragmented, beginning with a one-byte fragment and continuing with
79-byte fragments. A typed `getReadyServices()` hook seeds the actual SQLite
owner; there is no fixture RPC or generic stream opener.

| Workload | Acceptance observation | Bound / expected value |
| --- | --- | --- |
| Durable transcript | 1,024 records containing 4,096 Unicode characters each, plus a 400,000-character saved tool and a racing append | Exactly 1,026 unique projected parts after hydration and after profile reopen |
| Concurrent revision | An unread row moves above the fixed snapshot watermark; newer/older/duplicate observations race actual pagination | Newest row wins; unique projection order; delta reconciliation occurs |
| Transcript pages | Actual production command and renderer pagination helper | At most 64 parts / 256 KiB JSON per page; multiple snapshot pages and at least one delta page |
| Large stored tool | Indexed SQLite scalar measurement after display hydration | Full 400,000 characters remain durable; preview is not a destructive truncation |
| Unmount / late reply | Hold an actual page response, abort hydration and release the late frame | Cancelled read; zero parts applied to retired projection |
| Attachment publication | Save a 512 KiB signature-valid synthetic image through `chatImages:saveToTask`, actual backend and actual file owner | Exact saved-byte SHA-256; read/write syscall requests at most 64 KiB; at most one open file descriptor |
| Attachment callback | ID-only private download, owner-produced path receipt and rechecked authorization | One accepted callback; cancelled reply plus retired document cannot accept another |
| Parallel terminal payload | Four actual staged node-pty shells, each emitting 256 numbered 1,024-character lines | Every numbered line exactly once and in order per terminal; bounded event bytes and consumer tails |
| Terminal reconnect | Reattach existing terminal IDs and read actual `terminal:getBuffer` | Same PID without respawn; completion marker in bounded 512 KiB tail |
| Uncertain mutation | Hold the actual reply after a durable task creation, cancel, close and reopen | Exactly one durable sentinel; no automatic mutation replay |
| Epoch replacement | Fresh service owner, read-only transcript hydration; inject old-epoch mutation frame, await service/owner drain and inspect through a separate read-only staged SQLite handle | Exactly two epochs; same durable projection cardinality; one uncertain sentinel and zero stale mutation effects after owner closure; independent inspection handle explicitly closed |
| Teardown | Close real singleton, private handlers and terminal owner before reopening/removal | Four actual native PTY exits and zero remaining attachment FDs |
| Transport resources | Sample actual peer counters at delivery boundaries | At most 128 pending requests, 128 queued frames / 4 MiB and 1 MiB frame payload limit |

The file-owner instrumentation delegates every syscall to the real filesystem;
it only measures requested read/write lengths and open descriptors. It does not
replace attachment publication with an in-memory stream. The synthetic image is
signature-valid transport data, not an image-decoder conformance fixture.

Native attachment download is a **controlled host receipt/authorization callback**.
The harness deliberately does not replace the Rust Save dialog and native copy
with a JavaScript copier and label that native evidence. Native copier chunk
bounds, destination identity, current-document checks and actual installed file
delivery require their separate native/installed receipts.

Terminal events are bounded volatile output. `getBuffer` recovers a finite tail;
it is not durable lossless terminal history. Publisher saturation retires the
epoch and terminal owner. A replacement epoch must not respawn/replay terminal
input automatically. This workload checks exact numbered output during its
healthy delivery window, not recovery of output discarded by saturation.

The report's sampled RSS/heap includes the test runner and production singleton.
It is diagnostic, not proof of constant total RSS. Logical page, frame, queue,
descriptor and consumer-tail limits are asserted independently. Sampling at
delivery boundaries can miss shorter memory peaks; installed runs must retain
their own process/resource measurements. The durable projection intentionally
retains one display record per fixture part.

## Complete issue acceptance map and remaining gates

| Issue criterion | Source evidence / owner | Remaining acceptance |
| --- | --- | --- |
| Versioned byte/undefined encoding, pagination, request/event/stream limits and overflow recovery | `stream-contract.md`, finite codecs, transcript pages and private transport tests | Review actual bound codecs and all production consumers; do not infer a runtime grant from declarations |
| Load large transcripts, attachments and parallel terminal payloads with bounded resources and no lost/duplicate projection parts | This actual-owner harness, production terminal proof and native attachment owner tests | Primary must execute and retain actual receipts; supported installed-platform load/host delivery remains required |
| Partial frames, cancellation, late replies, out-of-order revisions, epoch replacement, unmount and teardown | This harness covers fragmented frames, actual late page response, hydration abort, revision race, callback cancellation, epoch replacement and owner teardown; service/native peer owns malformed/partial EOF, fixed partial-frame deadline, saturation and raw stream-closer regressions | Primary validates combined source; renderer physical unmount/native cancellation and installed process-tree cleanup need platform execution |
| Durable reconnect without automatic uncertain-mutation replay | Actual profile reopen, bounded transcript hydration and exactly-once durable sentinel observation here; renderer/native recovery owners provide production fences | Installed WebView/host reconnect, uncertain OS effects and all remaining consumer recovery paths require receipts |

The private `ServiceStreams` foundation is separate. Production terminals use
finite `terminal:data` events and `terminal:getBuffer`; attachments use saved IDs,
file-owner receipts and native callbacks. Rust `ProductionEngine` has no general
binary consumer registration. Naming an in-memory stream “terminal” or
“attachment” cannot satisfy the domain load criterion. Audio/binary production
consumer coverage cannot be inferred from this harness.

The batch can consume the reviewed finite operation/codec subset from #202
without waiting for its entire contracts umbrella to finish implementation.
The explicit #207 closure prerequisite on #202 remains in force until accepted
or clarified by the tracker owner. Successful source checks, a pushed revision
and this proof alone do not close either issue, pass G0–G5, establish supported
installed-platform parity, authorize live-profile cutover or retire Electron.

Failures name the last counter and its expected/actual values, or a bounded
phase deadline. Investigate the recorded source/artifact hashes and the exact
owner identified in that counter. A startup failure means no load evidence was
obtained; a compilation failure means the integration case never ran. Retain
failed cleanup resources for the owning engineer and report the failure rather
than relabeling controlled callbacks or skipped cases as accepted results.
