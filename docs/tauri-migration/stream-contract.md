# Private stream contract, version 1

The private Node peer supports explicitly registered binary streams alongside
the existing version 1 request/event envelope. It does not add a desktop command,
native permission or resource opener. A domain owner must authorize the task,
project, session and resource before returning a stream descriptor; the consumer
registers that descriptor from the authorized result. A packet cannot create an
owner. This Node stream primitive does not establish production PTY/audio/attachment
bindings or installed native parity. Existing production terminal and attachment
routes described below do not use this primitive.

Bytes use the exact object `{version: 1, encoding: 'base64', byteLength, data}`.
Canonical base64 and decoded length are validated before consumption. Buffer JSON
objects, implicit typed-array coercion, unknown versions and empty byte packets
are rejected. An empty stream ends without sending a byte packet. Optional command
results retain the existing `{defined: false}` or `{defined: true, value}` envelope;
optional object fields are omitted, and nested `undefined` is not JSON. These
representations are deliberate; no generic recursive coercion grants a codec.

Each stream carries a directional ID and exact opaque owner ID. Only one chunk
may be in flight for that stream, and the producer must await its acknowledgement.
The consumer acknowledges only after processing it. Chunks cap at 32 KiB; a peer
owns at most 16 streams and allows at most 4,096 distinct stream IDs per epoch.
Closed IDs cannot be reused. Sequence numbers advance by one; duplicates, gaps,
unknown IDs and foreign owner IDs do not reach a consumer. There is no public
`engine.stream.open` operation.

The existing peer caps requests/handlers at 128, frames at 1 MiB and its outgoing
queue at 128 frames/4 MiB. Saturating an event publisher disconnects that epoch
instead of silently dropping an invalidation. Durable state owners rehydrate
using their bounded snapshot/delta pages on a new connection. No request or
uncertain mutation is automatically replayed. Existing transcript pages keep
their 64-part/256 KiB cap and fixed snapshot/delta watermarks.

Cancellation, unmount, idle expiry and pipe teardown abort both stream owners.
The supplied resource closer must actually stop its producer/consumer. A raw
consumer that ignores abort retains its stream slot until it settles, and failed
cleanup retains ownership. Shutdown deadlines end the caller's wait, rather than
releasing a database/profile underneath unfinished work. The 30-second idle limit
and existing request deadline bound otherwise abandoned channels. Request abort
invokes the reader resource closer immediately, before waiting for its raw
consumer; a closer can therefore unblock a consumer that ignores the signal.
A failed closer disconnects the peer and keeps its slot and failed drain owned.

Tests exercise fragmented encoded frames, 16 parallel 1 MiB streams, delayed
acknowledgements, exact ownership, sequence/reuse refusal, cancellation during an
ignored raw consumer and terminal event overflow. These are transport tests with
controlled consumers; naming a stream `terminal` does not claim a real PTY,
provider, native WebView or platform integration.

An incomplete incoming frame has a fixed 30-second lifetime from its first
fragment. More fragments do not renew it. Completing a frame retires that timer;
a subsequent partial frame gets its own deadline. Partial EOF is `INVALID_FRAME`,
and expiry disconnects with `TIMEOUT`. Complete frames still retain their own
operation deadlines (including the existing longer attachment-download deadline).

## Existing production routing

`ProductionService` publishes through the same bounded `ServicePeer` queue.
Publication saturation disconnects the epoch and fences the actual
`ProductionOwner`; it does not silently discard an invalidation. A replacement
connection must be initialized and durable state read again. Transport requests,
PTY input and uncertain native attachment effects are never automatically replayed.

- `TerminalBackend` borrows the actual `TerminalServiceCore` PTY owner. Its exact
  `terminal:data` events contain at most 16 KiB of UTF-8 data; one raw source
  callback caps at 4 MiB. `terminal:write` caps at 64 KiB. `terminal:getBuffer`
  returns at most 500 lines / 512 KiB. Epoch, caller, directory and process
  generation checks remain in that domain owner. The buffer is a bounded tail,
  not a durable lossless transcript: saturation can retire the PTY and cannot
  promise recovery of all historical terminal output.
- `TaskAttachmentBackend` accepts existing exact attachment commands. Image save
  input totals at most 512 KiB (up to five images); saved attachment metadata caps
  at 128 records / 128 KiB. Open/download use task and attachment IDs, not supplied
  paths. `TaskAttachmentFileOwner` holds the authorized source descriptor and
  passes an exact receipt to the native callback; Source does not read the whole
  download into an RPC byte packet. Existing native download work copies bounded
  chunks under the original live authorization ticket. This route does not need
  a generic native stream registry or new fixture operation.
- Durable transcripts use the existing version-1 `agentSession:getTranscriptPage`
  snapshot/delta contract (64 parts / 256 KiB per page). Recovery starts from a
  fresh snapshot watermark and reconciles revision windows through
  `hydrateTranscriptProjection`; live events cannot advance its safe recovery
  cursor. The projection rejects stale revisions. Cancellation or a superseded
  selection prevents late page application. See [transcript pages](transcript-pages.md).

## Acceptance boundaries for the payload recovery batch

| Issue criterion | Required source subset and evidence boundary |
| --- | --- |
| Version encodings, pages, limits, overflow | Existing byte/optional-result codecs, finite production codecs, page contract and queue disconnect policy above; no public API added. |
| Large transcripts, attachments, parallel terminals | Production source/private-peer harness must use disposable SQLite, actual PTY owner and attachment callbacks. Controlled binary stream tests alone do not cover these domains. Record bounded queue/page/chunk measurements and exact expected/actual identities and bytes. |
| Partial frames, cancellation, late replies, revisions, epoch, unmount, teardown | Transport regressions cover fixed partial deadlines, EOF, cancelled consumer closer ordering, retained cleanup failure, late replies and terminal epochs; page/projection tests cover revision races and cancelled late pages. Native and harness owners supply their boundary evidence. Written tests are not passing evidence until primary validation. |
| Reconnect and uncertain mutations | Fresh connection plus bounded snapshot/delta hydration; no transport replay. Harness must prove durable recovery separately from the terminal tail and native effect lifetime. |

The required #202 dependency here is its already integrated finite operation,
optional-result, terminal, attachment receipt and transcript-page codec subset.
That code dependency does not establish acceptance or closure of the complete
#202 contracts issue. Its explicit closure prerequisite remains in force.
Installed WebView lifecycle, native dialogs/copy behavior and supported-platform
acceptance require their own actual runs; an in-process production source/peer
proof must not be labeled installed or packaged stdio evidence. This document
records source scope, not successful execution of the pending batch checks.
