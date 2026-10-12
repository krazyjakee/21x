# Tauri runtime foundation (T01 preparation)

Status: experimental implementation; native compilation and packaged feasibility remain unverified. This work does **not** complete T01, accept G0, or migrate the domain engine. The existing Electron application remains the production host.

The isolated Tauri 2 executable starts a staged standalone Node by absolute resource path. Startup requires an `engine.initialize` response before opening the small feasibility screen. The screen can call `engine_status` and `engine_invoke` with an empty payload for `engine.ping` or `engine.probe` only. No task/database/secret API is exposed. The probe creates a temporary in-memory SQLite table, launches a tiny Node PTY, forks this service file in worker mode, and imports two representative agent SDKs without making API calls. Each failed check is reported explicitly; `ok: false` is not a successful feasibility result.

## Resource contract

The coordinator stages these ignored paths with `pnpm tauri:prepare`:

| Source staging path | Runtime lookup |
| --- | --- |
| `src-tauri/resources/node/node` (`node.exe` on Windows) | `resource_dir/resources/node/node[.exe]` |
| `src-tauri/resources/service/feasibility.mjs` | `resource_dir/resources/service/feasibility.mjs` |
| `src-tauri/resources/service/node_modules` | Adjacent to the service entry, normal Node package resolution |
| `out/tauri-renderer` | Bundled standalone feasibility frontend |

Missing resources fail startup; there is no system Node fallback. Staging must preserve executable permissions and contain native addons compiled for the bundled standalone Node ABI and target OS/architecture. Existing Electron native binaries must not be treated as compatible. No dependencies, runtime executables, or copies of node_modules are committed. Tauri resource mapping and its build script are responsible for copying staged resources into development and packaged layouts. This layout follows [Tauri resource documentation](https://v2.tauri.app/develop/resources/); executable bits and signing still need platform evidence.

## Protocol and lifecycle

Every UTF-8 NDJSON envelope has `protocolVersion: 1`, `engineEpoch`, and `kind`. Requests carry a monotonically increasing `host:N` request ID, operation, and payload. Responses carry the same ID and exactly one of result/error. Initialize uses an empty epoch and payload `{protocolVersion: 1, profileRoot, resourceRoot}`; the host adopts the random epoch from the matching successful response. Subsequent frames must match it. The service verifies initialize roots against its host-injected environment. There are no service-to-host callbacks in this spike.

Input and output frames are bounded to 1 MiB excluding LF, pending/active requests to 128, queued output bytes to 4 MiB, and operation deadlines to 30 seconds. Partial/multiple reads are supported. Rust timeout/cancellation releases pending slots; timeout sends an `engine.cancel` event. A timeout during a partial write invalidates framing and disconnects the engine. Malformed/oversized input, version mismatch, duplicate IDs, and stream loss terminate the service rather than continue with ambiguous state. Errors use fixed redacted messages. The host discards the child's stderr; the service replaces dependency console methods with redacted diagnostics. Domain log sinks will need a separate design.

The service never opens a real profile, registers production OAuth schemes, or reads credential/environment configuration. Rust clears inherited environment before spawning Node, preserving only Windows runtime/temp variables and injected isolated paths. Workers receive the same small OS environment and no arbitrary parent configuration. A second simultaneous probe is rejected to avoid multiplying native work.

On quit, Rust requests shutdown with a three-second grace period, rejects remaining requests, kills/reaps its owned direct child when needed, and waits up to five seconds. Node cancels pending probes and kills owned PTY/worker children when its stdin closes or shutdown/signals arrive. Abrupt host death and Windows process-tree termination are **not yet platform proven**; this foundation makes no claim of a production parent-death/process-tree guarantee. There is no automatic restart or mutation replay.

## Permissions and identity

The experimental identity is `com.krazyjakee.21x.tauri-feasibility`; only its own app-local data `feasibility` directory is created. The host never resolves the Electron profile. No migration or cross-host profile locking is needed until a later shared-profile implementation.

Custom commands are included in `AppManifest::commands` to generate command ACLs, then granted only to the local `main` WebView capability. This is required because [Tauri custom commands are otherwise allowed by default](https://v2.tauri.app/security/capabilities/). Rust additionally checks WebView label and exact permitted origin. Navigation is restricted to packaged app origins (or localhost:1420 in debug); CSP forbids embedded frames and remote resources. No shell, filesystem, remote capability, or browser panel is registered. Packaged malicious-origin/native-command checks remain outstanding.

## Batch validation

No installation, test execution, native rebuild, or Cargo compilation was run by this workstream during the parallel edit batch. Coordinator checks should run sequentially:

```sh
node --test --test-concurrency=1 src/service/feasibility.test.mjs
pnpm tauri:prepare
pnpm tauri:frontend:build
CARGO_BUILD_JOBS=1 cargo check --manifest-path src-tauri/Cargo.toml
```

The subprocess tests are dependency-free and cover fragmented/coalesced frames, initialize/ping/shutdown, root validation, stale epochs, malformed/oversized/truncated frames, UTF-8 errors, duplicate IDs, and real-file fork execution. Native probes are performed through the screen only after standalone-native staging. Cargo tests currently include a small request-ID check and still require the host platform dependencies; no GTK-independent supervisor test crate is supplied.

Direct Rust dependency versions are pinned to Tauri 2.12.3, tauri-build 2.7.2, Tokio 1.53.2, Serde 1.0.229, and serde_json 1.0.154, confirmed from their official docs at implementation time. A Cargo.lock must be generated and committed centrally when dependencies are resolved; transitive reproducibility is not established until then. Supported Rust/GTK/WebKit platform prerequisites, macOS Node signing, Windows executable inclusion, native addon packaging, clean machines with Node absent from PATH, all four architecture builds, and packaged shutdown/crash evidence remain T01 blockers.

Full service extraction, schedulers, shared-profile locking, credentials, browser parity, and production host services belong to later cards and must not be inferred from this screen.
