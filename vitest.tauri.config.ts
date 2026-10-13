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
  'test/tauri-runtime.test.ts',
  'src/main/node-worker-runtime.test.ts',
  'src/main/adapters/opencode-adapter.test.ts',
  'src/main/adapters/claude-code-adapter.test.ts',
  'src/main/adapters/codex-app-server-adapter.test.ts',
  'src/main/adapters/acp-adapter.test.ts',
  'src/main/adapters/pi-adapter.test.ts',
  'src/main/adapters/claude-code-history.test.ts',
  'src/main/adapters/permission-mode.test.ts',
  'src/main/agent-installer/installer-network.test.ts',
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
