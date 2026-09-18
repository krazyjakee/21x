import { afterEach, describe, expect, it } from 'vitest'
import { LocalOAuthServer } from './local-oauth-server'

describe('LocalOAuthServer', () => {
  let server: LocalOAuthServer

  afterEach(() => server?.stop())

  it('escapes the provider error text on the callback page', async () => {
    server = new LocalOAuthServer()
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
    server = new LocalOAuthServer()
    const redirectUri = await server.start()
    const callback = server.waitForCallback()

    const response = await fetch(`${redirectUri}?code=abc&state=xyz`, { headers: { Connection: 'close' } })

    expect(response.status).toBe(200)
    await expect(callback).resolves.toMatchObject({ code: 'abc', state: 'xyz' })
  })
})
