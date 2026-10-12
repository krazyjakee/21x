# Renderer connection lifecycle

`src/renderer/src/lib/desktop-client.ts` is the host-neutral client for retained
desktop operations. It requires explicit command and event codecs rather than
serializing arbitrary preload arguments. Command results use the shared
`OptionalResult` envelope, so an absent result differs from a JSON null.

A native adapter supplies an epoch obtained from trusted bootstrap, invokes
authorized operations and installs the targeted event listener. The client
becomes ready only after that listener is installed. Events arriving during
registration are buffered within the shared frame/queue limits. Events require
a global sequence for that connection; duplicates are ignored and gaps invalidate
the connection. The native publisher must sequence the exact stream delivered
to this desktop, rather than mixing counters with mobile or other sinks.

Each new ready connection requires state owners to hydrate snapshots and reconcile
durable deltas. The client preserves subscriptions across reconnects, rejects
pending requests from the old epoch and never replays them. A timed-out or
cancelled mutation may have committed; its owner must reconcile durable state.
Cancellation settles the renderer request and signals the adapter, but actual
service cancellation depends on the adapter's implementation.

Disposal cancels pending requests and releases the native listener, including
when registration finishes late. Separate callback registrations remain
independent. Consumer callbacks cannot leak raw diagnostics into native logs.

The client enforces transport/lifecycle constraints. Native WebView authority,
domain permissions and operation schemas remain required at their privileged
boundaries. Production renderer adoption and a complete operation binding set
are still open; this module does not grant access or close G1/G2.
