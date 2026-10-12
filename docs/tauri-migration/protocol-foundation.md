# Private service protocol foundation

This first implementation supplies the transport part of T04. It does not complete the command inventory, permissions, host services or service extraction, and does not accept G1. The experimental Rust host and feasibility service implement the same wire envelope separately while packaging is being established.

The reusable TypeScript implementation is [service-protocol.ts](../../src/shared/service-protocol.ts), [framing.ts](../../src/service/transport/framing.ts) and [peer.ts](../../src/service/transport/peer.ts). They import no Electron modules, Node built-ins or external runtime dependencies. A pipe adapter supplies `write(bytes)` and feeds incoming bytes to `receive(bytes)`. `write` resolves when the bytes drain and rejects when the pipe closes. Pipe EOF calls `end`; a process exit or transport error calls `disconnect`. `onDisconnect` closes the owned pipes. A disconnected peer is terminal; create a fresh peer for a fresh engine lifetime.

## Version 1 envelope

Each frame is one UTF-8 JSON value followed by LF. CRLF is accepted as JSON whitespace; empty lines, BOMs, malformed JSON, invalid UTF-8, unknown envelope fields and truncated EOF are errors. Byte framing accepts arbitrary split codepoints and multiple frames in one input chunk. Stdout must carry only protocol frames; dependency and application logs belong on stderr with appropriate redaction.

Every frame has `protocolVersion: 1`, `engineEpoch` and `kind`. Required fields by kind are:

| Kind | Fields |
| --- | --- |
| `request` | `requestId`, `operation`, `payload` |
| `response` | `requestId`, exactly one of `result` or `error` |
| `event` | `operation`, `payload`, optional `sequence` |

`payload` and `result` are explicit JSON values, including `null`; missing and `undefined` are invalid. JSON nesting is capped at 64 levels. Operation names are at most 128 characters, start with an ASCII letter, and then contain letters, digits, `_`, `.`, `:` or `-`. Epochs are 1–128 ASCII letters, digits, `_` or `-`, apart from the bootstrap request's empty epoch. `sequence` is an optional nonnegative safe integer; stream owners are responsible for continuity and recovery.

Request IDs are monotonic positive decimal counters prefixed `host:` or `service:`, with 1–32 digits and no leading zero. Each peer uses its own prefix. Counters increase across all operations in one peer lifetime and may have gaps. A constant-space high-water mark rejects request replay even after a handler has completed. Responses use the initiating peer's ID and may complete out of order. Duplicate and late responses are ignored. Wrong-direction IDs are fatal protocol errors.

For example:

```json
{"protocolVersion":1,"engineEpoch":"","kind":"request","requestId":"host:1","operation":"engine.initialize","payload":{"protocolVersion":1,"profileRoot":"/isolated/profile","resourceRoot":"/bundle/resources"}}
{"protocolVersion":1,"engineEpoch":"engine_example","kind":"response","requestId":"host:1","result":{"protocolVersion":1,"engineEpoch":"engine_example","nodeVersion":"v22.0.0"}}
```

The service creates its epoch before processing bootstrap. The host begins with no epoch and permits only one outstanding bootstrap (`engine.initialize` or `engine.ping`). It adopts the epoch only from a successful correlated response whose result is exactly `{ protocolVersion: 1, engineEpoch, nodeVersion }` and whose epoch equals the envelope's nonempty epoch. Register operation schemas on both peers: initialize payload uses `isInitializePayload`, bootstrap results use `isBootstrapResult`; the feasibility ping payload is exactly `{}`. Initialization must finish before service-to-host native callbacks or domain events. Future initialization needs should extend the shared contract before changing fields.

After bootstrap, epochs must match. Stale responses and events are discarded. Stale requests receive a `STALE_EPOCH` error without reaching handlers. Unknown operations and invalid arguments receive fixed errors. Operation registration requires payload and result validators; validation occurs before invoking the handler and before settling the corresponding call. This envelope foundation does not itself authorize callers, canonicalize paths or grant arbitrary file access.

## Resource and failure limits

