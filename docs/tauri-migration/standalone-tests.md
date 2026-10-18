# Standalone portable test suite

## Additive full host-neutral runner (#222, October 2026)

`pnpm test:host-neutral` is the proposed replacement for host-neutral test
execution. The existing `test:run`, `test:main`, `test:renderer`, `test:tauri`,
`vitest.tauri.config.ts` and `scripts/tauri-test.mjs` retain their existing
behavior while the team validates and adopts the new commands. No Electron
shipping dependency or installed UI launcher is retired by this addition.

After the explicit pinned Node/native preparation documented below (and database,
connector and production staging when selecting their proofs):

```sh
pnpm test:host-neutral:audit
pnpm test:host-neutral -- --service-proofs --production-proofs --terminal-proofs --run-receipt=/tmp/host-neutral-run.json
pnpm test:host-neutral -- --project=renderer
pnpm test:host-neutral -- --project=mobile
pnpm test:host-neutral -- --node-tests
# Separate historical host/credential/transition regressions, with the root
# addons prepared for the retained Electron runtime:
pnpm test:electron-transition
```

The new configuration includes every reviewed Vitest file in four projects:
main/service/tooling, shared, the full host-neutral renderer, and mobile. The
three existing `node:test` files run through `--node-tests` under the same pinned
executable. Optional private-pipe proof wrappers require their explicit flags;
they are reported as opt-in exclusions rather than claimed as default passes.
Platform-dependent tests retain their own conditions and report their actual
skips. `--run-receipt=path` additionally records runtime/native/tool hashes,
base Git revision and dirty state, eligible test hashes, selected proof flags,
opt-in exclusions, framework exit/signal and filtering scope. The framework
report identifies actually executed cases; eligible files are not claimed as
executed when filters are present. A filtered reporter run is a launcher
control, not a complete-suite run.

Before launching either framework, the runner checks physical canonical Node,
SQLite and PTY packages and exact versions from `scripts/tauri-runtime.json`.
A separate process under that Node actually opens/queries/closes SQLite and
loads the PTY addon, checks Node ABI 127 and verifies that native files came
from staged resources. Test setup rechecks the owning executable and canonical
package paths in each project. Inherited Electron/Node injection and resource
path overrides are removed. There is no implicit preparation, native rebuild
or root-addon fallback. Root addon inventories/hashes are checked before and
after the real preflight; an `--ignore-scripts` installation need not contain a
root PTY binary. Node/package version checks and local hashes are reproducible
provenance, not upstream release-signature or redistribution acceptance.

`test/electron-transition-tests.json` explicitly reviews each remaining
historical test with a reason. The audit records every test hash and the first
literal import path reaching Electron. An unknown edge, duplicate/stale entry,
missing reason or obsolete quarantine fails. Eighteen database/domain test
files now import the existing portable schema/manager fixture instead of the
Electron database helper, without changing their assertions. Tests of the
shipping Electron host, IPC adapters, safeStorage formats and packaging hooks
remain separately runnable. A deliberate Electron import-denial test remains
in the standalone cohort; it verifies the throwing import boundary.

This static review follows relative/alias value imports, reexports, literal
`require`/dynamic imports and `importActual`, including cycles and JS-to-TS
resolution. Erased type imports do not imply an Electron runtime dependency.
External package internals and nonliteral imports are outside that static
classification; successful execution with the Vitest import fence and staged
service resource checks supply separate evidence. Moving a test between
cohorts requires an explicit review; the audit never silently skips a new
Electron dependency.

The production boundary proof starts the actual singleton with real SQLite
and background owners, using synthetic protected-key/native readiness
boundaries. It sends diagnostic/fixture/probe/reset requests through serialized
private peers after initialization, checks `UNKNOWN_OPERATION`, verifies the
owner/project state is unchanged, and joins ordinary shutdown. The same proof
also runs against the staged production engine when `--production-proofs` is
selected. A third actual hashed stdio child receives legacy fixture/smoke
environment switches; it still rejects the same nine operations, keeps normal
ping/shutdown usable and creates neither a profile nor a smoke report. This
last control deliberately does not initialize OS credentials. No live provider,
OS credential prompt or live profile is used.
`node scripts/production-automation-artifacts.mjs --report=/tmp/production-artifacts.json`
checks the built production frontend and staged Source entries, verifies their
manifest hashes, and uses the separately built diagnostic frontend as a
positive control. This combines runtime rejection with artifact provenance;
string absence alone is not installed native dispatch or authorization proof.

The native source policy separately fixes the production invoke-handler list to
`engine_status`/`desktop_invoke`, preserves the compile-time exclusion of the
synthetic native entry point, and reviews the absence of embedded automation
plugins. These are source checks, not a launched installed-binary test. Native
source/config/lock hashes accompany the built frontend/Source artifact report.

