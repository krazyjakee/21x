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

The synthesis worker now also retains every system-voice command until both
its `execFile` callback and native close finish. Cancellation synchronously
fences the passage, signals only those captured handles, and escalates an
unresponsive child after 200 ms. Its cancelled terminal receipt follows raw
close. TERM and IPC disconnect fence new worker commands and join descendants
before worker exit; replacement synthesis waits for earlier command retirement.
This repairs the previous path which discarded a child after signalling it.
It does not establish process-tree cleanup after uncatchable worker SIGKILL.

Private worker IPC carries a monotonically increasing request epoch in addition
to speech ID. Delayed chunks, errors or completion from an earlier same-ID
request cannot retire its replacement. The portable client validates canonical
PCM, exact chunk order, sample rate and text bounds before emitting audio.
The worker sends at most 128 KiB decoded PCM per fragment, with monotonic indexes
and sentence text on its first fragment. System WAV reads require bounded
regular no-follow files, PCM encoding and complete frames; malformed rate or
odd-length audio is refused. Synthetic Linux regressions exercise the real
Node worker, `execFile`, WAV conversion and IPC; they invoke a private fixture
executable, never the installed voice or audio device. See the optional
[private voice authority contract](voice-native-authority.md).

The model host supplies a trusted absolute root, download permission,
current-owner checks, and authorization for every request. Portable installs
use the fixed manifest, HTTPS publisher allowlist, at most four redirects,
actual received-byte bounds, SHA-256 verification, bounded decompression,
and a private exclusive staging directory. Extraction refuses links,
escaping paths, duplicate files, and unsupported entries. Publication uses
a cooperative namespace lock and rename after checking that the destination
is absent. This is not an adversarial atomic no-replace primitive.

Production model hosts must borrow an actual `VoiceModelInventoryOwner`.
Its required options are `profileRootDir`, `inventoryRootDir`, `modelRootDir`,
the captured `AuthenticatedSecretStorage`, and `assertCurrent`. Both model
and inventory roots must be separate physical direct children of the trusted
profile root. The explicit `inventory: 'memory-only-fixture'` mode exists for
controlled tests; production never falls back to it. Electron hosts without
portable policy keep their original behavior.

The owner writes ciphertext using the existing profile-bound AES-GCM
`encryptString` / `decryptString` format and key. The authenticated plaintext
starts with the exact `21x:voice-model-publication:tts:v1` domain and binds
the fixed manifest identity, archive format/checksum/size/address, current
physical profile/inventory/model roots, and complete directory/file inventory.
Each file carries its identity, size, modification time, and SHA-256. Reads
use no-follow handles with ciphertext, JSON, path, count, depth, and actual
tree-byte limits; oversized or foreign-purpose receipts are refused before
they can grant deletion. No plaintext inventory file is written.

Publication first persists and syncs an encrypted `prepared` receipt, then
the manager renames the verified payload, and the owner verifies the exact
published tree before persisting a `committed` receipt. Receipt publication
uses exclusive temporary files and no-replace hard links; both files and
parent directories are synced. Prepared cleanup finishes before install
resolves. Only an unambiguous committed receipt authorizes same-key restart
removal. Prepared-only, committed-plus-prepared, and interrupted retirement
states refuse automatic recovery or replay. Directory sync errors remain
explicit failures; Windows/macOS durability and installed acceptance are
still unverified. Model-directory rename remains a cooperative operation,
not an adversarial atomic compare-and-publish primitive.

Before removal, the exact current inventory must match. Historical trees
without receipts, added personal files, changed bytes, and replaced roots
are preserved and refused. A durable retirement receipt precedes quarantine
rename. Removal then verifies and retires each exact inventoried file before
unlinking it; directories are removed only when empty. Unexpected additions,
replacements, or interrupted deletions preserve their quarantine and receipt
for explicit recovery. The owner never recursively sweeps model or inventory
namespaces. These checks do not provide an adversarial OS-level atomic
compare-and-unlink primitive against another process with the same filesystem
privileges.

Successful staging cleanup verifies the fixed archive's exact bytes and
identity, unlinks that file, and removes only an empty staging directory.
Failed or ambiguous durable stages remain preserved and block another
same-model staging attempt. There is no automatic historical adoption or
uncertain staging/quarantine cleanup; a reviewed explicit recovery flow remains
open. Unrelated files and legacy directories are never swept by portable
`removeAll()`.

`runManagementMutation(effect, beforeWrite)` composes the recognition owner's
single management lease with speech and model writes. It rejects competing
mutations and rechecks the exact scope after awaits and before settings,
publication, selection, and removal. Shared-runtime removal first joins
`stopWorker()`. Final `shutdown()` fences new work immediately and `close()`
joins accepted reads, downloads, streams, and worker receipts. The model
manager also shuts down and joins its actual inventory owner. The inventory
owner retains each file handle through acknowledged close, preserves failed
close receipts for exact-handle retries, and never disposes borrowed storage.
Shutdown deadlines cannot release the profile/key lease while raw ownership
remains uncertain. Speech events
remain desktop-only; no samples or credentials are delivered to mobile.

The authored tests cover real filesystem extraction/hash/publication,
actual authenticated storage and same-key restart, wrong keys/profiles,
tampered/domain-invalid/bounded receipts, incomplete publication phases,
historical and changed-tree preservation, additions/replacements during
retirement, delayed writes, failed close receipts, ignored cancellation, raw close
and spawn-error ordering, management withdrawal, explicit hosted refusal,
and actual Node IPC using synthetic speech. These are controlled owner tests,
not live-model, installed-device, or permission evidence. Native audio,
permission callbacks, packaged local inference, operating-system voices,
all-platform shutdown, and installed acceptance remain open. The existing
Electron hosted engine has no raw shutdown join interface; this slice does
not claim to fix legacy hosted-network drain.
