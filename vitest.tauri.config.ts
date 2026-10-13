import { defineConfig } from 'vitest/config'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const pins = JSON.parse(readFileSync(join(root, 'scripts/tauri-runtime.json'), 'utf8'))
if (process.versions.electron || process.version !== `v${pins.nodeVersion}` || !process.env.TAURI_SQLITE_MODULE) {
  throw new Error('Use scripts/tauri-test.mjs with staged standalone resources')
}
const sqlite = realpathSync(process.env.TAURI_SQLITE_MODULE)
const expected = realpathSync(join(root, 'src-tauri/resources/service/node_modules/better-sqlite3'))
const metadata = JSON.parse(readFileSync(join(sqlite, 'package.json'), 'utf8'))
if (sqlite !== expected || metadata.name !== 'better-sqlite3' || metadata.version !== pins.nativeDependencies['better-sqlite3']) {
  throw new Error('The standalone suite requires the explicitly staged SQLite package')
}
const resolveOptions = { alias: [
  { find: /^better-sqlite3$/, replacement: join(sqlite, 'lib/index.js') },
  { find: /^electron(?:$|\/)/, replacement: join(root, 'test/forbid-electron.ts') },
  { find: '@shared', replacement: join(root, 'src/shared') }
] }
const mainFiles = [
  'test/tauri-runtime.test.ts', 'test/tauri-terminal-native.test.ts',
  'src/main/node-worker-runtime.test.ts',
  'src/main/adapters/opencode-adapter.test.ts',
  'src/main/adapters/claude-code-adapter.test.ts',
  'src/main/adapters/codex-app-server-adapter.test.ts',
  'src/main/adapters/acp-adapter.test.ts',
  'src/main/adapters/pi-adapter.test.ts',
  'src/main/adapters/claude-code-history.test.ts',
  'src/main/adapters/permission-mode.test.ts',
  'src/main/agent-installer/installer-network.test.ts',
  'src/main/agent-installer/installer-process.test.ts',
  'src/main/task-api-server.test.ts', 'src/main/task-api/skill-routes.test.ts',
  'src/main/task-api-lifetime.test.ts',
  'src/main/task-mcp-endpoint.test.ts',
  'src/main/mobile-api-server.test.ts',
  'src/main/mobile-api-lifetime.test.ts',
  'src/main/task-automation-scheduler.test.ts', 'src/main/task-automation-lifetime.test.ts',
  'src/main/captain-waker.test.ts', 'src/main/captain-waker-lifetime.test.ts',
  'src/main/recurrence-scheduler.test.ts', 'src/main/recurrence-scheduler-lifetime.test.ts',
  'src/main/scheduled-coordination.test.ts', 'src/main/scheduled-coordination-lifetime.test.ts',
  'src/main/commander/commander-service.test.ts', 'src/main/commander/captain-delivery.test.ts', 'src/main/commander/commander-lifetime.test.ts',
  'src/main/commander/prompts.test.ts', 'src/main/commander/report-tools.test.ts',
  'src/main/prompts/captain.test.ts', 'src/main/pull-request-merge.test.ts', 'src/main/issue-writes.test.ts',
  'src/main/commander/project-tools.test.ts', 'src/main/commander/skill-tools.test.ts',
  'src/main/commander/action-results.test.ts', 'src/main/commander/commander-store.test.ts',
  'src/main/commander/commander-input-mode.test.ts', 'src/main/ipc/commander-actions.test.ts',
  'src/main/database/commander-actions-migration.test.ts',
  'src/main/commander/commander-accounting.test.ts',
  'src/main/commander/activity-observations.test.ts', 'src/main/commander/commander-managed.test.ts',
  'src/main/sessions/chat-engine.test.ts', 'src/main/sessions/roles/commander.test.ts',
  'src/main/sessions/compaction.test.ts', 'src/main/adapters/adapter-compaction.test.ts',
  'src/main/agent-manager-compaction.test.ts',
  'src/main/sessions/adapter-engine.test.ts', 'src/main/agent-manager-captain-managed.test.ts',
  'src/main/sessions/adapter-engine-accounting.test.ts', 'src/main/agent-manager-task-managed.test.ts',
  'src/main/agent-handoff-token-budget.test.ts', 'src/main/agent-manager-activity-outcomes.test.ts',
  'src/main/captain-waker-managed.test.ts', 'src/main/database/session-handoff-migration.test.ts',
  'src/main/sessions/handoff.test.ts', 'src/main/sessions/memory.test.ts', 'src/main/sessions/compaction-policy.test.ts',
  'src/main/sessions/context-service.test.ts', 'src/main/ipc/session-context.test.ts',
  'src/main/commander/commander-rollover.test.ts',
  'src/main/sessions/captain-rollover.test.ts', 'src/main/agent-manager-captain-rollover.test.ts', 'src/main/task-send-lock.test.ts',
  'src/main/sessions/token-accounting.test.ts', 'src/main/sessions/managed-session.test.ts',
  'src/main/adapters/adapter-usage.test.ts',
  'src/main/voice/commander-voice.test.ts',
  'src/main/chat/chat-runtime.test.ts', 'src/main/chat/chat-runtime-lifetime.test.ts',
  'src/main/claude-plugin-manager.test.ts', 'src/main/claude-plugin-lifetime.test.ts',
  'src/main/claude-plugins/sources.test.ts', 'src/main/claude-plugins/containment.test.ts',
  'src/main/claude-plugins/resources.containment.test.ts',
  'src/main/agent-manager/provider-failure.test.ts', 'src/main/sessions/provider-recovery-store.test.ts',
  'src/main/agent-manager-provider-recovery.test.ts',
  'src/main/agent-manager/mcp-probe-service.test.ts', 'src/main/mcp-client-messages.test.ts',
  'src/main/secret-broker-core.test.ts', 'src/main/secret-shell.test.ts',
  'src/main/terminal-service-core.test.ts', 'src/main/terminal-process.test.ts',
  'src/main/overdue-notifier.test.ts',
  'src/main/workspace-cleanup-scheduler.test.ts', 'src/main/workspace-cleanup-scheduler-lifetime.test.ts',
  'src/main/heartbeat-scheduler.test.ts', 'src/main/heartbeat-scheduler-lifetime.test.ts',
  'src/main/agent-installer/detect.test.ts', 'src/main/agent-installer/install.test.ts',
  'src/main/sync-manager-lifetime.test.ts',
  'src/main/sync-manager.test.ts',
  'src/main/connectors/piece-host/piece-host.test.ts',
  'src/main/connectors/piece-host/node-transport.test.ts',
  'src/main/connectors/piece-host/packaged-resources.test.ts',
  'src/main/connectors/oauth-lifetime.test.ts',
  'src/main/connectors/connector-store.test.ts', 'src/main/connectors/credentials.test.ts',
  'src/main/connectors/ssrf.test.ts', 'src/main/connectors/piece-host/tls-guard.test.ts',
  'src/main/connectors/bridge/scheduler-lifetime.test.ts',
  'src/main/connectors/bridge/engine-lifetime.test.ts',
  'src/main/connectors/bridge/service.test.ts',
  'src/main/connectors/bridge/runtime-lifetime.test.ts',
  'src/main/connectors/bridge/bridge.test.ts', 'src/main/connectors/bridge/trello-poc.test.ts',
  'src/main/connectors/bridge/todoist-oauth.test.ts',
  'src/main/oauth/local-oauth-server.test.ts',
  'src/main/oauth/providers/connector-oauth-provider.test.ts',
  'src/main/database-transcript-page.test.ts', 'src/main/transcript-events.test.ts', 'src/main/transcript-page-authority.test.ts',
  'src/shared/**/*.test.ts',
  'scripts/tauri-inventory.test.ts', 'scripts/tauri-contracts.test.ts',
  'scripts/artifact-frame-proof.test.ts',
  'scripts/activity-process-proof.test.ts',
  'scripts/database-proof.test.ts', 'scripts/configuration-proof.test.ts', 'scripts/agent-desktop-proof.test.ts',
  ...(process.env.TAURI_STANDALONE_SERVICE_PROOFS === '1' ? [
    'scripts/database-service-proof.test.ts', 'scripts/configuration-service-proof.test.ts', 'scripts/transcript-page-proof.test.ts',
    'scripts/connector-worker-service-proof.test.ts'
  ] : [])
]
export default defineConfig({
  root, resolve: resolveOptions,
  test: {
    maxWorkers: 1,
    projects: [
      { resolve: resolveOptions, test: { name: 'portable-main', environment: 'node', include: mainFiles,
        setupFiles: [join(root, 'test/setup-tauri.ts')] } },
      { resolve: resolveOptions, test: { name: 'portable-renderer', environment: 'happy-dom',
        include: ['src/renderer/src/lib/desktop-client.test.ts', 'src/renderer/src/lib/transcript-pagination.test.ts', 'src/renderer/src/lib/tauri-task-slice.test.ts'] } }
    ]
  }
})