Current [upstream WebDriver guidance](https://v2.tauri.app/develop/tests/webdriver/)
(retrieved 18 October 2026) distinguishes cross-platform embedded WebdriverIO
from direct `tauri-driver` on Windows/Linux. The embedded route needs additional
native automation plugins; this continuation adds none to production. A future
pinned installed harness must isolate any such instrumentation, prove its
production exclusion, capture the actual OS/WebView/driver/artifact identity,
and exercise physical input/clipboard/Drop rather than count happy-dom as OS
evidence. Existing Electron UI commands keep their historical meaning until
that replacement is published and adopted.

The additive `.github/workflows/tauri-host-neutral.yml` is manual-only and
master-only. It prepares four source targets with `--ignore-scripts`, explicitly
stages the standalone resources, runs the main/shared/renderer/mobile and
foundation subprocess cohorts, and retains framework reports plus run/inventory
receipts even on failure. A separate Linux job retains the historical Electron
cohort. Production/terminal wrappers and installed UI/release scenarios are
explicitly unavailable in this source-only matrix. The existing Verify trigger,
commands and workflows are unchanged. YAML trigger/matrix and shell syntax
checks are local preparation; no workflow has been dispatched or hosted pass
claimed while Actions is disabled.

The installed native navigation/scroll/keyboard/focus/clipboard/Drop matrix and
hosted transport/worker/adversarial/load/migration/release execution remain
separate acceptance work. Historical installed diagnostic reports keep their
original revision/scope. Repository Actions is disabled, awaiting the user's
decision; no settings change or workflow dispatch is authorized. Linux local
reports cannot stand in for installed Windows/macOS or a hosted run.


Local continuation validation on the inherited `2563e3c9` runtime plus these
reviewed test/tool changes: **7,080 standalone passes / three optional installed
speech-runtime skips in 569 files**, all eligible files selected with service,
production and terminal proofs; **30 foundation passes / zero skips** under the
same Node; **923 historical Electron passes / one unavailable PowerShell case
in 60 files**. The unchanged original application command also passed the 193
affected cases in 21 files. Electron 44.0.0 reports Node 24.18.1 / ABI 149;
standalone remains Node 22.23.2 / ABI 127. Forced typecheck, lint (zero errors /
165 baseline warnings), staged production resources, both Tauri frontends,
76-file production frontend/two-entry Source artifact checks and 919-file
inventory/contracts pass. These are local results; revision-bound evidence
records any later rebase checks separately. The inherited `f24d70e0` execution-owner/adapter/private-peer slice then passes **144 affected cases / zero skips in nine files**, forced typecheck/lint, refreshed production artifacts and 920-file inventory/contracts. Its two added test files bring the current audit to **574 host-neutral files (571 Vitest plus three node:test) and 60 historical files**; that affected recheck is separate from the earlier full baseline.

## Earlier scoped runner and retained evidence

Scoped test-tooling continuation for [#222](https://github.com/krazyjakee/21x/issues/222). `pnpm test:tauri` runs selected database/transport/contract/renderer tests under the pinned staged **Node 22.23.2**, using the staged standalone-ABI SQLite package. It does not launch Electron, rebuild native addons, replace the root Electron addon or select a live profile. The existing full application test launcher remains until the other test/host migrations are complete.

Prepare the resources once, then reuse them:

```sh
pnpm tauri:prepare:native
pnpm test:tauri
```

The optional service proofs additionally require the actual synthetic service bundle:

```sh
pnpm tauri:prepare:database
pnpm test:tauri -- --service-proofs
```

The runner chooses the staged Node executable, checks SQLite identity/version, removes Electron's runtime environment flag and supplies the explicit staged paths. The Vitest configuration checks the actual Node version, rejects an Electron process, requires the canonical staged SQLite package, and aliases SQLite to that package's entrypoint. There is no repository-addon fallback. Configuration/root/project override flags reject; ordinary test filters/reporters remain available.

The suite uses a separate authenticated synthetic credential provider and no Electron setup module. Its database helper uses the portable manager, in-memory SQLite, actual schema/migrations and explicit temporary path metadata, without a host wrapper or disk profile creation. The selected tests cover durable pages/events, real project/profile authority, transport cancellation/disconnect ownership, exact codecs/native callback contracts, inventory freshness, and renderer hydration. All 29 shared test files run under standalone Node (393 cases). Portable graph proofs additionally use their isolated actual database/manager fixtures. `--service-proofs` adds three actual private-pipe bundle proofs with disposable locked profiles.

Vitest-resolved Electron imports route to a module that throws. A negative control deliberately imports Electron and verifies rejection; another checks Node/ABI identity. This enforces the selected test graph's boundary, not an installed GUI or complete production dependency audit. The renderer cases use happy-dom and test transports; native WebView/OS behavior remains separate evidence.

Local validation passed **463 cases in 44 files**, with all six standalone/private-pipe proof wrappers enabled and no skips. The affected 28 database cases also passed under the existing Electron launcher after switching their helper to the portable owner. Full forced typecheck, changed-source lint, workflow syntax and source freshness passed. The earlier full application recheck remains 5,148 passed / 4 skipped; subsequent tooling/lifetime evidence identifies its own source and validation scope.

The default CI mode passed **460 cases in 41 files**, also without skips. The [retained local report](evidence/standalone-tests-local.json) identifies source hashes, both test report hashes, actual runtime/import-denial controls and the 40 checked workflow shell steps. A config-override invocation failed before spawning the legacy runner.

Verify and both native platform workflows reuse their native staging for the default portable suite. Default mode omits three bundled-service wrappers; the native synthetic workflow steps separately record those service proofs. [Hosted Verify for `23109a4`](evidence/continuation-hosted-verify.json) passed the default 460 cases and the real desktop UI regressions. Both macOS installed jobs also passed, but their JSON test report was absent: pnpm forwards a literal `--`, which Vitest treated as end-of-options and silently ignored the reporter flags. The runner now removes that separator, and platform steps require a nonempty successful JSON report.

Windows exposed a second tooling failure before packaging: its CRLF checkout made Vitest reject shebang-bearing scanner modules. Converting those two modules to CRLF reproduced both failures locally. `.gitattributes` now keeps `.mjs` files in LF; a regression exercises Git's checkout filters with `core.autocrlf=true`. Another regression starts the actual staged runner with pnpm-style arguments and verifies that it filters to one test and writes JSON. The focused runtime/scanner suite passed 21 cases in three files. The historical 460/463 reports above describe their original revision; these two added controls increase the current default/service suite to 462/465.

Complete removal of Electron test setup, UI launchers, rebuild scripts and shipping dependencies remains #222/#223 work. The [retained macOS installed reports](evidence/installed-agent-macos-23109a4.json) establish only their stated synthetic scope; the Windows retry and Linux/artifact matrix remain separate acceptance work.

The subsequent provider/startup continuation adds four actual bundled prerequisite-denial controls (runtime, redirected stdout, invalid profile and invalid resources). The service suite now has 469 cases in 44 files; the default suite remains 462/41. Startup diagnostics use fixed classifications without dependency exceptions or private paths.

For quick platform diagnosis, dispatch the packaged-platform workflow with `service_only=true` and a synthetic mode:

```sh
gh workflow run tauri-packaged-platforms.yml --ref codex/tauri-migration-readiness \
  -f target=windows-x64 -f mode=synthetic-agent -f service_only=true
```

This runs pinned native staging, portable tests, preflight and the actual private-pipe configuration/transcript/agent proofs. It omits Rust installation/compilation, GUI packaging and installed execution. A separate concurrency group and `-service-only` evidence name keep this cheap diagnostic run distinct from installed acceptance; its provenance also states that scope. Service-only feasibility mode rejects rather than producing an empty database-service proof.

## Provider and connector regression continuation

All five backend adapter suites, Claude history and permission resolution now
run under the pinned standalone Node with Electron imports forbidden.
[Provider regression evidence](evidence/provider-adapters-portable-local.json)
records 299 cases in seven files and the expanded complete opt-in service suite.
Process/SDK interactions are mocked. This exercises the adapters' protocol,
approval, streaming, history and error handling, while real installed providers
and authenticated model sessions remain [#211](https://github.com/krazyjakee/21x/issues/211).

The connector/source/security graph also runs standalone, including portable
runtime/plugin/form services and an actual staged child loading both pinned
local hooks. Its commands and revision scopes are retained in
[connector shutdown](connector-shutdown.md). Prepare connector resources with
`pnpm tauri:prepare:connectors` before the opt-in worker proof; that proof joins
plugin/runtime close before its real SQLite fixture closes. Default and opt-in
suite counts are reported separately in their evidence.

The portable suite now includes CLI asset/detection regressions and the
[installer network owner](installer-network.md). Its complete opt-in local run
passed 1,055 cases with zero skips in 76 files. The provider matrix at `85e09e3`
passed both macOS targets but exposed four Windows fixture assumptions;
[correction evidence](evidence/provider-platform-fixtures-local.json) records
platform paths/absolute roots and the Windows Pi shell launcher. The corrected
Windows retry is separate pending evidence, rather than a reclassification of
the failed job.

The [corrected provider/installer matrix](evidence/provider-installer-four-target-scenarios.json)
passed the same `d892d8a` revision on all four targets: 1,046 default portable
cases with zero skips in 72 files per target, staged actual connector local hooks
and six startup/transcript controls. This predates the later process/API-owner
changes. The earlier `85e09e3` matrix remains failed overall. No installed GUI,
real model provider, privileged installer or system-proxy acceptance is claimed
by these service-only receipts.

The later [task API matrix](evidence/task-api-service-four-target-scenarios.json) passed 1,137 default portable cases with zero skips in 76 files on all four targets at `08d495f`. Local portable coverage subsequently adds the retained HTTP MCP, mobile server/lifetime, task automation and Captain wakeup suites. [Captain wake ownership](captain-wake-owner.md) documents the current full local results and the distinction between fixtures and production native/provider acceptance.

The [mobile/Captain service matrix](evidence/captain-mobile-four-target-scenarios.json) at `8bc28c1` passed all four targets with 1,272 default portable cases and zero skips in 83 files per target. It includes HTTP MCP, mobile, task automation and Captain ownership, and predates recurrence/coordination. Current [scheduled coordination](scheduled-coordination-owner.md) local validation passes 1,328 complete opt-in cases in 91 files. Each report retains its original revision and scope.
