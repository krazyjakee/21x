# Bounded durable transcript pages

Status: implemented scoped work for [#207](https://github.com/krazyjakee/21x/issues/207), with local real-service/native-engine evidence. Attachment/audio/terminal streams, general overflow recovery and installed-platform load evidence remain open. This does not close G1/G2.

## Command and version

`agentSession:getTranscriptPage(taskId, page)` is an additive read-only desktop command. Existing Electron snapshot/delta APIs and their complete chronological result semantics are preserved. Its named wire request is:

```json
{"taskId":"task-id","page":{"version":1,"mode":"snapshot","after":0,"limit":64}}
```

`page` requires exact `version`, `mode` (`snapshot` or `delta`) and nonnegative safe-integer `after`. Optional `watermark` and `limit` must be omitted when absent, rather than supplied as null/undefined. The limit is 1–64; a later page repeats the first reply's watermark. Unknown fields/versions and future watermarks reject. The result inside the usual `OptionalResult` is exactly:

```json
{"version":1,"taskId":"task-id","mode":"snapshot","after":0,"parts":[],"cursor":0,"watermark":0,"hasMore":false}
```

The page format has its own version 1; the private service envelope remains version 1. Native and TypeScript validators agree on fields, safe integers, part identity, ordering, progress, revisions and byte limits. The native reply must match the requested task, mode, cursor, optional watermark and requested count limit before delivery. The service rechecks project/task authority and the profile lock immediately before its synchronous read; a missing task is denied. No page operation can start an agent, change data, accept a renderer path or enable model/tools/credentials.

## Bounds and display semantics

- At most **64 returned parts**, and **256 KiB of UTF-8 JSON per page**, below the 1 MiB pipe-frame ceiling. The count and byte budgets apply independently.
- An indexed SQLite iterator reads at most the requested count plus one lookahead row. It does not fetch or materialize a whole transcript.
- SQLite limits text/serialized-JSON fields to **8,192 codepoints before JavaScript materialization**. Oversized content becomes a prefix; oversized tool/payload JSON is omitted with a visible preview notice. Normal bounded fields retain their values. Oversized identity metadata rejects rather than inventing an identity.
- Previews retain task/part IDs, sequence, revision and timestamps. They are presentation only and never written back to SQLite. A large permission/tool whose JSON is omitted does not supply an actionable request identity to approval controls. Full-record retrieval/export and retained binary stream behavior require their own authorized contracts.

Page readers stream validated parts into the existing projection cache, which orders by `(createdAt, seq)` and refuses older revisions. They do not accumulate a second aggregate snapshot array. The cache itself holds the selected transcript; this is not a claim that the full production renderer has a bounded cache or that general workload/performance budgets have passed.

## Cursor and race recovery

Snapshot pages advance **sequence** in ascending order, while a fixed **revision watermark** bounds the window. Sequence is not chronology and is not a revision: backfilled parts may have older timestamps, seq gaps can exist, and revisions are globally allocated across tasks. The projection restores display chronology separately.

A watermark bounds current row versions, not an MVCC copy of the original transcript. A row updated above that watermark before its snapshot page is read is deliberately excluded from that page. After the entire snapshot window, read delta pages from the captured snapshot watermark. This recovers skipped/updated rows and new rows without retaining a transaction across requests.

Delta pages advance revision, in ascending order. When `hasMore` is true, `cursor` is the last returned revision. When the fixed window is complete, `cursor` is its watermark, including gaps caused by rows updated beyond it; those newer row versions belong to the next delta window or live events. A snapshot cursor never substitutes a revision watermark. Every returned part belongs to the selected task and has revision at or below the page watermark.

The hydration helper keeps its own recovery cursor even if live events advance the cache revision during pagination. It applies pages without declaring their revision window complete, reconciles deltas from the captured watermark and only then marks recovery complete. Older snapshot rows cannot overwrite newer live parts. Failed/partial hydration does not advance its safe recovery cursor. A service/epoch change requires a fresh client connection and recovery; no request or mutation is replayed by this helper.

Reads have a 30-second deadline per window and at most 4,096 pages, with event-loop yields between pages. Caller cancellation/unmount or connection loss aborts the reader; late results are not applied. Repeated watermarks, requested task/mode/count, strict monotonic progress and empty-page termination are checked before applying each page. The synthetic UI aborts superseded selections and keeps approval controls disabled until transcript hydration completes.

## Local evidence and remaining work

### Live update continuation

The synthetic service now replaces oversized durable transcript updates with a bounded `{taskId, parts: [], maxRev, reloadRequired: true}` invalidation. Its bridge verifies each task/part/revision by indexed lookup and forwards canonical SQLite values rather than trusting event content. It checks all identities even when a batch exceeds display limits; foreign/missing/duplicate identities and stale/future revisions still reject. At most 4,096 incoming owner references are accepted, with 64 parts and 256 KiB budgets for normal output. Individual content/tool/payload fields are bounded in SQLite before event materialization. The broader AgentManager flush and production clients still require workload validation; this removes the service bridge's full-history validation read, not every full-history read in the app.

Approval verifies the exact durable permission identity with an indexed SQL predicate, including when a large display card is omitted. A preview never grants approval authority. Repeated invalidations coalesce during active synthetic UI recovery rather than repeatedly aborting it. Recovery retries at most three windows before reporting backpressure; controls remain disabled on incomplete recovery.

Continuation validation passed 40 focused TypeScript cases, a forced TypeScript rebuild, changed-source lint and the isolated frontend build. Nine new durable event tests cover canonical values, count/UTF-8 overflow, multi-megabyte fields, invalid/stale identities and exact permission checks. Three mounted renderer tests cover task display, repeated invalidation recovery and stale replies after selection changes. The real bundled proof recovered 642 records after **21 bounded invalidations**, with unchanged page budgets, durable oversized tool data and acknowledged exit. The bundled agent approval/completion proof passed again. General transport queue saturation still disconnects explicitly; terminal/audio/attachment streaming and installed-platform load/reconnect evidence remain open.

The latest combined [issue continuation evidence](evidence/issue-continuation-local.json) records the current source/resource hashes and full recheck (5,148 passed / 4 skipped, 363 files; 20 native unit + 6 staged cases). The original pagination report below identifies the earlier batch's source, not this subsequent event/configuration/lifecycle integration.

[Database tests](../../src/main/database-transcript-page.test.ts) cover 513 identities, reverse event times, count/UTF-8 budgets, multi-megabyte stored fields, metadata rejection, global revision gaps and updates/inserts between pages. [Renderer tests](../../src/renderer/src/lib/transcript-pagination.test.ts) cover live-event cursor races, partial failure, cancellation/late results, deadlines, changed watermarks, foreign replies and page-count caps. Rust validates malformed requests/results, byte bounds and request/result association; its actual staged database roundtrip exercises the new command through the native engine.

The [bundled private-pipe proof](../../scripts/transcript-page-proof.mjs) passed against standalone Node 22.23.2 and SQLite 13.0.3: **642 parts**, **43 snapshot pages**, **3 delta pages**, a largest reply of **248,188 bytes** under the 262,144-byte cap, racing updates/inserts recovered, a stored 400,000-character tool output preserved, malformed/missing-task requests denied, acknowledged service shutdown and synthetic profile removal. Its [retained evidence](evidence/transcript-pages-local.json) identifies the working-tree source hashes. Both packaged proof workflows now run this service proof after synthetic staging.

Focused local validation passed **338 TypeScript cases** (including the opt-in bundled proof and four actual binding-authority cases), **18 Rust unit + 5 staged cases**, typecheck, changed-source lint, native host compilation and the isolated frontend build. Binding tests reject denied/revoked project access, missing tasks, foreign labels/principals, stale epochs and cancellation before querying transcript rows. The existing bundled deterministic-agent approval proof passed with 15 observed events. General attachments/binary/audio/terminal chunking, event overflow and broad workload/reconnect/installed UI evidence remain #207 work. The full renderer, real providers and historical/live profile integration remain separate gates; earlier installed reports do not certify this new source revision.
