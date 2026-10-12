# Retained desktop contract foundation (T00/T04)

The parse-only generator adds explicit retained/removed operation contracts and strict registration boundaries. It does not accept G1: handlers still need reviewed schemas, codecs and authorization, and native/runtime/credential gates remain separate. The shipping renderer and Electron handlers are unchanged.

Run `node scripts/tauri-contracts.mjs` once after a batch of source changes. It writes only changed files; `--check` verifies freshness. It reuses the existing TypeScript parser and never compiles, opens SQLite, loads native addons or resolves dependency trees. The scanner resolves repository-local constants and recognizes exact reviewed event producers. Dynamic forwarding remains visible. There are no namespace or wildcard grants.

| Artifact | Meaning |
| --- | --- |
| [inventory.json](inventory.json) | Source references, constants and reviewed wrapper events; dynamic forwarding is explicit |
| [operations.json](operations.json) | Exact channel/kind entries, proposed owner/caller/destination, public API type references, observed preload transformations, validation obligations and source evidence |
| [desktop-api.ts](../../src/shared/desktop-api.ts) | Current renderer declaration signatures without the global `Window.electronAPI` or removed browser API; optional/undefined/null/void types are preserved |
| [desktop-operations.ts](../../src/shared/desktop-operations.ts) | Per-channel command argument/result and event payload types, plus literal descriptors |
| [desktop-domain-events.ts](../../src/shared/desktop-domain-events.ts) | Reviewed types for producer-only agent output/batches/recovery, cleanup completion, checkpoint answer and mobile subtask ordering |

The generated API uses type-only imports from existing shared definitions and the renderer's pure domain type module rather than copying DTOs. Agent status resolves directly to its shared enum. No Electron module, renderer store or runtime global is imported. `webUtils.getPathForFile(File)` is recorded as a local-only helper requiring a native/drop adapter; a `File` must not become a generic stdio file-access capability.

Channel argument types describe the public preload API, not an invented wire schema. The generator records actual argument expressions, including transformations such as positional API arguments becoming `{ id, changes }`. A service adapter must preserve that transformation before binding a migrated handler. `unknown` extension/backend fields remain validation obligations rather than fabricated types. Parse-only generation does not establish declaration/handler agreement at runtime.

All built-in `browser:*` commands are `removed-browser`, have no caller/destination and are omitted from retained types. Remote browser and `webpage` canvas features have no operation/native grants. Stored metadata/edges/recording files follow retirement compatibility policy. User-managed external MCP tools, system-browser links and provider/MCP/source/connector OAuth remain retained.

## Exact dispatcher registration

[DesktopOperationRegistry](../../src/service/transport/desktop-registry.ts) accepts only exact retained entries owned by its service/native instance. Every binding supplies request decoding, argument validation, domain authorization, invocation, result validation and result encoding. Missing bindings fail closed; `missingBindings()` reports every remaining operation. A generated name/family cannot make that list disappear.

Native caller identity comes from the supervising host/private pipe, never renderer request data. The trusted-desktop check verifies actual main WebView label, origin and frame. Epoch and decoded arguments are checked before domain authorization and effects. Task/project/session scope, approvals and user-owned path constraints remain explicit operation policies. Events require payload schemas/encoding and their owning epoch; delivery uses an authorized targeted desktop sink, with authenticated mobile delivery separate. Speech PCM stays desktop-only. Raw handler/codec/authority errors are redacted.

The stdio peer owns request IDs, versions, limits, advisory cancellation, deadlines and disconnect rejection under [the protocol contract](protocol-foundation.md). The registry checks abort state before effects and before returning results. It supplies no retry, mutation replay, admission bypass or synchronous native callback from database serializers.

## Native callbacks and serialization

[host-services.ts](../../src/shared/host-services.ts) defines injected canonical profile/resource/runtime/temp roots/build identity, a typed desktop sink and ten exact native callbacks: path diagnostics, file selection/save dialogs, external URL opening, file reveal, notification, microphone permission, shortcut registration and sleep inhibition. Runtime implementations and permissions still belong to native owners. Clipboard/image/file formats, attachment serving, window/menu/update lifecycle and additional voice callbacks need reviewed contracts before registration; this is not full T07 parity.

Callback validators enforce exact fields, bounded strings/lists, absolute path shape, cancellation/null consistency and HTTP(S)/mailto URL schemes. Owners additionally canonicalize/contain paths, resolve symlinks and preserve picker authorization. Callback identity must be the epoch-bound supervised service and Rust must enforce matching validation. Credential material is absent from this dispatcher: a synchronous provider is established through trusted bootstrap as D4.

Canonical base64 chunks cap decoded bytes at 64 KiB. Every desktop command encoder returns an `OptionalResult`: `{ defined: false }` for undefined/void, or `{ defined: true, value }` for defined values, including null. The registry rejects mismatched defined/undefined flags. Native callback and bootstrap results retain their explicitly declared shapes. Feature adapters still need complete codecs for nested optional values, byte sequences and cursors. Large snapshots/audio need chunking, sequence and recovery policies under the 1 MiB frame limit. These types do not extend the implemented three-field `engine.initialize` or permit callbacks before the host adopts the epoch.

## Acceptance and verification

The manifest covers observed registrations, preload calls/listeners and reviewed producers. Generic `channel` forwarding in guarded-send, agent/scheduler/voice helpers and task/mobile callbacks remains explicit. Observed producers are included, but alias/control-flow/re-export completeness needs owner review. Mixed native/service ownership and callback requirements are coordinator proposals.

G1 requires reviewed schemas, null/missing/byte codecs, contextual permissions, cancellation/idempotency policy and destinations for each retained binding. Producer-only types/forwarders need owner signoff. T00 also requires full resource/process ownership and real Electron/native application baselines on supported platforms. Operation coverage alone closes neither gate.

Focused cases are in [desktop-contracts.test.ts](../../src/shared/desktop-contracts.test.ts), [tauri-contracts.test.ts](../../scripts/tauri-contracts.test.ts) and enriched inventory tests. They cover exact dispatch/ownership, removed/unbound operations, forged identity/epoch/task authority, rejection before effects, cancellation, redaction, byte canonicalization, callback shapes and declaration/transformation evidence. Tests/compilation are central batch actions.

## Measured baseline tooling

[tauri-baseline.mjs](../../scripts/tauri-baseline.mjs) measures real execution with explicit scope. Run one scenario per batch; retain JSON with OS/build/cache evidence. It never flushes caches or copies dependencies repeatedly.

```sh
node scripts/tauri-baseline.mjs --scenario inventory
node scripts/tauri-baseline.mjs --scenario service
node scripts/tauri-baseline.mjs --scenario native-smoke --executable /absolute/path/to/installed/debug/host
```

Inventory measures parser elapsed time/CPU/high-water RSS. Service uses a temporary profile and real Node initialize/ping/shutdown without native probes or a domain database. Native smoke requires an installed debug host/display and passing report; system Node is hidden and the full smoke duration is measured. Linux direct-child samples use `/proc` every 250 ms and exclude descendants. Child diagnostics, arguments and profile paths are not exported. No scenario proves framework memory/size gains, cold startup, process-tree cleanup or full feature performance. Those require matched real application/release scenarios under T00/T13.
