# Production voice management bindings

`VoiceManagementBackend` exposes 21 existing management commands using the
actual `VoiceSessionManagerCore`, its owned `VoiceSpeechService`, and the
production owner's current database/agent/runtime/model/worker identities.
It adds no capture, turn, confirmation, action, PCM/playback, custom-directory,
picker, shortcut, Commander or hosted-speech route. Native microphone permission
remains unregistered; it is not a service-owned grant.

Snapshot/runtime reads require current trusted desktop configuration read
authority. Every settings/model mutation also requires write authority. The
backend calls the core's shared management lease once; that lease owns nested
speech, runtime and model guards. Guards revalidate exact ownership, current
authority and cancellation at subsequent setting, filesystem-publication and
removal boundaries. At most one backend mutation and 16 requests are accepted
concurrently; overlapping mutations fail rather than forming an unbounded queue.
Accepted raw work stays retained until it settles. A shutdown timeout leaves the
backend closed with pending work retained; the production owner must drain the
actual core/model/runtime/worker owners before releasing its database/profile.
Disconnect never causes mutation replay.

Endpoint silence is expressed in seconds (0.1–10), speech speed is 0.5–2, and
automatic speech length is 1–6000 characters. Model commands accept the retained
four recognition and two synthesis catalogue identities. A voice selection must
match the actual current owner's offered speakers. Unknown models, paths,
programs, hosted engines and caller/capability overrides are refused.

Runtime installation returns `UNKNOWN_OPERATION` before installer, download,
lease or settings effects because no verified fixed runtime package manifest is
available. Actual portable runtime removal remains bounded by the runtime
owner's inventory proof and cannot claim deletion of an unsupported install.
Microphone, shortcuts, task actions and audio remain explicit unavailable host
capabilities. Historical hosted settings are retained by the actual owner; no
hosted lookup, synthesis, account refresh or key management is admitted.

Public DTOs retain actual installed/enabled/progress/model states but replace
runtime module paths with `__21x_local_voice_runtime__` presence metadata and
errors with fixed messages. The marker never loads a worker or grants filesystem
authority. Hosted account projection contains only an empty offline state and,
when applicable, a fixed unavailable error. Four management events are supported:
`voice:status`, `voice:runtimeProgress`, `voice:tts:status` and
`voice:tts:modelProgress`. Their desktop delivery requires current read authority;
they contain no microphone transcript events or speech audio and never target
mobile clients.

Source tests use actual portable SQLite and voice/speech/model owners with
controlled unavailable external boundaries. They cover real settings writes,
shared leases, revoked authority, retained delayed work, cancelled/blocked
shutdown and public redaction. They are not live model-download, native audio,
microphone, installed-package or cross-platform acceptance evidence. Default
native capture and audio capabilities remain unavailable. Voice management is
bound only when the owner verifies the complete optional staged worker pair.
