# Local voice authority continuation (#218)

This continuation supplies an optional private Source lease consumer and repairs
actual speech worker ownership. Production microphone, capture, playback, task
actions and global voice shortcuts remain unavailable. The SDK is not registered
in the production private peer or advertised as a native host capability. Hosted
voice (#92) remains deferred by the user.

## Private contract for the native owner

`src/shared/voice-native-callbacks.ts` defines exact, discriminated payload and
receipt schemas. `src/service/voice-flow-owner.ts` captures the bridge and consumer
fences once. Neither schemas nor synthetic receipts establish OS permission.
The native counterpart belongs to #215 and is a prerequisite for production
wiring. This document records the agreed consumer boundary, not native delivery
or installed platform acceptance.

| Direction | Operation | Scope |
| --- | --- | --- |
| Source → host | `host.voice.acquire` | Source-generated UUIDv4, native-stamped physical-document `uiLeaseId`, one purpose and bounded TTL |
| Source → host | `host.voice.permission` | One permission request on its permission lease; fixed granted/denied/unavailable receipt |
| Source → host | `host.voice.bind` | One captured turn ID/epoch or speech ID/generation pair |
| Source → host | `host.voice.shortcut` | One finite accelerator, no generic command or OS input |
| Source → host | `host.voice.publish` | Strict local voice event union for the captured document and exact pair |
| Source → host | `host.voice.retire` | Idempotent UUID retirement, including unknown IDs; joins raw native work and prevents delayed acquire resurrection |
| Host → Source | `engine.voice.audio` | Exact capture lease and turn pair, positive monotonic sequence, canonical PCM16LE mono 16 kHz |
| Host → Source | `engine.voice.hotkey` | Exact shortcut lease; consumer forwards only the existing toggle action |
| Host → Source | `engine.voice.revoked` | Synchronous consumer fence; retirement runs outside the delivery RPC |

There are at most 16 admitted leases and 4096 UUIDs per engine epoch. Permission
leases expire within 120 seconds; other leases within 600 seconds. An early
synchronous ownership observer can only record the lease. Effects remain refused
until a valid acquire receipt and the captured post-ack authority fence succeed.
The consumer never closes a borrowed global owner.

Every effect checks captured Source authority before and after the raw receipt.
Cancellation rejects new effects immediately, begins native retirement before
joining a held permission/acquire call, and joins registration, outstanding
methods and the consumer's raw work. A refused native/consumer retirement keeps
the exact admission for retry. The parent close deadline never releases it.
Callback delivery atomically claims sequence/byte budget before synchronous
worker enqueue; it does not await retirement. The native owner must independently
fence its physical document, epoch, raw operations and UUID tombstones.

Audio input packets are even PCM lengths from 2 to 6400 bytes, at most 19,200,000
bytes per turn. Publication admits at most eight pending events / 256 KiB total
serialized bytes, including in-flight native calls. Each event is at most
256 KiB; text at most 65,536 UTF-8 bytes. Output PCM is mono signed 16-bit
little endian, at integer sample rates 8000–48000 Hz; each chunk decodes to at
most 128 KiB. Speech start, monotonic chunk index and terminal ordering are
checked against the bound speech generation. The speech worker fragments each
sentence in order and attaches its text to the sentence's first fragment only.

## Required physical-document and cleanup proof

The native owner must use `NativeUiOwner`'s actual Wry document/ticket and epoch,
not the main label, top origin, a renderer-selected ID, or a cached permission.
Pinned Tauri's permission callback lacks a frame origin and persisted WebView
decisions can bypass it. An armed Source lease or resolved `getUserMedia` promise
cannot prove ownership or acknowledged stream revocation. All current WebView
permission requests stay denied until actual permission and stream lifetime
proof exists. Camera and combined camera/microphone requests remain denied.

For a still-valid captured document, native cleanup must deliver only the exact
bound `voice:state` idle pair and `voice:speech:end` cancelled pair through finite
cleanup admission; it cannot deliver an outcome/completion or retarget another
document. A destroyed document receives no terminal event. Renderer disconnect
and pagehide must stop its media graph and dispose listeners. A retains renderer
wiring and will add those controls after the native binding is proven. Private
permission unavailable must map to the retained public `unsupported` status.
No new public signature, grant or general retained operation is introduced here.

## Actual Linux evidence and limits

The Source regressions exercise early receipts, stale bindings/sequences,
withdrawal, expiry, capacity, failed cleanup retry, publication backpressure,
and an actual fragmented `ServicePeer` round trip. The latter holds a raw
permission handler while revocation completes, proving cycle separation without
asserting microphone permission or any OS side effect.

The real speech worker tests use only an isolated synthetic command on PATH and
pattern/silent WAV fixtures. They verify bounded fragments and exact byte
reconstruction; a TERM-refusing child must exit before cancellation or worker
shutdown acknowledges; a replacement with the same speech ID ignores the old
request's terminal reply; an unrelated child remains alive. No microphone is
recorded, installed OS voice is invoked, model is downloaded or hosted provider
is contacted. See [speech ownership](voice-speech-owner.md).

After production staging, the independent raw descendant proof is:

```sh
src-tauri/resources/node/node scripts/voice-retirement-proof.mjs src-tauri/resources/service/voice-tts-worker.cjs
```

It requires the pinned standalone Linux Node and creates only its own synthetic
profile. The published old worker fails the same assertion (descendant alive
after worker close); the staged repaired worker passes. This tests graceful TERM
retirement, not installed OS speech or an uncatchable worker crash.

Whole-issue acceptance remains open: #215 native document permission/capture/
playback/shortcut authority; production scoped action/HITL binding through the
existing task/AgentManager admission services; actual system/downloaded-model
inference and interrupted hard-crash process-tree proof; a reviewed all-platform
runtime installation pin; custom-directory selection; installed supported
platform/device proof. Hosted Verify unavailable: repository Actions disabled,
awaiting user decision. No workflow dispatch or settings change is authorized.
