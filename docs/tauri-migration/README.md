# Electron to Tauri migration: multi-agent plan

Status: proposed implementation plan; no runtime migration has been implemented by these documents.

Baseline: repository commit `2d65835`, package version `0.0.161`, inspected on 2026-10-12. Recheck the inventory against the implementation branch before assigning work.

## Objective and scope

Move 21x's desktop host from Electron to Tauri 2 while preserving tasks, projects, Captain sessions, transcripts, credentials, agent integrations, canvas tools, desktop voice, and the existing mobile web client. Keep the React interface and the TypeScript agent engine. Ship macOS x64/arm64, Windows x64, and Linux x64 builds, matching the current release workflow.

The recommended first target is a Tauri host supervising a bundled Node.js service. This is a planning decision based on the repository's existing Node SDKs, SQLite driver, PTY driver, and worker processes; it must pass the feasibility gate below. A later Rust backend rewrite would be a separate effort. Bundling Node means size and memory improvements must be measured across the entire application, including child processes.

These documents prepare the work and its review criteria. They do not authorize a release, alter the current shipping architecture, or establish dates before the feasibility work is complete.

## Reading order

| Document | Audience and purpose |
| --- | --- |
| [Architecture and contracts](architecture.md) | All implementers: process ownership, transport, platform services, data compatibility, and unresolved decisions |
| [Agent workstreams and task cards](workstreams.md) | Coordinator and implementers: file ownership, dependencies, merge order, handoffs, and ready-to-assign tasks |
| [Validation and rollout](validation.md) | Reviewers and release owner: parity matrix, fixtures, evidence, cutover, rollback, and completion gates |

The existing [AGENTS.md](../../AGENTS.md), [task lifecycle](../task-lifecycle.md), [transcript design](../transcript-event-sourcing-rewrite.md), [connector security](../connectors-security.md), and [voice documentation](../voice.md) describe behavior to preserve. Use current code when an older architectural description disagrees with it. For example, `src/main/database/schema.ts` currently declares schema **32**; `AGENTS.md` describes schema 17.

## Current migration surface

| Area | Repository evidence | Migration consequence |
| --- | --- | --- |
| Boot and desktop host | [src/main/index.ts](../../src/main/index.ts) | Extract service startup/shutdown from window, tray, menu, protocol, network-session, and native host behavior |
| Renderer bridge | [src/preload/index.ts](../../src/preload/index.ts), [ipc-client.ts](../../src/renderer/src/lib/ipc-client.ts), [renderer declarations](../../src/renderer/src/types/electron.d.ts), `src/main/ipc/*.ts` | Replace preload and IPC transport while preserving public operation and event semantics; direct `window.electronAPI` consumers also need migration |
| Agent engine | [agent-manager.ts](../../src/main/agent-manager.ts), `src/main/adapters/`, `src/main/agent-manager/` | Retain five backend contracts, centralized polling, admissions, handoffs, and transcript persistence; remove native host coupling, including sleep inhibition |
| Database and credentials | [database.ts](../../src/main/database.ts), [serializers.ts](../../src/main/database/serializers.ts), [connector credentials](../../src/main/connectors/credentials.ts) | Retain `21x.db`, WAL behavior, and schema migrations; replace Electron `safeStorage` with an explicit credential migration |
| Paths and app identity | [workspace-paths.ts](../../src/main/workspace-paths.ts), [app-identity.ts](../../src/main/app-identity.ts), [identity migration](../../src/main/app-identity-migration.ts) | Preserve worktrees, attachments, models, plugins, logs, and the existing 20x-to-21x import; do not assume Tauri's default data path matches Electron's |
| Background services | `src/main/*-scheduler.ts`, [task-api-server.ts](../../src/main/task-api-server.ts), [mobile-api-server.ts](../../src/main/mobile-api-server.ts) | One service owner continues work without a visible window; retain API authentication and mobile pairing |
| Terminals and subprocesses | [terminal.ts](../../src/main/ipc/terminal.ts), [node-worker-runtime.ts](../../src/main/node-worker-runtime.ts), `src/main/connectors/piece-host/` | Rebuild native modules for bundled Node; replace `utilityProcess`, `process.parentPort`, and Electron runtime assumptions |
| Browser canvas and recordings | [BrowserPanelContent.tsx](../../src/renderer/src/components/canvas/BrowserPanelContent.tsx), [panel-browser-broker.ts](../../src/main/panel-browser-broker.ts), [browser recording](../browser-recording.md) | Electron `<webview>` and `webContents` require a proven replacement for embedding, task-linked automation, screenshots, and recordings |
| Voice | `src/main/voice/`, [voice IPC](../../src/main/ipc/voice.ts), [spoken answers](../voice-tts.md) | Preserve optional local runtime, native microphone permission, global shortcut, worker packaging, cancellation, and desktop-only speech audio |
| Build and release | [package.json](../../package.json), [electron.vite.config.ts](../../electron.vite.config.ts), [.github/workflows/release.yml](../../.github/workflows/release.yml), [vitest.config.ts](../../vitest.config.ts) | Add Tauri/Rust builds, retain mobile output, move tests off Electron's Node runtime, and replace release artifacts and updater metadata |

