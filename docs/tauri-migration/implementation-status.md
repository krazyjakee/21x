# Migration implementation status

Foundation batches and scope decisions, 2026-10-12. The shipping application still uses Electron. The Tauri experiment has a separate identity and temporary/isolated profile; it does not import tasks, credentials, or production OAuth schemes. The [approved browser removal](README.md#approved-browser-removal) supersedes the historical browser parity requirements below.

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

## Second feasibility batch, 2026-10-12

Three workstreams again used separate worktrees, shared dependency tooling and centralized sequential local checks. Native compilation ran on an ephemeral Linux runner with one Cargo/native job; no WebKit libraries were installed on this machine. The manual native workflow retains small evidence separately from the larger Debian package, with seven-day retention and no release publication.

| Delivered | Evidence and scope |
| --- | --- |
| [IPC ownership audit](ownership-audit.md) | Assigns observed channel families, resolves five constant references manually, and reviews nine parameter wrappers; identifies additional agent/UI/cleanup events omitted by literal scanning. Full T00/T04 contracts and performance evidence remain open |
| [Browser foundation](browser-feasibility.md), [#198](https://github.com/krazyjakee/21x/issues/198) | HTTP(S) navigation policy, exact task/panel/session authority, immutable approval arguments, revocation/disposal and bounded outstanding work; 44 authority tests passed. No native browser panel or screenshot/recording implementation |
| [Credential rehearsal](credential-migration.md), [#199](https://github.com/krazyjakee/21x/issues/199) | Explicit legacy formats/provenance, protected destination assertion and round-trip verification, immutable encrypted-only all-or-nothing output; 23 tests passed, including leading BOM preservation. No OS store or live profile import |
| [Installed native host](runtime-foundation.md), [#197](https://github.com/krazyjakee/21x/issues/197) | Ubuntu 24.04 debug Debian package compiled, installed and launched under Xvfb/D-Bus with system Node hidden. Real renderer ping, operation allowlist rejection, remote navigation denial, all five runtime probes, window close/shutdown and no surviving owned running process passed. See [smoke report](evidence/linux-x64-installed-gui.json) |

The final source revision `0946d24775917201d6389bc713dced198058cdaf` passed [Verify](https://github.com/krazyjakee/21x/actions/runs/38267753614): lint, typecheck, desktop/mobile builds, **5,007 tests passed / 4 skipped**, 21 subprocess/staging tests, seven Rust supervisor tests and both desktop UI regressions. The [native package workflow](https://github.com/krazyjakee/21x/actions/runs/38267769673) passed independently. Local validation passed 153 focused cases, full typecheck, changed-file lint, inventory refresh and Rust formatting. Current inventory scans 660 files; IPC/reference counts remain unchanged.

An intermediate Verify run timed out in an unchanged real-`gh` integration test at its five-second suite deadline. That test now bounds each subprocess to ten seconds and allows twenty seconds for its multiple calls. The focused case and complete final suite passed. Production issue-writing behavior is unchanged.

Linux debug-package proof does not establish release signing, AppImage/macOS/Windows installs, child reaping, abrupt parent-death/process-tree guarantees, cross-WebView Tauri ACL denial, browser parity or real legacy credential conversion. Foundation issue completion does not close the overarching [#193](https://github.com/krazyjakee/21x/issues/193) or G0/G1.

## Approved scope reduction, 2026-10-12

The user approved removing browser features from the migration. T02 is cancelled, D5 is accepted as removal, and T11 now covers removal/data compatibility rather than browser parity. Embedded browser and arbitrary website panels, browser automation/tools and recordings will be omitted from Tauri; external OAuth, external URL opening, artifact previews and trusted app WebView security remain required. Saved browser metadata/edges and recording files are retained without navigation or replay. The unused migration-only browser policy/authority modules and their 44 tests have been removed; the completed batch evidence above remains historical. The shipping Electron browser features are retired during host cutover, not removed by this scope update.

Scope-change validation: full TypeScript typecheck and ten inventory/terminology tests passed. Refreshed inventory scans 658 source files; Electron/IPC counts are unchanged. Native host/service code and dependencies did not change, so native compilation is deferred to the next implementation batch.

## Remaining-gate implementation batch

The retained desktop contract manifest now records exact command/event ownership,
typed legacy signatures and removed browser commands. The registry requires
request/result codecs, validation and authorization for every binding; unbound
operations fail closed. This establishes the contract framework, not acceptance
of G1: production service/native bindings and permission checks remain open.

The production canvas components now have a Tauri build policy that renders saved
browser and website panels as inert placeholders and hides browser creation and
connection controls. Store mutations reject new browser panels/edges and avoid
calling the legacy browser broker. Four renderer regressions cover inert mounts,
retained tools, repeated saved-data round trips and rejected mutations. Existing
Electron builds retain their current behavior. The experiment still uses its
separate frontend; production renderer adoption and service/tool removal remain
part of T08/T11.

The native credential candidate uses an OS-store application key and authenticated
encryption in the Node service. Its real Electron conversion workflow uses
synthetic isolated profiles and private pipes. Local validation passed 65 focused
credential/contract/inventory cases, full typecheck, 22 service/staging tests and
three Rust supervisor unit tests. These checks do not establish real Keychain,
Credential Store or Secret Service behavior; the manual platform proof is required.

The first cross-platform package run compiled both macOS architectures and Windows,
but packaged smoke failed; Linux compiled and then failed AppImage bundling. The
macOS PTY failure was traced to non-executable upstream helper files, and staging
now repairs permissions only on owned regular helpers. Windows initialization and
Linux bundling need diagnosed retries. These failures keep G0 open.

## Remaining work and next batch

Extend native packaging/runtime evidence beyond the Linux debug package, produce real legacy Electron/OS credential conversion fixtures (T03). Finish T00's resource/process ownership audit and performance baseline. Resolve the decision register and accept G0/G1 before broad feature porting.

Current gaps include all macOS/Windows evidence, browser retirement/data compatibility, native encrypted fixtures and conversion/rollback, production profile locking, parent-death/process-tree guarantees, complete command/permission mappings, renderer bridge adoption, domain engine extraction, task/session parity and installers/updates. No schema or live credential migration has run, and no migration release has been published.
