import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, statSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const race = vi.hoisted(() => ({ beforeOpen: null as (() => void) | null }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => {
    const grow = race.beforeOpen; race.beforeOpen = null; grow?.()
    return fs.openSync(...args)
  } }
})
import { PLUGIN_LIMITS, readPluginTree } from './containment'

let root: string | undefined
afterEach(() => { race.beforeOpen = null; if (root) rmSync(root, { recursive: true, force: true }) })
describe('plugin snapshot byte ownership', () => {
  it('rechecks actual aggregate bytes when files grow after tree inspection', () => {
    root = mkdtempSync(join(tmpdir(), 'plugin-growth-'))
    const files = Array.from({ length: 5 }, (_, i) => join(root!, 'file' + i))
    for (const path of files) writeFileSync(path, '')
    race.beforeOpen = () => { for (const path of files) truncateSync(path, PLUGIN_LIMITS.fileBytes) }
    expect(() => readPluginTree(root!)).toThrow('byte limit')
    // The owner only reads and preserves the growing source, including its files.
    expect(statSync(files[0]).size).toBe(PLUGIN_LIMITS.fileBytes)
  })
})
