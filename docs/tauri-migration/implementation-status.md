# Migration implementation status

First foundation batch, 2026-10-12. The shipping application still uses Electron. The Tauri experiment has a separate identity and temporary/isolated profile; it does not import tasks, credentials, or production OAuth schemes.

The overall [migration tracker is #193](https://github.com/krazyjakee/21x/issues/193). G0 and G1 remain open: Linux headless runtime evidence is partial feasibility evidence, not packaged WebView or cross-platform parity.

## Delivered in this batch

| Foundation | Implementation and evidence | Tracking |
| --- | --- | --- |
| Electron inventory | AST scanner and deterministic [inventory.json](inventory.json): 657 source files, 609 IPC references including 14 unresolved expressions, 368 direct preload API accesses, one JSX WebView; [methodology](inventory.md) describes limits | [#194](https://github.com/krazyjakee/21x/issues/194) |
| Private service transport | Strict version/epoch envelopes, UTF-8 framing, bounded requests/queues, cancellation/deadlines, redacted errors and real service wire fixtures; [contract](protocol-foundation.md) | [#195](https://github.com/krazyjakee/21x/issues/195) |
| Credential boundary | Injected synchronous provider with an Electron adapter, wired after readiness; serializers and connector credentials no longer import Electron. Existing ciphertext/plaintext formats and connector policies are preserved; missing bootstrap fails closed | [#196](https://github.com/krazyjakee/21x/issues/196) |
| Tauri/runtime experiment | Restricted native host skeleton, isolated Vite frontend, bundled-Node resource staging, headless Rust supervisor crate, native probe CLI and CI coverage; [runtime notes](runtime-foundation.md) | [#197](https://github.com/krazyjakee/21x/issues/197), open for GUI compilation/platform evidence |

Three subagents worked in separate worktrees. Dependencies were installed centrally, heavyweight checks were deferred until integration, and compilation/tests ran with one worker/job where applicable. Staging uses copy-on-write when supported, source/destination metadata, atomic replacement, and a native install marker to avoid repeatedly copying the runtime or rebuilding healthy addons. Native dependencies live in their own staging tree rather than changing Electron's native modules.

## Local validation

Environment: Linux x64, Debian 12, standalone Node 22.23.2 / ABI 127, Rust 1.98.0. Rust dependencies and the Tauri CLI are locked. The experiment uses a Node pin in [tauri-runtime.json](../../scripts/tauri-runtime.json); these pins are prototype choices pending the full compatibility decision.

| Check | Result |
| --- | --- |
| Focused transport, inventory, provider, database, connector credential, OAuth and updater regressions | 189 distinct tests passed across the focused runs |
| Dependency-free service subprocess and staging regressions | 21 passed, including rejection of linked module trees and repository dependency fallback |
| Rust supervisor | 3 unit tests and 4 actual staged-Node integration tests passed, including 64 concurrent calls, cancellation and shutdown/reaping |
| Actual Linux native probe through compiled Rust supervisor | All five checks passed: SQLite in memory, PTY, real-file worker fork, Claude SDK import and OpenCode SDK import. SDK checks import only; no provider API calls. See [captured report](evidence/linux-x64-probe.json) |
| TypeScript | Full `pnpm typecheck` passed |
| Lint | Changed TypeScript/configuration files passed |
| Experimental frontend | Production Vite build passed |
| Existing desktop/mobile build | `pnpm build` passed |
| Native GUI host | Not compiled: `tauri info` reports missing WebKitGTK 4.1 and rsvg2 prerequisites |

The OAuth tests initially timed out on the unchanged baseline and on the new code: this container binds `localhost` servers to IPv6 while its HTTP client selects IPv4. `NODE_OPTIONS=--dns-result-order=ipv4first` aligns test worker endpoints, and all 17 OAuth tests pass. No production OAuth behavior was changed.

The first CI run passed lint, typecheck and builds plus 4,937 tests, but exposed three new wire-fixture launch failures: the existing suite's `process.execPath` is Electron, and the deliberately minimal child environment omits Electron's Node-mode flag. Wire fixtures now launch the developer/CI standalone `node` on PATH with only the required OS/path variables. This changes test tooling, not the packaged runtime's explicit bundled-executable lookup.

The provided `make` binary also required a newer glibc than this Debian image. Validation used a checksummed Debian-compatible `make` in a temporary directory, with `MAKE` set for that one native preparation command; the system toolchain was unchanged. Only the failing PTY addon was rebuilt, with one job. Ordinary environments need a functioning native build toolchain.

## Running the experiment

With the pinned Node version, pnpm and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/) installed:

```sh
pnpm tauri:prepare
pnpm tauri:prepare:native
pnpm tauri:dev
```

`tauri:prepare` stages Node and the service without installing/building addons. `tauri:prepare:native` explicitly installs the pinned native modules and representative SDKs, verifies standalone loading, and rebuilds only failing native addons. npm's lifecycle policy is limited to the exact SQLite/PTY versions in that generated manifest; see [npm install-script policy](https://docs.npmjs.com/cli/v11/commands/npm-install-scripts/). A failed preparation writes no success marker. Build-time options `--node PATH` and `--npm-cli PATH` select explicitly installed tools; there is no packaged system-Node fallback.

The native runtime can also be exercised without GTK/WebKit:

```sh
CARGO_BUILD_JOBS=1 cargo run --locked --manifest-path src-tauri/Cargo.toml -p twentyonex-engine --example probe -- src-tauri/resources
```

This launches the real supervisor, creates a temporary profile, runs the five checks, shuts down its child, and exits unsuccessfully if any check fails. It proves runtime/module compatibility on the executing machine; it does not test bundle layout, WebView behavior or OS distribution signing.

## Remaining work and next batch

Complete the native GUI build and packaged runtime evidence in #197, then prove browser replacement (T02) and real legacy credential conversion (T03). Finish T00's handler/resource ownership audit and performance baseline. Resolve the decision register and accept G0/G1 before broad feature porting.

Current gaps include all macOS/Windows evidence, browser panels/automation/recording, native encrypted fixtures and conversion/rollback, production profile locking, parent-death/process-tree guarantees, complete command/permission mappings, renderer bridge adoption, domain engine extraction, task/session parity and installers/updates. No schema or live credential migration has run, and no migration release has been published.
