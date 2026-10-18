/** Historical shipping adapters only; never imported by the standalone config. */
import { defineConfig } from 'vitest/config'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reviewTestInventory } from './scripts/host-neutral-test-policy.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const files = reviewTestInventory().filter(row => row.framework === 'vitest' && row.cohort === 'historical-electron').map(row => row.file)
if (!process.versions.electron) throw new Error('Historical Electron adapter tests require the explicit Electron launcher')
const aliases = { '@shared': resolve(root, 'src/shared'), '@': resolve(root, 'src/renderer/src') }
export default defineConfig({ root, resolve: { alias: aliases }, test: { maxWorkers: 2, projects: [
  { resolve: { alias: aliases }, test: { name: 'historical-main', environment: 'node', include: files.filter(file => !file.startsWith('src/renderer/')), setupFiles: [resolve(root, 'test/setup-main.ts')] } },
  { resolve: { alias: aliases }, test: { name: 'historical-renderer', environment: 'happy-dom', include: files.filter(file => file.startsWith('src/renderer/')), setupFiles: [resolve(root, 'test/setup-renderer.ts')] } }
] } })
