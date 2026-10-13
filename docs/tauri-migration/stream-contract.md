# Private stream contract, version 1

The private Node peer supports explicitly registered binary streams alongside
the existing version 1 request/event envelope. It does not add a desktop command,
native permission or resource opener. A domain owner must authorize the task,
project, session and resource before returning a stream descriptor; the consumer
registers that descriptor from the authorized result. A packet cannot create an
owner. This Node transport foundation does not establish production PTY/audio/
attachment bindings or installed native parity.

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
and existing request deadline bound otherwise abandoned channels.

Tests exercise fragmented encoded frames, 16 parallel 1 MiB streams, delayed
acknowledgements, exact ownership, sequence/reuse refusal, cancellation during an
ignored raw consumer and terminal event overflow. These are transport tests with
controlled consumers; naming a stream `terminal` does not claim a real PTY,
provider, native WebView or platform integration.
