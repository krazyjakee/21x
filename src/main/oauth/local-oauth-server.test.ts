import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalOAuthServer } from './local-oauth-server'
import { createServer } from 'node:http'

describe('LocalOAuthServer', () => {
  let server: LocalOAuthServer

  afterEach(async () => { await server?.close() })

  it('escapes the provider error text on the callback page', async () => {
    server = new LocalOAuthServer({ ports: [0] })
    const redirectUri = await server.start()
    const callback = server.waitForCallback()
    callback.catch(() => {})

    const url = new URL(redirectUri)
    url.searchParams.set('error', '<script>alert(1)</script>')
    url.searchParams.set('error_description', '"><img src=x onerror=alert(2)>')
    const response = await fetch(url, { headers: { Connection: 'close' } })
    const html = await response.text()

    expect(html).not.toContain('<script>alert(1)')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    await expect(callback).rejects.toThrow('OAuth error: <script>alert(1)</script>')
  })

  it('resolves with the code and state from a successful callback', async () => {
    server = new LocalOAuthServer({ ports: [0] })
    const redirectUri = await server.start()
    const callback = server.waitForCallback()

    const response = await fetch(`${redirectUri}?code=abc&state=xyz`, { headers: { Connection: 'close' } })

    expect(response.status).toBe(200)
    await expect(callback).resolves.toMatchObject({ code: 'abc', state: 'xyz' })
  })

  it('rejects a pending callback and clears its deadline when stopped', async () => {
    server = new LocalOAuthServer({ ports: [0] })
    await server.start()
    vi.useFakeTimers()
    try {
      const callback = server.waitForCallback()
      const result = expect(callback).rejects.toThrow('OAuth callback server stopped')
      expect(vi.getTimerCount()).toBe(1)
      server.stop()
      await result
      expect(vi.getTimerCount()).toBe(0)
      server.stop()
    } finally { vi.useRealTimers() }
  })

  it('joins a cancelled localhost startup without trying another port or leaving a listener', async () => {
    server = new LocalOAuthServer({ ports: [0] })
    const started = server.start()
    const result = expect(started).rejects.toThrow('OAuth callback server stopped during startup')
    server.stop()
    await result
    await server.close()
    // The same instance can bind normally after the cancelled start has joined.
    const redirectUri = await server.start()
    expect(Number(new URL(redirectUri).port)).toBeGreaterThan(0)
  })

  it('joins actual close before rebinding the callback port', async () => {
    const probe = createServer()
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, 'localhost', resolve) })
    const address = probe.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    await new Promise<void>(resolve => probe.close(() => resolve()))
    server = new LocalOAuthServer({ ports: [address.port] })
    const first = await server.start()
    await server.close()
    const second = await server.start()
    expect(second).toBe(first)
  })

  it('joins failed bind attempts as well as the successful callback listener', async () => {
    const occupied = createServer()
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, 'localhost', resolve)
    })
    try {
      const address = occupied.address(); if (!address || typeof address === 'string') throw new Error('Missing occupied fixture port')
      server = new LocalOAuthServer({ ports: [address.port, 0] })
      const redirect = await server.start()
      expect(Number(new URL(redirect).port)).toBeGreaterThan(0)
      expect(Number(new URL(redirect).port)).not.toBe(address.port)
      await server.close()
      const restarted = await server.start()
      expect(Number(new URL(restarted).port)).toBeGreaterThan(0)
      expect(Number(new URL(restarted).port)).not.toBe(address.port)
      await server.close()
    } finally { await new Promise<void>(resolve => occupied.close(() => resolve())) }
  })
})
