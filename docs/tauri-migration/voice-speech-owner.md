# Portable local speech ownership

The portable host borrows the actual `VoiceSpeechService`,
`VoiceTtsModelManager`, `VoiceTtsWorkerClient`, and `VoiceSystemVoicesOwner`.
Their imports do not require Electron. Electron keeps its existing defaults;
the portable constructor requires explicit owners and a local-only policy.

`VoiceSpeechHost` requires `hostedSpeech: 'disabled'`, an `assertCurrent`
owner check, and an explicit `audio` capability. The staged native host uses
`audio: 'unavailable'`. Settings and local model management can succeed, but
preparation and speech cannot spawn a synthesis worker or emit audio. The
snapshot says audio is unavailable. Historical ElevenLabs settings remain
stored, while the portable snapshot offers the system engine as its offline
fallback and exposes an empty, explicitly unavailable hosted account. Every
hosted operation is refused before settings, provider, or network effects.
Hosted issue #92 remains deferred.

The worker host supplies absolute staged script and Node executable paths,
a narrow environment, the real child-process launcher, and actual runtime
and model proofs. Reusable `stopAcknowledged()` and final `close()` retain
each child until its native `close` receipt, including stream drain and
ignored termination. Replacements wait for the previous receipt. The system
voice owner requires both `execFile`'s buffered-output callback and native
child close, including spawn errors. Unavailable enumeration launches no
executable. A public shutdown deadline reports incomplete cleanup and retains
the raw owner for a later join; it does not establish that the child exited.

The model host supplies a trusted absolute root, download permission,
current-owner checks, and authorization for every request. Portable installs
use the fixed manifest, HTTPS publisher allowlist, at most four redirects,
actual received-byte bounds, SHA-256 verification, bounded decompression,
and a private exclusive staging directory. Extraction refuses links,
escaping paths, duplicate files, and unsupported entries. Publication uses
a cooperative namespace lock and rename after checking that the destination
is absent. This is not an adversarial atomic no-replace primitive.

Portable deletion requires this manager's exact publication inventory,
including every directory/file identity and file hash tied to the archive
checksum. Historical trees without a receipt, added personal files,
changed bytes, and replaced namespaces are preserved and refused. Receipts
currently live in memory: after restart, a retained model can be read but
cannot be removed through this portable owner. Durable authenticated removal
receipts remain a required follow-up. Unrelated files and legacy directories
are never swept by portable `removeAll()`.

`runManagementMutation(effect, beforeWrite)` composes the recognition owner's
single management lease with speech and model writes. It rejects competing
mutations and rechecks the exact scope after awaits and before settings,
publication, selection, and removal. Shared-runtime removal first joins
`stopWorker()`. Final `shutdown()` fences new work immediately and `close()`
joins accepted reads, downloads, streams, and worker receipts. Speech events
remain desktop-only; no samples or credentials are delivered to mobile.

The authored tests cover real filesystem extraction/hash/publication,
historical and changed-tree preservation, ignored cancellation, raw close
and spawn-error ordering, management withdrawal, explicit hosted refusal,
and actual Node IPC using synthetic speech. These are controlled owner tests,
not live-model, installed-device, or permission evidence. Native audio,
permission callbacks, packaged local inference, operating-system voices,
all-platform shutdown, and installed acceptance remain open. The existing
Electron hosted engine has no raw shutdown join interface; this slice does
not claim to fix legacy hosted-network drain.
