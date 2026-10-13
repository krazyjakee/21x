# Explicit private production transport

`ProductionService` attaches the real `ProductionOwner` and
`ProductionDesktopBindings` to `ServicePeer`. It uses the finite production
command codecs and their actual domain owners. It does not expose a bootstrap
operation that accepts paths, credentials, factories, caller identities, or
namespace grants. Electron shipping entry points and the diagnostic service
remain unchanged.

The separately staged `production-stdio.mjs` is a Node-only resource gate.
`scripts/tauri-stage-production.mjs` is an explicit invocation, separate from
shipping/default staging. It requires the prepared standalone Node 22.23.2,
physical SQLite/native modules and pinned SDK packages, plus an explicitly
staged `native/twentyonex-credential-key` executable (`.exe` on Windows).
The script refuses Electron imports and unreviewed bundle imports. Missing
resources fail staging; neither repository `node_modules` nor a executable
found on PATH supplies missing runtime dependencies.

A trusted private launcher supplies one bounded UTF-8 JSON descriptor through
an anonymous FD3 pipe and communicates through private stdin/stdout pipes.
The descriptor carries an exact launch ID, authenticated manifest digest,
build identity, explicit `create-new` or `load-authenticated-copy` intent,
profile identity, six host-established paths and explicit capability choices.
It contains no credentials. There is no implicit adoption of a live profile.
Before loading the engine, the gate verifies the digest, complete physical
package-file closure, every recorded file hash and size, package pins,
platform/architecture and prepared native identity, the executing staged Node,
and separation of resource paths from writable application paths. Package
links, Node preload/environment overrides and inherited credential variables
fail. Only reviewed OS/keychain environment names survive into the engine.
The protected key-store helper exchanges key material through private pipes;
keys do not enter launch descriptors, arguments, environment or credential files.

The host must first await `engine.ping` to negotiate the new engine epoch.
It then invokes `engine.initialize` with only `{protocolVersion:1,launchId}`.
During initialization, the service requests the exact native callback:

```json
{"operation":"host.production.prepare","payload":{"launchId":"<same launch>","resourceManifestSha256":"<same pinned digest>"}}
```

The host must acknowledge `{launchId,ready:true,processTree:'supervised'}`
after establishing its actual runtime/process supervision. On release the
service requests `host.production.drain` with `{launchId}`. Only
`{launchId,acknowledged:true}` for that exact launch permits release. There
are no PID, executable-path or arbitrary-operation fields. External URL and
notification callbacks use the existing reviewed host schemas when declared.
Energy, window/UI commands and voice are explicitly unsupported in this entry.
The fixed main caller is established by the private launcher, not RPC fields;
the native host must validate its main WebView origin/frame before forwarding.
The native host may not forward mobile or untrusted-WebView traffic under that
identity.

Initial durable owner observations are withheld until trusted initialization;
the service then emits a content invalidation for hydration. Raw owner events
are encoded/redacted by the production bindings, including durable transcript
row projection. Already encoded backend events are validated without a second
encoding. Both paths synchronously apply current read authority, including
queue filtering and exact Commander/chat ownership. Unreviewed native owner
events do not gain wire authority. Codec or publication failure fences the
owner and disconnects the peer.

Shutdown fences real schedulers and domain backends, joins raw requests and
initialization that ignore cancellation, and awaits actual native drain before
closing SQLite, clearing protected storage or releasing the profile/process
lease. Failed or missing acknowledgement leaves the owner visibly blocked and
retains those resources. Callback pipes stay open through graceful drain.
A disconnected peer cannot replay an accepted mutation or invent a new native
acknowledgement. A blocked process remains owned until genuine drain or host
process supervision ends that process; there is no timer that silently releases
the profile while raw work survives. Diagnostics use fixed stderr codes.

The in-process tests exercise actual SQLite/services and the private framed
peer with controlled model/native boundaries. Their synthetic resource bytes
test preflight rejection and are never loaded as native/SDK code. This is not
installed session, credential-store, SDK/CLI, Rust private callback, OS process
tree, Windows pipe or platform acceptance proof. Rust launch FD3 construction,
the exact prepare/drain supervisor, packaged helper/SDK redistribution review,
and installed platform validation remain explicit integration requirements.
Absent those host callbacks, startup/drain fail rather than reporting success.

`pnpm tauri:prepare:production` stages this entry only after the real protected
key helper and pinned standalone packages have been staged explicitly.
`pnpm test:tauri --production-proofs scripts/production-service-proof.test.ts`
launches the actual staged Node executable with anonymous stdin/stdout/FD3
pipes. It verifies the physical resource closure, loads the actual service/SDK
graph, negotiates an epoch, refuses domain access before initialization and
rejects RPC-supplied bootstrap paths. A changed private manifest digest exits
before any engine frame or profile access. Both owned Node processes must close
before fixture removal. This proof makes no native prepare/drain, OS credential
operation, provider inference or installed WebView claim.
