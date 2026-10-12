# Migration readiness audit — 2026-10-12

**Verdict: the Tauri migration is not ready for production cutover or Electron retirement. G0–G5 remain open.** The implemented synthetic slices are functional within the evidence below. The production application still uses Electron. The audit covers the working tree based on `38f1a1b0250c7ed4fb1d6268b26074399e01ab12`, including the shutdown/platform-proof continuation; it is not an installed candidate acceptance report.

## Source findings

The table records the original readiness audit. Subsequent [transcript page
work](transcript-pages.md) and [content configuration integration](configuration-integration.md)
bring the current manifest to 259 commands/52 events and the packaged synthetic-agent
slice to 38 scoped commands. The remaining 221 commands have no packaged/scoped
declaration. The generated source audit is current; the original regression report and
source observations below retain their stated scope.

| Finding | Evidence and implication |
| --- | --- |
| 258 retained commands and 52 events | `operations.json` is a typed/source-review manifest, not a complete runtime implementation |
| 37 scoped binding declarations | 14 database, 18 configuration proof and 5 fixture-agent bindings; configuration is a separate proof |
| 19 packaged synthetic-agent command declarations | `database-service.ts` registers database/agent codecs, not `ConfigurationBackend`; the native desktop policy restricts the same slice |
| 239 commands absent from the original packaged slice | At that audit, 221 also lacked a scoped declaration. The [retirement source audit](evidence/retirement-source-audit.json) now records 221 absent after pagination/configuration integration |
| Production bootstrap absent | The current service requires a disposable synthetic profile and deterministic adapter, and denies native/secret/configured-MCP seams |
| Full renderer absent from the Tauri build | `vite.tauri.config.ts` builds `src/tauri-spike`; 368 direct Electron API references remain in 34 production source files |
| Eight Electron packages and 47 runtime imports | Shipping main, preload, build, tests, release, updater and several native/worker services still require Electron |
| Feasibility identity differs from production | `com.krazyjakee.21x.tauri-feasibility` must not silently adopt production data, OAuth schemes or update feeds |

These are source observations, not grants or successful production behavior. `scripts/tauri-retirement-audit.mjs` reuses the AST inventory and exact codec lists to reproduce the counts, missing command names, import/consumer files, package scripts and ordered retirement tasks. Run:

```sh
node scripts/tauri-retirement-audit.mjs --output docs/tauri-migration/evidence/retirement-source-audit.json
```

The generator remains conservative: its readiness flags are false pending acceptance review, and its lists must be reviewed again when the production bootstrap changes. Historical importer/fixture code is not automatically a shipping dependency.

The audit found stale inventory coordinates and three stale AgentManager dynamic-event review locations after the continuation. The three forwarding functions were inspected; their names, producer closure and authority were unchanged. Their source coordinates were refreshed and inventory/contracts regenerated. Source-freshness checks must accompany future changes to these owners.

## Validation actually performed

| Check | Result | Scope |
| --- | --- | --- |
| Full Vitest suite, one worker | **5,101 passed / 8 skipped**, 352 passed files / 4 skipped | Existing Electron-launched main/shared/renderer/mobile regressions; not installed Tauri parity |
| Full lint | Passed, **0 errors / 165 warnings** | Existing warnings are recorded; no warning-free claim |
| Full typecheck | Passed | Compile-time types, not runtime authority |
| Shipping desktop and mobile build | Passed | Electron production build and mobile output; existing chunk/dynamic-import warnings remain |
| Tauri foundation subprocess suite | **26 passed** | Framing, staging, worker, cancellation and bounded owned-child fixtures |
| Installed evidence policy tests | **11 passed** | Report validation only; no installed WebView execution |
| Rust synthetic-agent unit/staged suites | **16 unit + 5 staged passed** | Actual bundled runtime, private pipes, cancellation/order/shutdown and database event roundtrip on local Linux |
| Native host check with agent/artifact features | Passed in the continuation | Compilation with one job; no GUI/package acceptance claim |
| Actual standalone manager/desktop/service proofs | Passed in the continuation; 18/30/14 observed events | Deterministic adapter, real manager and standalone Node 22.23.2 / SQLite 13.0.3 |

The eight full-suite skips include opt-in/environment-dependent cases. The two opt-in standalone proof tests passed separately in the continuation. Local desktop UI regression launchers need Xvfb, which is unavailable here; no native UI, installed non-Linux run, signing, live-profile import or model-provider parity was performed by this audit. Retained earlier installed reports keep their original revisions and scoped claims. The fresh local results are summarized in [readiness evidence](evidence/readiness-local.json).

## Remaining work and issue coverage