| Limit | Value and behavior |
| --- | --- |
| Frame | 1 MiB excluding LF; measured in UTF-8 bytes; oversize input closes the peer |
| Pending outgoing requests | 128; further calls reject with `BACKPRESSURE` |
| Active incoming handlers | 128; further requests receive `BACKPRESSURE` |
| Outgoing queue | 128 frames and 4 MiB, including the frame currently draining |
| Request deadline | 30 seconds by default; callers may choose a shorter positive timeout |
| Incoming handler deadline | 30 seconds; abort signal and `TIMEOUT` response |
| Pipe stall deadline | 30 seconds per write; disconnects the peer |

Queue overflow is explicit. Callers may handle `emit` backpressure with operation-specific recovery; durable transcript publishers should signal or arrange snapshot/delta recovery rather than dropping arbitrary revisions. Terminal/audio chunking and overflow policies still belong to their future stream adapters. No stream chunking or sequence tracking is supplied by this foundation.

The additive [transcript page contract](transcript-pages.md) now supplies bounded durable display reads: 64 parts/256 KiB UTF-8 JSON, indexed SQLite iteration, fixed revision watermarks and separate sequence/revision cursors. A scoped renderer helper hydrates and reconciles without advancing recovery from live-event cursors. This implements transcript read recovery; general binary/audio/terminal stream and publisher overflow policies remain open.

`engine.cancel` is a reserved event with exactly `{ requestId }`. Local cancellation and timeout remove pending correlation/timer/abort-listener state and send advisory cancellation when an epoch is available. An unsent queued request is discarded if its caller has already cancelled or timed out. A handler receives an `AbortSignal`; its active slot remains occupied until its promise settles even after cancellation or timeout, so uncooperative handlers cannot accumulate beyond the active cap. Cancellation does not establish whether a running mutation committed.

Pipe failure rejects every pending request, aborts active handlers and discards queued frames. Raw active handlers stay owned until their promises settle; abort/disconnect never proves an effect stopped. A queued handler is not entered after cancellation/disconnect before its first microtask. Terminal `waitForHandlers` provides a bounded 1–3,000 ms wait (2,000 ms default), separate from successful response/queue draining. Timeout rejects without clearing raw ownership; database/provider/profile-lock owners must retain resources until process exit if that wait fails. Late handler results cannot send replies on the failed peer. Pending calls, task starts, approvals and other mutations are never replayed automatically. Recovery must create a new peer, handshake, inspect persisted state and apply operation-specific idempotency rules.

Errors are `{ code, message }`, where `code` is a member of `SERVICE_ERROR_MESSAGES`. Outgoing errors use fixed messages. Remote messages are validated as bounded strings but never exposed to callers; callers receive the local fixed message for the stable code. Arbitrary handler exceptions become `INTERNAL_ERROR`. Parser and disconnect diagnostics never include raw frame text, operation arguments, paths, secret payloads or thrown exception messages.

## Verification and remaining integration

[service-protocol.test.ts](../../src/shared/service-protocol.test.ts) provides deterministic cases for byte splitting/coalescing, malformed UTF-8/JSON/BOM/EOF, exact and oversized frame limits, strict schemas, handshake correlation, mismatched epochs, bidirectional callbacks, out-of-order and late responses, error redaction, timeouts, cancellation, request replay, pending/active/queue caps, stalled pipes, disconnect and unsent mutation expiry. Unit cases use fake timers where deadlines matter and in-memory pipe adapters. Additional wire fixtures spawn the actual feasibility service under standalone Node and use the shared peer to verify bootstrap, ping, errors, shutdown, BOM rejection and cancellation validation. These tests require no Electron behavior, database profile access, native dependencies or native compilation.

The coordinator validates this foundation at batch end; see [implementation status](implementation-status.md) for evidence. Both TypeScript projects include the host-neutral transport; the main project includes service sources directly. The experimental Rust supervisor and Node service have actual pipe integration and cross-language fixtures. Domain service extraction and durable stream recovery remain future work.

Cross-language fixtures and packaged platform probes remain necessary: Rust must implement the same strict envelope, cancellation, bounds, IDs, redaction and epoch behavior; the experimental pure `.mjs` entry is not automatically using this TypeScript peer. Production bootstrap path provenance, caller permissions, profile locking, parent-death cleanup, stream recovery and operation-specific retry policies remain workstream gates.
