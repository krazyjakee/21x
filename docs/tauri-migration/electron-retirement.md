# Electron retirement preparation

Status: prepared, **blocked on accepted G0–G4 evidence**. Execution owner: coordinator/release, [#223](https://github.com/krazyjakee/21x/issues/223). This runbook specifies the concrete switch/removal order; it does not claim that the feasibility host can replace production today. See [readiness audit](readiness-audit.md) and the [source manifest](evidence/retirement-source-audit.json).

## Prerequisites

1. Accept minimum platforms/runtime distribution, identity/path/credential/update decisions and matched performance budgets (#205/#206/#220/#221).
2. Close runtime contracts and integrate the actual production service/domain/native/renderer owners (#202/#207–#210/#215).
3. Pass all retained feature/security/lifecycle scenarios and installed target proofs (#204/#211–#219/#222). Include forced quit, failed cleanup, large data, hidden windows and recovery.
4. Rehearse installed historical-profile conversion, old-host exclusion, immutable backup, credential access and documented rollback boundaries (#220).
5. Rehearse first framework-transition installation and the second Tauri version through the chosen manual/updater path, including signatures where configured, uninstall/data retention and interrupted recovery (#221).
6. Retain accepted revision/checksum/platform/fixture reports and the exact supported Electron recovery installer. Review a concrete production candidate before publishing through the normal release process.

## Ordered switch and removal inventory

| Surface | Current concrete paths/dependencies | Required replacement / removal condition |
| --- | --- | --- |
| Production entrypoints | `package.json` main/dev/build/build:* and `src/main/index.ts`, `electron.vite.config.ts`, `src/preload/` | Build the full production renderer and sole Node owner with the final native Tauri host; preserve the mobile build. Switch only after G4 acceptance |
| Renderer bridge | `src/renderer/src/lib/ipc-client.ts`, direct consumer files listed in source manifest, Electron declarations | Replace all retained preload access with reviewed typed client/native callbacks and native UI evidence; remove preload-only globals/types after consumers are gone |
| Database/paths/credentials | Electron database/AgentManager wrappers, `electron-secret-storage.ts`, workspace/attachment/profile defaults, identity migration | Wire explicit production paths and OS credential provider; prove installed conversion and cross-host writer exclusion before removing Electron defaults |
| Native services | Window/menu/tray/dialog/shell/clipboard/notifications/power/permissions, `agent-manager/electron-host.ts`, OAuth protocol registration | Reproduce accepted per-OS behavior and exact callback permissions; remove runtime Electron imports after native parity passes |
| Workers and subprocesses | `node-worker-runtime.ts`, connector piece host, voice workers, `utilityProcess` and `process.parentPort` assumptions | Package and supervise standalone Node workers/native addons with owned-process teardown; preserve unrelated user processes |
| Production Electron packages | `electron`, `electron-builder`, `electron-vite`, `electron-updater`, `@electron-toolkit/utils`, `@electron-toolkit/tsconfig`, `@electron/fuses`, `@electron/notarize` | Remove after replacement entrypoints/update/signing/test tooling exist; update lockfile and verify the production dependency/bundle graph |
| ABI/install hooks | `scripts/rebuild-native.mjs`, Electron `postinstall`, `after-pack.js`, Electron fuse/native rebuild settings | Replace with reproducible pinned standalone Node ABI/resource staging on every architecture; remove Electron install hooks |
| Distribution/update | `.github/workflows/release.yml`, `scripts/release.sh`, Electron build metadata, updater hooks/entitlements/installer resources | Switch to rehearsed production Tauri artifacts and the accepted update/manual policy. Keep historical Electron feeds/installers separately for the support window |
| Tests | Electron Vitest launchers, `test/setup-main.ts`, `scripts/nav-rail-layout/`, `scripts/commander-input/` | Run host-neutral tests under standalone Node and redesign actual native UI regressions; isolate legacy importer tests from production tooling |
| Architecture/setup docs | README, AGENTS, setup/Windows/signing/voice/connectors/security/developer-test docs | Describe delivered owners, supported paths/platforms/builds, permissions, update and recovery behavior; label historical migration fixtures explicitly |

Re-run `node scripts/tauri-retirement-audit.mjs` before and after each stage. The current 47 runtime imports, 34 direct-consumer files and eight packages are an actionable source inventory. The audit cannot authorize deletion or certify an installed package. Final verification must inspect runtime dependency graphs, service/native/UI resource contents and every remaining host assumption, including dynamic loading and platform-specific paths.

## Preserve during the recovery/support window

- The exact Electron installer/release metadata matching supported legacy profiles and the consistent immutable pre-cutover backup, journal and resource checksums.
- A separately retained transitional importer/credential fixture where needed: `scripts/credential-proof/electron.cjs`, compatible legacy `safeStorage` conversion and identity migration behavior. Preserve ciphertext formats and original OS-store access rather than treating format labels or historical fixtures as removable runtime code.
- Existing task/project/session/transcript IDs, credential classes, attachments, worktrees, model/plugin resources and dormant browser panel metadata/recording files. Browser retirement never authorizes deletion or replay of saved data.
- Historical reports and fixture/version provenance. Foundation evidence remains valid only for its recorded revision/scenario.

Legacy-only Electron components may remain in separately documented transition/test artifacts. They must not remain required by the final production host/service/renderer bundles or ordinary production tests. Any exception gets a concrete support period, owner and reason in the final audit.

## Release and rollback checkpoints

Before conversion commits, recover the intact original profile/credentials and matching old installer. After conversion with no new live writes, prove restoration of the complete pre-cutover profile and original credential format. Once new task/transcript/source writes or external agent actions occur, prefer forward repair or a tested reverse migration; restoring an old snapshot loses newer local data and does not undo external effects. Do not promise lossless downgrade without that proof.

First publish the reviewed production candidate through the accepted transition mechanism, then prove a second Tauri update. Distribution signing/notarization and updater signatures are distinct checks. A manual policy needs a working download/install route with accurate UI. Do not publish Tauri binaries into the old Electron feed without an accepted, tested transition. Retirement of old feeds/artifacts/support follows the agreed observation/recovery period.

## G5 exit record

Record the final production revision and artifact checksums, all target acceptance reports, removal inventory, runtime/dependency/native capability audit, retained transition exceptions/support dates, standalone test/native UI results and maintained architecture documentation. Close #223 and the G5 checkbox in #193 only after the shipping bundles function without Electron and all prerequisites have accepted evidence.
