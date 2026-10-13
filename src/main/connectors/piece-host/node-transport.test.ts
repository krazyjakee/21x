import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createNodeProcessTransport } from './node-transport'
import { pieceWorkerEnvironment } from './worker-environment'
import { PieceHostClient } from './client'

const root = resolve(__dirname, '../../../..')

describe('standalone connector worker transport', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('shares the minimal HTTP environment without inheriting credentials, preloads or Electron mode', () => {
    const source = { PATH: '/fixture', HOME: '/fixture-home', HTTP_PROXY: 'http://fixture-proxy',
      OPENAI_API_KEY: 'fixture-key', NODE_OPTIONS: '--require=fixture', ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1' }
    expect(pieceWorkerEnvironment(source)).toEqual({ PATH: '/fixture', HOME: '/fixture-home', HTTP_PROXY: 'http://fixture-proxy' })
    expect(source.OPENAI_API_KEY).toBe('fixture-key')
  })

  it.skipIf(Boolean(process.versions.electron))('rejects a PATH-based entry before launching a worker', () => {
    expect(() => createNodeProcessTransport('piece-host.cjs')).toThrow('absolute regular file')
  })

  it.skipIf(Boolean(process.versions.electron))('uses owning Node, preserves structured data and joins actual close with system Node hidden', async () => {
    vi.stubEnv('PATH', '')
    vi.stubEnv('NODE_OPTIONS', '--require=/fixture-missing-preload')
    vi.stubEnv('OPENAI_API_KEY', 'fixture-secret')
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    vi.stubEnv('electron_run_as_node', '1')
    const transport = createNodeProcessTransport(join(root, 'test/fixtures/piece-node-worker.cjs'))
    const exits = vi.fn()
    transport.onExit(exits)
    const client = new PieceHostClient({ createTransport: () => transport,
      credentials: { get: () => null }, kv: { get: () => null, put: () => {}, delete: () => {} } })
    try {
      const bytes = Buffer.from([0, 1, 255])
      expect(await client.runAction({ instanceId: 'fixture', pieceName: '@activepieces/piece-trello',
        pieceVersion: '0.6.0', actionName: 'get_board', propsValue: { bytes }, timeoutMs: 2000 }))
        .toEqual({ executable: process.execPath, version: process.version, electron: false,
          systemNodeHidden: true, preloadsAbsent: true, secretsAbsent: true, electronModeAbsent: true, bytes })
      await client.close()
      expect(exits).toHaveBeenCalledOnce()
      const lateExit = vi.fn()
      transport.onExit(lateExit)
      await Promise.resolve()
      expect(lateExit).toHaveBeenCalledOnce()
    } finally { await client.close() }
  })

  it.skipIf(Boolean(process.versions.electron))('runs the real compiled host and pinned Trello disable hook over Node IPC', async () => {
    // Test output stays below ignored node_modules so plain require() resolves
    // the existing pinned pieces. This is not packaged-resource staging proof.
    const cache = join(root, 'node_modules/.cache')
    mkdirSync(cache, { recursive: true })
    const directory = mkdtempSync(join(cache, '21x-node-piece-'))
    let client: PieceHostClient | undefined
    try {
      const { build } = await import('vite')
      await build({ configFile: false, root, logLevel: 'silent',
        build: { ssr: join(root, 'src/main/connectors/piece-host/host-entry.ts'), target: 'node22',
          outDir: directory, emptyOutDir: false, minify: false,
          rollupOptions: { output: { format: 'cjs', entryFileNames: 'piece-host.cjs', inlineDynamicImports: true } } },
        ssr: { noExternal: true } })
      vi.stubEnv('PATH', '')
      client = new PieceHostClient({ createTransport: () => createNodeProcessTransport(join(directory, 'piece-host.cjs')),
        credentials: { get: () => ({ type: 'custom_auth', props: { api_key: 'fixture', token: 'fixture' } }) },
        kv: { get: () => null, put: () => {}, delete: () => {} } })
      await expect(client.runTrigger({ instanceId: 'fixture', pieceName: '@activepieces/piece-trello',
        pieceVersion: '0.6.0', triggerName: 'deadline', hook: 'onDisable', timeoutMs: 2000 })).resolves.toBeNull()
      expect(client.starts).toBe(1)
      await client.close()
    } finally {
      await client?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 15_000)
})
