# Portable database foundation

`src/main/database/manager.ts` now owns the existing `DatabaseManager` implementation. `src/main/database.ts` is the shipping Electron compatibility adapter and preserves its zero-argument constructor and public type exports. This extraction prepares T05/T08; it does not connect the experimental service to a production profile, authorize credential conversion, or accept G1.

The portable constructor requires resolved absolute `profileRoot`, `workspaceRoot`, and `attachmentRoot` paths plus explicit managed task MCP runtime data (`command`, `args`, `environment`, and actual `tools` metadata). Its graph imports neither Electron nor the host-specific MCP tool registry. The trusted bootstrap supplies the packaged standalone Node executable, MCP entry point, and tool list. Only the compatibility adapter explicitly allows its historical macOS/Windows `node` lookup and Electron environment. No portable fallback discovers a runtime or profile. Paths are shape checked, not a profile lock, realpath containment proof, or file-access authorization; those remain bootstrap/operation responsibilities.

The database continues to use `21x.db`, schema 32, WAL, foreign keys, five-second busy timeout, the same statement cache, CRUD methods, transcript transactions/revisions, project/Captain seeds, and settings/credential serializers. Default-agent and Captain seeding live in `seed-core.ts`; `seed.ts` retains Electron runtime/tool choices and its existing compatibility exports. The provider registered through `configureSecretStorage` must already be ready. The existing settings masking and serializer behavior is unchanged, including the historical `safeStorage:v1:` TEXT prefix; this prefix does not prove the new provider can read legacy ciphertext. Portable diagnostics default to stderr; the compatibility wrapper retains its existing console behavior. Initialization failures close the opened SQLite connection.

Legacy managed task MCP ownership is ambiguous: Electron identifies the row by `name = 'task-management'`, while both app-created and user-created rows use `source = 'user'`. Portable seeding therefore rejects an existing name match by default with `AMBIGUOUS_MANAGED_MCP_SERVER`. A trusted migration/bootstrap can supply `{ policy: 'verified-id', id }` after verifying ownership out of band. A single matching row with that exact ID may then be refreshed; duplicate names or a missing/wrong ID are rejected. The shipping adapter explicitly retains its historical name-based refresh policy. No source field is silently rewritten and no new marker asserts ownership. Existing-profile ownership verification and durable recording of that decision remain cutover requirements.

## Standalone proof

After `tauri:prepare:native`, run `node scripts/database-proof.mjs --sqlite-module /absolute/repo/src-tauri/resources/service/node_modules/better-sqlite3`. `TAURI_SQLITE_MODULE` can supply that explicit package path instead. The runner never defaults to the root SQLite addon: Verify rebuilds it for Electron, which has a different ABI. The selected package must match the standalone Node executable. The proof rejects Electron runtimes. The native workflow owns execution after preparation; this script does not install or rebuild dependencies.

The Vitest wrapper is `scripts/database-proof.test.ts` and skips the actual native proof unless `TAURI_SQLITE_MODULE` is set. It defaults to `node` on PATH, independently of the Electron test runner; `TAURI_NODE_RUNTIME` selects a specific standalone executable. A skipped test does not constitute a passing Node proof.

The runner transpiles only the portable dependency graph into a temporary directory, links the root pure JavaScript `cuid2` package and the explicitly selected standalone SQLite package separately, and rejects unexpected packages, Electron imports, or dynamic runtime imports. There is no whole-tree link or implicit SQLite ABI fallback. It creates a synthetic profile and separate workspace/attachment roots, initializes the real production schema, then checks:

- task create/read and project/Captain/default-agent seeds;
- durable transcript snapshot, update delta, duplicate suppression, task isolation, revision continuity, and close/reopen;
- SQLite WAL/foreign-key/busy-timeout settings;
- explicit filesystem roots and attachment removal scoped to the selected synthetic task;
- settings roundtrip with an injected authenticated provider and a synthetic in-memory key, including BOM/Unicode preservation;
- managed MCP metadata injection, immutable option snapshots, idempotent reopen with verified ownership, rejection of unverified/wrong-ID refreshes, and connection release after startup rejection.

The synthetic key is neither exported nor persisted and is disposed at the end. No MCP executable is launched. The test does not access a real OS credential store or establish legacy import compatibility. Temporary profiles and staged modules are removed after all database connections close.

## Remaining vertical-slice work

The service still needs trusted bootstrap/profile locking, a proven credential provider/import path, verified MCP ownership metadata, the real managed tool registry with retired browser tools excluded, and scoped validated operation bindings. Agent manager, schedulers, workers, HTTP/mobile APIs, native callbacks, attachment serving, and renderer hydration are not connected by this extraction. Real service events must preserve transcript snapshot/delta recovery and pass through the bounded protocol. Full Electron database regression tests, the standalone proof, Node type checking, packaged database execution, and target-platform profile rehearsals remain batch/release checks.
