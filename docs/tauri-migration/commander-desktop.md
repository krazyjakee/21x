# Commander and chat desktop service bindings

This is scoped implementation for #214/#202. It does not establish installed
native parity, permit live-profile conversion, or change shipping Electron
defaults. Production registration, native caller authentication, and the full
renderer capability map remain separate requirements.

`src/service/commander-backend.ts` binds the production owner's existing
`CommanderStore`, `CommanderService`, `AgentManager`, and one `ChatRuntime`.
It uses the same settings/provider factory callback and the same Commander
project/skill tools. Lightweight chat keeps the shipping default empty tool
list; any tools supplied by the owner are server definitions, never request
arguments. No alternate database writer, fake model, or renderer-owned runtime
is introduced.

The provider factory reads the owner's current model/settings for each new
turn. Model/provider settings mutations remain with their configuration domain;
these commands do not invent another model selector. Lightweight chat retains
its shipping caller-supplied history rather than durable Commander sessions.
It has no durable lightweight-chat turn recovery or crash replay contract.

## Operations and authority

The reviewed commands are session list/create/rename/archive, message history,
mark-read, active-view selection, typed send, image read, cancel, activity and
exact Undo, plus lightweight chat start/cancel. The reviewed events are
`commander:event` and `chat:event`.

The registry requires the host-established engine epoch, trusted desktop
principal, WebView and origin. These identities are not payload fields.
Mandatory authority callbacks check global Commander access, each session,
projects referenced by its messages, and global skills for a global-skill Undo.
Commander write access authorizes the actual global delegation/admin tool
owner; it must not be granted to a caller with only isolated project access.
Undo resolves the affected project/repository/resource/skill from the actual
database before applying the existing exact-reversal helper. It never guesses
old values or starts a model turn. Later conflicting field edits still refuse
reversal; repeated Undo returns the saved note.

Chat cancellation belongs to the exact engine/WebView/origin that started the
turn. Chat event publication carries that captured recipient. Root integration
must authenticate the target sink and preserve this target through publication;
an event codec is not a broadcast permission. `canReadEvent` checks the current
session/project authority or chat owner before a targeted delivery.

## Bounds and image DTO

`src/shared/commander-desktop-codecs.ts` defines exact argument, result and event
schemas. Nested tool input, UTF-8 text, record counts and total JSON bytes are
bounded before serialization. Provider error events and activity error reasons
receive fixed public wording; private provider diagnostics are not reflected.
Stored conversation/action/report content remains unchanged.

| Surface | Current native bound |
| --- | --- |
| Legacy session/history list | 128 records |
| One message/tool-input field | 64 KiB UTF-8 |
| Whole encoded domain payload | 768 KiB |
| Legacy stored history text/tool-call preflight | 512 KiB total |
| Image | 192 KiB decoded |
| Images in one request | 5 images, 384 KiB decoded total |

Images use a version-1 envelope with exact `name`, `mimeType`, `encoding:
base64`, `byteLength` and `data` fields. Byte length and PNG/JPEG/GIF/WebP magic
must agree with the declared type. Names are sanitized basenames; filesystem
paths, Buffer-shaped objects, typed arrays, unknown fields and unsupported
versions are refused. The legacy renderer API still receives ordinary
`ChatImageInput` values after decoding. Image lookup resolves its stored
message/session before materializing the blob and verifies stored byte length.
These are byte/signature guarantees, not live WebView decoding or OS clipboard
evidence.

Legacy list reads first query SQLite counts and byte lengths. Oversized rows,
lists or images fail explicitly and remain intact in storage. History
pagination and larger image transport remain gaps; no action JSON, report or
stored image is silently truncated. Sending into an oversized legacy history
also refuses before its existing context builder materializes the history.
Session and image-reference metadata also undergo length preflight before
legacy store materialization. Images across an entire lightweight-chat history
share the request count and byte budget.

## Ownership and retained choices

Accepted user messages and exact Undo notes remain durable if the response is
cancelled or publication fails. No request is replayed. Publisher failure
closes backend admission; the existing runtimes continue owning accepted work.
Backend close joins accepted turn handles and Captain-release work triggered
by Undo. ProductionOwner must additionally shut down and join both actual
runtimes, Captain delivery and other production owners before closing the DB
or releasing its profile lock. A timeout is incomplete shutdown, not permission
to release these resources.

Active-view changes and Commander renderer destruction clear view selection
without cancelling the Commander turn. Navigation therefore does not retarget
or end an application-owned PiP call. Chat destruction cancels only that
caller's lightweight turns; merely hiding a window is not destruction.

Reports use the existing durable delivery/outbox and correlation routing.
Unsolicited reports remain in the quiet Project reports inbox; correlated
reports stay with their originating request. Opening/reading starts no model
turn, moves no report timestamp, and adds no speech. The stage/chat layout,
caption/accessibility owner and PiP controls remain renderer-owned. Native
microphone, recognition, speech and voice-call activation are separate #218
bindings; this text-domain implementation claims none of them.

## Verification scope and remaining gates

The new codec tests exercise all fourteen command schemas, malformed identity
and path fields, byte/count/depth bounds, image envelopes, report/action/summary
identity, activity age and error redaction. The backend tests use actual
portable SQLite, the store/service, project tools, exact Undo, outbox routing,
ChatRuntime and AgentManager with controlled provider/adapter boundaries.
They cover typed images, navigation/cancel ownership, foreign scopes, oversized
preflight, accepted response loss and incomplete shutdown. These tests are
fixtures, not live SDK/OS evidence.

The implementing worker has not executed checks. The coordinator should run
both new test files in the application and standalone service configurations,
typecheck/lint/build, then the isolated native production Commander workflow
after registration. Installed hidden-window continuation, crash/reconnect,
keyboard/focus and shutdown evidence on each supported OS remain open, as do
larger history/image transport and native voice. Hosted #92 is deferred.
