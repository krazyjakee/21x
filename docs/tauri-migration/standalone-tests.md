# Standalone portable test suite

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
