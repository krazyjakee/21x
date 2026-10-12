# Portable AgentManager host

`src/main/agent-manager-core.ts` owns the existing production session lifecycle, admission/queue ownership, startup deadlines, polling coordinator, approval forwarding, transcript projection, resume and stop behavior. The extraction changes host calls and import boundaries; it does not replace those operations with a second manager. `src/main/agent-manager.ts` remains the shipping Electron wrapper with its original constructor and `BrowserWindow` attachment API.

The portable constructor requires an explicit `AgentManagerHost`. Its services are renderer delivery, notification support/click handling, energy blocking, secret sessions/shell wrapper access, managed task-MCP configuration and adapter creation/identification. Renderer and native services can be explicitly unsupported. Agent secret/API-key configuration fails when secrets are unsupported; configured MCP servers fail when configured MCP is disabled. A disabled managed task-MCP host does not register a task/browser server or claim those tools are available.

Database profile, workspace and attachment locations remain the responsibility of the supplied portable database manager's explicit runtime configuration. The lifecycle core supplies no default Electron profile and does not locate user data itself. Durable transcript writes and external event listeners continue independently of a GUI window.

Session configuration and transcript notification helpers have portable cores and Electron-default API wrappers. The pure backend enum/provider identity moved out of the SDK adapter factory so a fixture can inject its deterministic adapter without loading real SDK backends. The Electron host retains the actual factory, Codex type predicate, IPC guard, notification behavior, energy blocker and authenticated task-MCP URL builder.

A static TypeScript transpilation/import walk of the lifecycle core reached 59 source modules, with Node builtins and `@paralleldrive/cuid2` as the only external runtime dependencies. It found no Electron import or real SDK factory. The central integration passed full type checking, changed-source lint and 358 existing lifecycle/admission/concurrency/project/session-configuration regressions in 13 files with one worker. These checks establish regression coverage; native host behavior and backend parity remain separate gates.

## Actual standalone lifecycle proof

`scripts/agent-lifecycle-proof.mjs` stages a bounded 75-module graph containing the actual manager and portable database. It forbids Electron, SDK factories, unexpected external dependencies and dynamic module loading in that graph. It requires an explicit standalone Node SQLite package path and reuses only SQLite/CUID dependencies; Verify's Electron-ABI SQLite cannot become a fallback.

After the central native preparation batch, run:

```sh
node scripts/agent-lifecycle-proof.mjs --sqlite-module "$PWD/src-tauri/resources/service/node_modules/better-sqlite3"
```

The fixture creates its own temporary profile/workspace/attachments, configures explicit credential denial and disables every GUI/native/MCP service. It drives public manager APIs with a deterministic adapter: real admission/start, persisted pending approval, rejection of a stale request ID, a matching approval response, durable projection/event delivery without a GUI, database reopening and manager/backend recreation, real resume, matching rejection of a second request, delta reads and stop. There is no direct mutation of private manager state or fabricated database approval response. Dependency diagnostics become counts; failure emits a fixed code and phase, without raw errors or transcript data. Temporary staging/profile files are removed.

The reusable fixture adapter lives in `src/service/fixtures/deterministic-agent-adapter.ts`. Its explicit synthetic-only profile holds a bounded conversation with task/agent identity and unique approval IDs. Missing/stale approval IDs are refused. It supports one persisted conversation and fails on a second create; it never starts a model, shell, browser, tool server or credential API. Persistence represents a deterministic fixture backend, rather than any of the five production providers.

The authorized standalone proof passed against Node 22.23.2 and the actual staged SQLite 13.0.3 addon: all lifecycle/projection/approval checks passed, 18 events were observed and dependency warning/error counts were zero. The first run exposed an incorrect fixture assumption: `createTask` does not assign `agent_id`, so the manager correctly ran triage. The corrected fixture assigns through the public database update API before starting; it does not override manager state or timing.

The fixture exposes a readonly `getPendingApprovalIdentity(sessionId)` snapshot and accepted `decisions()` so the retained backend can verify scope and the actual final outcome without private manager mutation. `removeExternalListener` releases one registration; dispatch takes a snapshot so disposing one consumer cannot skip the next. These are bounded fixture authorization and lifecycle mechanisms, rather than a uniform approval-result contract for all production adapters.

The debug `synthetic-agent` build now wires the real owner into the bundled service and native task slice; [agent desktop boundary](agent-desktop-boundary.md) describes its five scoped commands and exact request identity checks. The [installed Linux proof](evidence/linux-x64-synthetic-agent-installed-gui.json) passed all twenty receipts: reload while an approval is pending, rehydrate the durable projection and live owner status, then approve and wait for completion. Other OS families and real providers still require equivalent evidence.

Shutdown tracks owned starts, polling and idle transitions, bounds the drain, and flushes the final coalesced transcript before database closure. An incomplete drain makes the service retain database/provider/profile ownership until process exit. Persisted-history backfills and raw adapter creation callbacks that outlive their inner startup deadline still need broader ownership work before claiming all-provider shutdown safety.

The existing manager's permission API still accepts an optional request ID and can send a continuation when a provider reports no pending request without an ID; only the fixture desktop boundary requires and confirms the exact request identity. Existing periodic activity heartbeats intentionally target the GUI and bypass external listeners, so the no-GUI fixture proves transition activity metadata but does not establish periodic freshness parity. Neither this fixture nor the host extraction establishes full agent backend parity or production rollout readiness.
