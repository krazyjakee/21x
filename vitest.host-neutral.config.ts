import { defineConfig } from 'vitest/config'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertHostNeutralRuntime } from './scripts/host-neutral-runtime.mjs'
import { HOST_NEUTRAL_PROOF_FILES, reviewTestInventory } from './scripts/host-neutral-test-policy.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const resources = assertHostNeutralRuntime(root)
const rows = reviewTestInventory(root)
const selected = rows.filter(row => row.framework === 'vitest' && row.cohort === 'host-neutral').map(row => row.file)
const optIn: Record<string, string> = HOST_NEUTRAL_PROOF_FILES
const include = selected.filter(file => !optIn[file] || process.env[optIn[file]] === '1')
const resolveOptions = { alias: [
  { find: /^better-sqlite3$/, replacement: join(resources.sqlite, 'lib/index.js') },
  { find: /^better-sqlite3\//, replacement: resources.sqlite + '/' },
  { find: /^node-pty$/, replacement: join(resources.pty, 'lib/index.js') },
  { find: /^node-pty\//, replacement: resources.pty + '/' },
  { find: /^(?:electron(?:$|[-/])|@electron(?:$|[-/]))/, replacement: join(root, 'test/forbid-electron.ts') },
  { find: '@shared', replacement: join(root, 'src/shared') },
  { find: '@', replacement: join(root, 'src/renderer/src') }
] }
const guard = join(root, 'test/setup-host-neutral-runtime.ts')
const group = (prefix: string) => include.filter(file => file.startsWith(prefix))
export default defineConfig({
  root, resolve: resolveOptions,
  test: { maxWorkers: 2, projects: [
    { resolve: resolveOptions, test: { name: 'main', environment: 'node', include: [...group('src/main/'), ...group('src/service/'), ...group('scripts/'), ...group('test/')], setupFiles: [guard, join(root, 'test/setup-tauri.ts')] } },
    { resolve: resolveOptions, test: { name: 'shared', environment: 'node', include: group('src/shared/'), setupFiles: [guard] } },
    { resolve: resolveOptions, esbuild: { jsx: 'automatic' }, test: { name: 'renderer', environment: 'happy-dom', include: group('src/renderer/'), setupFiles: [guard, join(root, 'test/setup-renderer.ts')] } },
    { resolve: resolveOptions, esbuild: { jsx: 'automatic' }, test: { name: 'mobile', environment: 'happy-dom', include: group('src/mobile/'), setupFiles: [guard, join(root, 'test/setup-mobile.ts')] } }
  ] }
})