The subsequent [issue continuation report](evidence/issue-continuation-local.json) records the latest full recheck: **5,148 passed / 4 skipped**, all 363 test files passed with opt-in standalone proofs enabled. The initial run exposed a stale standalone database fixture expectation for the old credential wrapper; the corrected authenticated-format/tamper proof and final rerun passed. Latest native validation passed 20 unit + 6 staged cases. Typecheck, desktop/mobile/isolated frontend builds, lint (165 existing warnings), source freshness, 26 subprocess cases and 11 installed-evidence policy cases passed. No installed or hosted run for this uncommitted continuation is claimed.

All twenty new issues are open, with role owners, gate/task IDs, dependencies and concrete acceptance/evidence criteria. [#193](https://github.com/krazyjakee/21x/issues/193) is the overall tracker. Existing [#202](https://github.com/krazyjakee/21x/issues/202) remains the contracts umbrella; foundation issues #200/#201/#203 remain closed within their original scope.

| Acceptance area / parity rows | Open issue |
| --- | --- |
| Installed agent/HITL/reload and artifact proofs, all four targets (G2) | [#204](https://github.com/krazyjakee/21x/issues/204) |
| Matched performance and resource budgets (G0) | [#205](https://github.com/krazyjakee/21x/issues/205) |
| Minimum platforms/WebViews, pins and redistribution (G0/G1; D1/D7) | [#206](https://github.com/krazyjakee/21x/issues/206) |
| Large snapshots/bytes/streams/backpressure/reconnect (G1/G2; D2/D8) | [#207](https://github.com/krazyjakee/21x/issues/207), [#202](https://github.com/krazyjakee/21x/issues/202) |
| Production service owner, crash/recovery, process trees and complete provider shutdown (G2/G3) | [#208](https://github.com/krazyjakee/21x/issues/208) |
| Desktop/task UX and full renderer/preload removal (G3) | [#209](https://github.com/krazyjakee/21x/issues/209) |
| Task/project/configuration/settings effects, Agent CRUD and all retained domain operations (G1/G3) | [#210](https://github.com/krazyjakee/21x/issues/210), [#202](https://github.com/krazyjakee/21x/issues/202) |
| Five real agent providers, approvals/questions and handoff (G3) | [#211](https://github.com/krazyjakee/21x/issues/211) |
| Captain/projects/skills/triage/learning, admission/background and schedulers (G3) | [#212](https://github.com/krazyjakee/21x/issues/212) |
| Git/workspaces, MCP/task APIs, agent CLI/plugin configuration and secret injection (G3) | [#213](https://github.com/krazyjakee/21x/issues/213) |
| Terminals, Commander/chat/images and worker lifecycle (G3) | [#214](https://github.com/krazyjakee/21x/issues/214) |
| Native app/window/menu/tray/notifications/energy/permission/file/clipboard/OAuth callbacks (G3) | [#215](https://github.com/krazyjakee/21x/issues/215) |
| Task sources/connectors, isolated workers, OAuth refresh/callbacks (G3) | [#216](https://github.com/krazyjakee/21x/issues/216) |
| Canvas/artifacts/files security, complete browser retirement and saved-data preservation (G3; D5) | [#217](https://github.com/krazyjakee/21x/issues/217) |
| Voice recognition/TTS/native permissions/shortcuts and desktop-only audio (G3) | [#218](https://github.com/krazyjakee/21x/issues/218) |
| Mobile/pairing/auth/WebSocket/tunnel (G3) | [#219](https://github.com/krazyjakee/21x/issues/219) |
| Installed historical profile, all credentials, final paths/identity, backups and rollback (G4; D3/D4) | [#220](https://github.com/krazyjakee/21x/issues/220) |
| Production resources/signing/install/two-version update/uninstall policy (G4; D6) | [#221](https://github.com/krazyjakee/21x/issues/221) |
| Standalone Node test tooling and installed native UI regressions (G3/G5) | [#222](https://github.com/krazyjakee/21x/issues/222) |
| Shipping switch, final dependency/import/security/resource audit and documentation (G5) | [#223](https://github.com/krazyjakee/21x/issues/223) |

This maps every row of [the parity matrix](validation.md#feature-parity-matrix) and every remaining decision/gate to an owner issue. Individual operation/runtime-schema coverage remains #202's responsibility; feature issues do not exempt commands, events or callbacks from that review. Existing product/session enhancement issues retain their own scope and are not silently reclassified as migration completion.

## Cutover decision

Keep the shipping Electron configuration until the dependent acceptance criteria pass. Prepared proof workflows can run the outstanding installed diagnostics; their new local modes must be committed and available to hosted workflows before dispatch. Tests passing locally do not convert a debug synthetic host into a production candidate.

The next integration sequence is G0/G1 decisions/contracts and platform proof runs, then production service/native/domain/renderer integration, retained feature parity, installed data/release rehearsal, and finally [Electron retirement](electron-retirement.md). No production release, update feed or live profile was changed by this audit.
