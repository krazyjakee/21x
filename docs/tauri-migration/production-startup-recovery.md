# Production startup recovery states

The #208 recovery continuation uses the actual `ProductionOwner` and its one
profile/database/key lifetime. It adds a private, empty-argument
`engine.ownerState` read after epoch negotiation. It is absent from the public
desktop command registry and cannot select a profile, path, PID or retry.

The result is exact finite `{phase, stage, code, owned}` metadata. The shared
TypeScript codec and independent Rust allowlists reject unknown fields and
values. Internal error wording and arbitrary error-code suffixes never cross
this observation boundary. Merely observing does not advance state, reopen
admission, repeat initialization or release a blocked owner.

When initialization fails, native requests that metadata before its existing
startup guard retires the epoch. It promotes only failed/blocked finite state
to the existing `engine_status.startupFailure`. Missing/unavailable metadata
preserves the original bounded startup failure. No public protocol error code
is extended and no failed mutation is replayed to obtain diagnostics.

Fixed renderer wording provides provisioning/relaunch instructions for missing
resources/managed CLI, unavailable CLI readiness, profile ownership, busy or
corrupt SQLite, unavailable protected storage and insufficient disk capacity.
Blocked cleanup is distinct from released failure; observing it supplies no
permission to reclaim a still-owned profile.

Disk-full/quota failure during sentinel/profile creation now remains
`PROFILE_LOW_DISK` instead of being hidden as invalid ownership. Free-space
preflight still rejects less than 8 MiB before credentials or application DB
initialization. SQLite busy/locked and corrupt/not-a-database errors retain
separate fixed recovery codes. The read-only credential/database preflight has
a one-second SQLite busy deadline; refusal neither migrates nor replaces data.
Actual credential failure never creates a replacement key on a load attempt.

Regressions use actual profile locking and SQLite, a real exclusive database
lock followed by an explicit successful relaunch, controlled filesystem
capacity/quota failures, missing managed executable paths and held raw drains.
The actual Source private peer exposes a failed owner after initialization;
Rust's actual pending-response validator accepts the metadata and maps its
failure stage. Unknown values, extra private fields and pre-epoch reads refuse.
Renderer tests verify fixed guidance with canary paths/error text present in
untrusted input. Controlled CLI-readiness errors validate projection; they are
not an installed vendor CLI test.

The [local recovery evidence](evidence/issue-closing-20261017-startup-recovery.json)
records each command, source/artifact digest, fixture/schema,
OS/Node/Rust versions, exact results and repairs. Cross-target `cargo check`
for the production engine covers Windows MSVC and both macOS architectures;
it is compile evidence, not a native runtime or installed WebView claim.
Repository Actions is disabled pending user decision. No workflows are
dispatched and no settings endpoints are used.

Other #208 criteria remain separate: conservative interrupted queue/effect
reconciliation, all-platform containment/private bootstrap, forced-quit and
installed background/process-tree acceptance. This continuation does not
weaken the non-Linux containment refusal or close #202. Shipping Electron,
live profiles/release policy and deferred hosted voice remain unchanged.
