import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const host = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }))
vi.mock('electron', () => ({ net: { fetch: host.fetch } }))

import { downloadFile, fetchJson } from './installer-utils.js'

describe('legacy installer network adapter', () => {
  const roots: string[] = []
  afterEach(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true })
    roots.length = 0
    host.fetch.mockReset()
  })

  it('preserves host fetch and headers for JSON and null fallback', async () => {
    host.fetch.mockResolvedValueOnce(new Response('{"fixture":true}'))
    expect(await fetchJson('https://fixture.invalid', { 'user-agent': 'fixture' })).toEqual({ fixture: true })
    expect(host.fetch).toHaveBeenCalledWith('https://fixture.invalid', expect.objectContaining({ headers: { 'user-agent': 'fixture' } }))
    host.fetch.mockRejectedValueOnce(new Error('fixture private URL'))
    expect(await fetchJson('https://fixture.invalid')).toBeNull()
  })

  it('streams using the selected host fetch and waits for complete destination publication', async () => {
    const root = await mkdtemp(join(tmpdir(), '21x-legacy-installer-'))
    roots.push(root)
    host.fetch.mockResolvedValueOnce(new Response('fixture installer', { headers: { 'content-length': '17' } }))
    const progress = vi.fn()
    await downloadFile('https://fixture.invalid', join(root, 'installer.bin'), progress)
    expect(await readFile(join(root, 'installer.bin'), 'utf8')).toBe('fixture installer')
    expect(await readdir(root)).toEqual(['installer.bin'])
    expect(progress).toHaveBeenCalled()
    expect(host.fetch).toHaveBeenCalledOnce()
  })
})
