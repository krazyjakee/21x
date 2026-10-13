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
  'src/main/database-transcript-page.test.ts', 'src/main/transcript-events.test.ts', 'src/main/transcript-page-authority.test.ts',
  'src/shared/**/*.test.ts',
  'scripts/tauri-inventory.test.ts', 'scripts/tauri-contracts.test.ts',
  'scripts/database-proof.test.ts', 'scripts/configuration-proof.test.ts', 'scripts/agent-desktop-proof.test.ts',
  ...(process.env.TAURI_STANDALONE_SERVICE_PROOFS === '1' ? [
    'scripts/database-service-proof.test.ts', 'scripts/configuration-service-proof.test.ts', 'scripts/transcript-page-proof.test.ts'
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
