# Migration implementation status

Updated 2026-10-12 through application verification at `711dd21` and baseline harness `fad9ed1`. **The shipping application still uses Electron, and G0–G5 remain open.** The [overall migration tracker, #193](https://github.com/krazyjakee/21x/issues/193), retains the remaining acceptance work. Completed scoped issues and successful fixtures establish the behavior they exercised; they do not establish a finished migration or authorize live cutover.

This page describes current work. Earlier batch notes and reports retain their original source revisions and limits; their former platform failures or unimplemented-agent statements are historical.

## Completed scoped platform evidence

[Installed package proof #200](https://github.com/krazyjakee/21x/issues/200) and [real OS credential conversion proof #201](https://github.com/krazyjakee/21x/issues/201) are closed. All four requested targets have successful retained evidence.

| Target | Installed package evidence | Real OS synthetic credential evidence |
| --- | --- | --- |
| macOS x64 | [Installed DMG report](evidence/macos-x64-installed-gui.json) | [Credential report](evidence/macos-x64-credential-proof.json) |
| macOS arm64 | [Installed DMG report](evidence/macos-arm64-installed-gui.json) | [Credential report](evidence/macos-arm64-credential-proof.json) |
| Windows x64 | [Installed NSIS report](evidence/windows-x64-installed-gui.json) | Windows target in the [retained credential evidence](credential-proof-evidence.json) |
| Linux x64 | [Installed AppImage report](evidence/linux-appimage-x64-installed-gui.json), earlier [Debian report](evidence/linux-x64-installed-gui.json) | Linux target in the [retained credential evidence](credential-proof-evidence.json) |

The package reports exercise installed resources with system Node hidden, trusted WebView invocation, explicit operation/navigation restrictions, bundled SQLite/PTY/worker and representative SDK import probes, normal shutdown and absence of a surviving owned running service. SDK imports do not exercise model-provider integrations. These are debug feasibility packages; release signing, updater compatibility, production feature parity and complete abrupt-death/process-tree guarantees remain open.

The [credential evidence manifest](credential-proof-evidence.json) records per-target workflow URLs, source commits, runtime versions and synthetic scenario results. Real OS-store conversion exercised current credential classes, destination reload/tamper rejection and preservation/reopening of original Electron credentials. It used isolated synthetic profiles and private pipes. Existing signed-installation permissions, arbitrary historical profiles and live import remain unproven. See [credential proof scope](credential-native-proof.md).

## Implemented domain and contract work

| Area | Current implementation | Remaining boundary |
| --- | --- | --- |
| Inventory and contracts | [Current inventory](inventory.json): 682 source files, 713 IPC references; eleven dynamic sites retain unresolved AST expressions and have explicit manual owner/name maps. The [manifest](operations.json) contains 310 retained operations: 258 commands and 52 events | About 37 retained commands have real scoped bindings. Most operations and native callbacks still need owners, validators and authority checks; reviewed names/types are not runtime permissions |
| Private service transport | Version/epoch checks, UTF-8 NDJSON framing, bounded queues/requests, deadlines, cancellation, redacted errors, disconnect and no blind mutation replay; [protocol](protocol-foundation.md) | General large-snapshot/byte-stream limits, pagination/chunking and overflow recovery still need complete policy and load evidence |
| Database and configuration | Actual schema-32 `DatabaseManager` extracted with explicit paths/runtime data and an Electron wrapper; real task/project/settings/transcript slice plus scoped skill/project/repo/resource bindings; [database foundation](portable-database.md), [configuration contracts](configuration-contracts.md) | Full settings/credential semantics, lifecycle-dependent configuration effects and remaining domain operations |
| Profile ownership | Shared writer-process lifetime lock precedes database/provider startup; standalone service uses the same guard; [lock contract](profile-lock.md) | Installed live-profile cutover, filesystem support decisions and backup/import ownership |
| Actual agent lifecycle | Portable actual `AgentManager` core, explicit host seams and Electron wrapper; five bindings over the real deterministic fixture adapter: selected-Agent listing, start, resume, approve and stop; [owner extraction](portable-agent-manager.md), [desktop boundary](agent-desktop-boundary.md) | No Agent CRUD/send/general-session grant, production SDK parity or full retained agent feature coverage |
| Renderer boundary | Typed client, epoch/sequence checks, listener disposal and durable rehydration; isolated task/agent UI uses native/service transport; [client contract](renderer-client.md) | Full production renderer and every direct preload consumer |
| Credential candidate/recovery | Encrypted original/journal, staged candidate publication, interruption recovery, rollback and resource preservation checks; format-compatible reopening through the real `DatabaseManager` implemented and locally tested; [rehearsal](profile-import-rehearsal.md) | Bounded fixture/copy rehearsal only: no source activation, live-profile discovery/import, signed-installation access or release cutover |

The actual agent slice starts an assigned task through admission control, persists polled output into the durable projection, displays a genuine pending permission, confirms the real adapter's decision, reaches completion/review, resumes/recreates the owner and acknowledges stop/shutdown. Approval requires a nonempty request ID, exact task/project/session/adapter association and a current persisted running request. An in-flight claim rejects concurrent duplicates before an owner await. Live resume publishes the owner's current status for a reloaded renderer without inventing a provider-health observation. Shutdown bounds the drain of tracked startup/poll/idle work and flushes pending projection notifications before successful return; broader SDK backfill and late-creation ownership remains open.

Browser removal is approved: T02 is cancelled and T11 covers removal/data compatibility. Tauri canvas browser/webpage surfaces and legacy controls are inert; saved metadata/edges and recording files are preserved without navigation or replay. Shipping Electron behavior remains until cutover. External OAuth, external links, sandboxed artifact previews and trusted app WebView security remain required. Historical migration-only browser policy modules/tests were removed. See the [scope decision](README.md#approved-browser-removal).

## Completed validation batch

Latest [local batch evidence](evidence/gate-batch-local.json) passed: 54 credential/rehearsal cases including actual candidate `DatabaseManager` reopen, 67 shared contract/schema cases, full TypeScript typecheck, lint for 18 changed TypeScript files, isolated frontend build, locked Rust metadata and formatting. The actual bundled service wire proof passed with 14 events. The standalone actual agent boundary proof passed with 85 portable modules, 30 validated events and zero warnings/errors, including current/stale/duplicate approval, pending live-resume status, owner recreation, durable delta and acknowledged teardown. These are focused local results, not a new installed-platform acceptance report.

| Implemented proof | Current evidence state |
| --- | --- |
| Actual Electron performance baseline | [Hosted run](https://github.com/krazyjakee/21x/actions/runs/38301839412) passed three sequential starts against built main/preload/full renderer with isolated profiles and private reporting; [retained report](evidence/linux-x64-electron-baseline.json). No matched Tauri/Electron performance decision; [measurement limits](performance-baseline.md) |
| Hostile artifact WebView authorization | [Installed Linux run](https://github.com/krazyjakee/21x/actions/runs/38300023337) passed native positive controls, excluded-label command/event denial, bounded sandbox relay checks and shutdown after the packaged URL correction; [retained report](evidence/linux-x64-artifact-authorization-installed-gui.json). Other targets and production viewer integration remain open; [boundary and limits](artifact-authorization.md) |
| Installed synthetic-agent UI | [Installed Linux run](https://github.com/krazyjakee/21x/actions/runs/38299978450) passed all twenty actual start/HITL/projection/pending reload/live resume receipts and normal shutdown; [retained report](evidence/linux-x64-synthetic-agent-installed-gui.json). Equivalent agent evidence on other OS families remains open |
| Candidate journal/import/recovery | Local fixture tests and real format-compatible database reopening passed; installed historical/live-profile migration and platform durability remain open |

The [final application Verify](https://github.com/krazyjakee/21x/actions/runs/38300673519) passed at `711dd21`: lint/typecheck, desktop/mobile builds, **5,093 tests passed / 8 skipped**, 26 subprocess regressions, seven supervisor tests and both desktop UI regressions. Its [retained summary](evidence/gate-batch-verify.json) records a corrected test expectation for the new bounded shutdown contract. The native agent/artifact reports exercised application source `a4a980f`; the later commit changes only that regression test. Hosted native/baseline runs are serialized to limit hardware load, and dependencies/native staging are reused. Reports identify the revision they actually exercised.

Historical evidence remains useful within its scope: [Verify at `0946d24`](https://github.com/krazyjakee/21x/actions/runs/38267753614) passed lint/typecheck/builds and 5,007 tests; the [first installed Debian workflow](https://github.com/krazyjakee/21x/actions/runs/38267769673) passed independently. The later [thirteen-check installed Linux database/task flow](evidence/linux-x64-synthetic-desktop-installed-gui.json) proved persistence across a real WebView reload before the actual agent boundary was added. Those historical runs do not prove the latest twenty-check agent UI or complete production renderer.

## Remaining acceptance gates

| Gate | What still prevents acceptance |
| --- | --- |
| **G0 — feasibility** | Matched resource/performance baseline and regression budgets, accepted supported platform/WebView minimums, app identity/path and redistribution decisions. Four package and OS credential proofs are completed scoped evidence, not the entire gate |
| **G1 — contracts** | Complete runtime schemas, real command/event/native callback bindings, caller/task/project/path authority and capability review; remaining decisions and general snapshot/stream limits. The typed 310-operation framework and eleven manual wrapper reviews do not make every operation safe or implemented |
| **G2 — working vertical slice** | Equivalent agent/HITL/reload and artifact authorization evidence on the other OS families, plus review of lifecycle/recovery/large-data limits. The twenty-check installed Linux slice and separate-WebView authority proof passed; the full gate remains open |
| **G3 — retained feature parity** | Full production renderer, all five real agent providers, Captain/admission/handoff, background/mobile/API services, terminals/workers, voice, connectors/OAuth, native host services and retained canvas/artifact behavior across the [parity matrix](validation.md#feature-parity-matrix). Complete browser retirement/data-preservation checks remain required |
| **G4 — release rehearsal** | Signed/installed historical-profile conversion, live import and credential rollback boundaries, release signing/notarization, first framework-transition install, second update, uninstall and recovery/cutover rehearsals; accepted updater/manual-update policy |
| **G5 — retirement** | Switch the shipping application only after prior acceptance, remove Electron shipping dependencies/artifacts/host assumptions and complete final native/service/security/documentation audits |

No live migration release has been published. The next evidence batch closes only its scoped proof work; [#193](https://github.com/krazyjakee/21x/issues/193) and the remaining gates stay open until their complete exit criteria are reviewed.
