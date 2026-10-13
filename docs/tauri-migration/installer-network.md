# Portable CLI installer networking

The `InstallerNetwork` core takes an explicit fetch client and imports no
Electron host. It is part of [#213](https://github.com/krazyjakee/21x/issues/213)
and [#222](https://github.com/krazyjakee/21x/issues/222). The legacy installer
wrappers still select Electron `net.fetch`, preserving their system-proxy host.
They delegate network behavior and close each owner after the call settles.
A future Tauri installer host must explicitly supply its networking/proxy client
and include the owner in production shutdown; those bindings remain open.

JSON requests retain the existing null-on-failure behavior and eight-second
deadline, with a two-MiB body limit. File downloads use the host's standard
redirect handling, a five-minute deadline and a one-GiB byte limit. Node stream
pipelines apply backpressure. A private sibling file is published through rename
only after streaming finishes; failure/cancellation removes owned partial files
and preserves any previously downloaded destination. Errors expose fixed
classifications or HTTP status rather than dependency URL/path/secret details.

`stop()` closes admission and aborts fetch/stream work. `close()` waits for raw
fetches, actual reader cancellation, file closure and partial cleanup. Its
one-to-three-second deadline rejects without dropping pending ownership; a
later close can join that work. A fetch or body cancellation implementation that
ignores cancellation therefore cannot yield a successful early close.

Tests use real loopback HTTP for redirects, exact streamed bytes, invalid/large
JSON, status failures, stalled bodies and destination preservation. Injected
clients separately hold late fetch and reader-cancellation acknowledgements.
Legacy adapter controls select the mocked host fetch and retain header/null
semantics. Tests do not download or execute real installers, prompt for privilege,
attest system proxy behavior or validate release-asset signatures/checksums.
CLI process ownership, packaged native handlers, provider installation and
production release provenance remain open.

[Local evidence](evidence/installer-network-local.json) records 1,055 complete
standalone/private-pipe passes with zero skips in 76 files and 5,267 full
application passes with 20 optional skips in 376 files. All ten core controls
and two legacy adapter controls passed. Typecheck, changed-source lint,
source/contract freshness and the existing desktop/mobile build passed. These
results use local fixtures and retain their explicit scope.
