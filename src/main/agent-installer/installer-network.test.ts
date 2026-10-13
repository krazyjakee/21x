import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { InstallerNetwork } from './installer-network.js'

describe('portable installer network owner', () => {
  let server: Server
  let base: string
  let root: string
  let network: InstallerNetwork
  const payload = Buffer.alloc(256 * 1024, 0x5a)
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), '21x-installer-network-'))
    server = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/file' }).end()
      } else if (request.url === '/file') {
        response.writeHead(200, { 'content-length': payload.length }).end(payload)
      } else if (request.url === '/json') {
        response.writeHead(200).end(JSON.stringify({ fixture: true }))
      } else if (request.url === '/invalid-json') {
        response.writeHead(200).end('invalid JSON')
      } else if (request.url === '/large-json') {
        response.writeHead(200).end('x'.repeat(2 * 1024 * 1024 + 1))
      } else if (request.url === '/slow') {
        response.writeHead(200, { 'content-length': payload.length * 2 })
        response.write(payload.subarray(0, 32))

      } else response.writeHead(503).end()
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable')
    base = `http://127.0.0.1:${address.port}`
    network = new InstallerNetwork(fetch)
  })
  afterEach(async () => {
    await network.close()
    server.closeAllConnections()
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
    await rm(root, { recursive: true, force: true })
  })

  it('uses the injected client for JSON and returns null for HTTP, parse and body-limit failures', async () => {
    expect(await network.fetchJson(`${base}/json`)).toEqual({ fixture: true })
    for (const route of ['/missing', '/invalid-json', '/large-json']) {
      expect(await network.fetchJson(base + route)).toBeNull()
    }
  })

  it('follows relative redirects, streams exact bytes and publishes only a complete file', async () => {
    const destination = join(root, 'installer.bin')
    const progress = vi.fn()
    await network.downloadFile(`${base}/redirect`, destination, progress)
    expect(await readFile(destination)).toEqual(payload)
    expect(await readdir(root)).toEqual(['installer.bin'])
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'installing', percent: 70 }))
  })

  it('preserves an existing destination and removes owned partials after an HTTP failure', async () => {
    const destination = join(root, 'installer.bin')
    await writeFile(destination, 'prior-valid-installer')
    await expect(network.downloadFile(`${base}/missing`, destination, () => {})).rejects.toThrow('Download failed: HTTP 503')
    expect(await readFile(destination, 'utf8')).toBe('prior-valid-installer')
    expect(await readdir(root)).toEqual(['installer.bin'])
  })

  it('cancels a streaming download and joins file cleanup before close resolves', async () => {
    const destination = join(root, 'installer.bin')
    await writeFile(destination, 'prior-valid-installer')
    const progress = vi.fn()
    const result = expect(network.downloadFile(`${base}/slow`, destination, progress)).rejects.toThrow('INSTALLER_DOWNLOAD_CANCELLED')
    await vi.waitFor(() => expect(progress).toHaveBeenCalled())
    await network.close()
    await result
    expect(await readFile(destination, 'utf8')).toBe('prior-valid-installer')
    expect(await readdir(root)).toEqual(['installer.bin'])
    await expect(network.downloadFile(`${base}/file`, destination, progress)).rejects.toThrow('INSTALLER_NETWORK_CLOSED')
    expect(await network.fetchJson(`${base}/json`)).toBeNull()
  })

  it('aborts a pending JSON stream and joins the reader close', async () => {
    let received!: () => void
    const started = new Promise<void>(done => { received = done })
    const owner = new InstallerNetwork(async (...args: Parameters<typeof fetch>) => {
      const response = await fetch(...args)
      received()
      return response
    })
    const result = owner.fetchJson(`${base}/slow`)
    await started
    await owner.close()
    expect(await result).toBeNull()
  })

  it('retains a fetch that ignores cancellation after a failed deadline and joins its later result', async () => {
    let finish!: (response: Response) => void
    const client = vi.fn(() => new Promise<Response>(done => { finish = done }))
    const owner = new InstallerNetwork(client)
    const destination = join(root, 'installer.bin')
    const result = expect(owner.downloadFile('https://fixture.invalid', destination, () => {})).rejects.toThrow('INSTALLER_DOWNLOAD_CANCELLED')
    try {
      await expect(owner.close(5)).rejects.toThrow('INSTALLER_NETWORK_SHUTDOWN_INCOMPLETE')
      let closed = false
      const retry = owner.close().then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
      finish(new Response('late fixture'))
      await result
      await retry
      expect(await readdir(root)).toEqual([])
      expect(client).toHaveBeenCalledOnce()
    } finally {
      finish(new Response('cleanup fixture'))
      await result
      await owner.close()
    }
  })

  it('redacts filesystem and callback failures while cleaning partial writes', async () => {
    await expect(network.downloadFile(`${base}/file`, join(root, 'private-path', 'installer'), () => {})).rejects.toThrow(/^INSTALLER_DOWNLOAD_FAILED$/)
    const destination = join(root, 'installer.bin')
    await expect(network.downloadFile(`${base}/file`, destination, () => { throw new Error('fixture-secret') })).rejects.toThrow(/^INSTALLER_DOWNLOAD_FAILED$/)
    expect(await readdir(root)).toEqual([])
  })

  it('retains a cancelled body and its partial file until the actual reader cancellation acknowledgement', async () => {
    let acknowledge!: () => void
    const cancelled = vi.fn(() => new Promise<void>(done => { acknowledge = done }))
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])) },
      cancel: cancelled
    })
    const owner = new InstallerNetwork(async () => new Response(body, { headers: { 'content-length': '100' } }))
    const progress = vi.fn()
    const result = expect(owner.downloadFile('https://fixture.invalid', join(root, 'installer.bin'), progress)).rejects.toThrow('INSTALLER_DOWNLOAD_CANCELLED')
    try {
      await vi.waitFor(() => expect(progress).toHaveBeenCalled())
      await expect(owner.close(5)).rejects.toThrow('INSTALLER_NETWORK_SHUTDOWN_INCOMPLETE')
      expect(cancelled).toHaveBeenCalledOnce()
      let closed = false
      const retry = owner.close().then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
      acknowledge()
      await result
      await retry
      expect(await readdir(root)).toEqual([])
    } finally {
      acknowledge?.()
      await result
      await owner.close()
    }
  })

  it('rejects an invalid close deadline without stopping valid requests', async () => {
    await expect(network.close(0)).rejects.toBeInstanceOf(RangeError)
    expect(await network.fetchJson(`${base}/json`)).toEqual({ fixture: true })
  })

  it('refuses an oversized declared installer and cancels its body before writing a file', async () => {
    const cancelled = vi.fn()
    const body = new ReadableStream({ cancel: cancelled })
    const owner = new InstallerNetwork(async () => new Response(body, { headers: { 'content-length': String(1024 ** 3 + 1) } }))
    try {
      await expect(owner.downloadFile('https://fixture.invalid', join(root, 'installer.bin'), () => {})).rejects.toThrow('INSTALLER_DOWNLOAD_FAILED')
      expect(cancelled).toHaveBeenCalledOnce()
      expect(await readdir(root)).toEqual([])
    } finally { await owner.close() }
  })
})