## Invariants

- The Node service is the sole database writer and owner of agent sessions, project admission, schedulers, task APIs, and durable transcripts. Hiding, closing to tray, or reloading a window cannot create a second owner.
- All task starts still pass through `AgentManager.requestSession`; native commands cannot bypass project limits or HITL decisions.
- Stable task, project, session, transcript part, sequence, and revision identities survive upgrades and reconnects. The existing persisted transcript projection remains authoritative.
- Untrusted browser pages and artifact previews cannot call task, terminal, file, credential, or native host operations. Browser tools remain restricted to panels linked to the calling task.
- Secret values stay out of UI snapshots, diagnostic logs, command arguments, and migration files. Existing connector isolation, credential redaction, and allowlists remain in force.
- The current HTTP MCP token and mobile authentication contracts remain intact. A desktop transport change is not a redesign of the mobile or task APIs.
- Existing close/tray/quit behavior is characterized per OS before it is reproduced. Background work continues while the host remains running; this plan does not introduce an independent operating-system daemon.

## Milestones and gates

Task IDs refer to [the task cards](workstreams.md#task-cards).

| Gate | Required tasks | Exit evidence |
| --- | --- | --- |
| G0 — feasibility | T00–T03 | Packaged Node + SQLite + PTY + workers run on all target architectures; browser and legacy credential prototypes prove viable paths; baseline performance and identity inventory recorded |
| G1 — contracts | T04 | Command/event inventory, typed bridge, host interface, process protocol, and capability model reviewed and versioned; unresolved choices recorded with owners |
| G2 — working vertical slice | T05–T08 | Packaged Tauri opens a fixture profile, creates a task, streams a deterministic session through the durable projection, accepts an approval, and rehydrates after reload; production credential import follows in T10 |
| G3 — full parity | T09–T13 | All rows in the [validation matrix](validation.md#feature-parity-matrix) pass on the supported platform matrix, including browser tools, credentials, native workers, and background processing |
| G4 — release rehearsal | T14 | Electron-to-Tauri install, second Tauri update, uninstall behavior, and applicable rollback rehearsed; release and signing decisions recorded; artifacts retained |
| G5 — retirement | T15 | Electron removed from shipping dependencies, artifacts, tests, and host code; maintenance docs updated; final native and service boundaries audited |

G0 and G1 precede broad feature porting. A failed browser or credential prototype blocks a parity release. The coordinator may propose a changed product scope, but a feature cannot disappear solely because a plugin has no equivalent.

## Decision register

Record decisions and evidence in the implementation PRs and update this table as they are accepted. These are the initial decisions to resolve, not assertions that the proposed design already works.

| ID | Proposed default or question | Owner | Needed by |
| --- | --- | --- | --- |
| D1 | Tauri 2 + bundled, pinned standalone Node; prove redistribution and native-module compatibility | Runtime + release | G0 |
| D2 | Private stdio RPC between Rust and Node; typed desktop API above it | Bridge + runtime | G1 |
| D3 | Keep `better-sqlite3` and existing schema; one writer; use explicit compatible profile paths | Data | G1 |
| D4 | Versioned credential storage backed by an OS secret store; staged import of legacy `safeStorage` values | Data + security reviewer | G0/G1 |
| D5 | Prove a native browser-panel implementation; record any platform-specific adapter needed | Browser | G0 |
| D6 | Preserve current manual release policy; choose signed Tauri updater or explicit manual updates; rehearse framework transition | Release | G1/G4 |
| D7 | Pin Rust, Node, Tauri/plugin versions and supported OS/WebView minimums from compatibility tests | Runtime + verification | G1 |
| D8 | Choose streaming byte encoding, queue limits, and snapshot pagination from load tests | Bridge + verification | G1/G2 |

## Starting the effort

Assign T00 and the three feasibility cards first. Each agent works in a separate worktree and uses synthetic or copied profiles. The coordinator owns shared contracts and integration. After G0, freeze G1 interfaces and distribute the independent implementation streams; [workstreams.md](workstreams.md) specifies ownership and merge order.

Use the release workflow's current behavior as the baseline: releases are manual and unsigned/ad-hoc today. The signing guide explains optional signed macOS builds; its existence does not mean release CI is currently signed. Do not send Tauri packages through Electron updater metadata without an explicit transition design.
