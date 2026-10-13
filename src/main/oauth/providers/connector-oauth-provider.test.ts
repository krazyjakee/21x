import { describe, expect, it, vi } from 'vitest'
import { ConnectorOAuthProvider, OAuthTokenRequestError } from './connector-oauth-provider'

const code = 'fixture-code-123456'
const verifier = 'fixture-verifier-123456'
const secret = 'fixture-secret+/=% 123456'
const refresh = 'fixture-refresh-123456'
const spec = { id: 'fixture', authUrl: 'https://fixture.invalid/auth', tokenUrl: 'https://fixture.invalid/token',
  scopes: [], pkce: true }

describe('connector token endpoint error redaction', () => {
  it('removes authorization code, verifier and client secret from reflected endpoint descriptions', async () => {
    const endpoint = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant',
      error_description: [code, verifier, secret, encodeURIComponent(secret), new URLSearchParams({ value: secret }).toString()].join(' ') }), { status: 400 }))
    const provider = new ConnectorOAuthProvider(spec, endpoint)
    const error = await provider.exchangeCode(code, verifier, { client_id: 'fixture-client', client_secret: secret }, 'http://localhost/callback')
      .then((): never => { throw new Error('Expected fixture token failure') }, error => error as OAuthTokenRequestError)
    expect(error).toBeInstanceOf(OAuthTokenRequestError)
    expect(error.isInvalidGrant).toBe(true)
    expect(error.message).toContain('[REDACTED]')
    for (const value of [code, verifier, secret, encodeURIComponent(secret), new URLSearchParams({ value: secret }).toString().slice(6)]) {
      expect(error.message).not.toContain(value)
    }
    expect(endpoint).toHaveBeenCalledOnce()
  })

  it('redacts refresh credentials from both an unknown error code and its description', async () => {
    const provider = new ConnectorOAuthProvider(spec, async () => new Response(JSON.stringify({ error: refresh, error_description: secret }), { status: 500 }))
    const error = await provider.refreshToken(refresh, 'fixture-client', secret).then((): never => { throw new Error('Expected fixture token failure') }, error => error as OAuthTokenRequestError)
    expect(error.oauthError).toBe('[REDACTED]')
    expect(error.message).not.toContain(refresh)
    expect(error.message).not.toContain(secret)
    expect(error.isInvalidGrant).toBe(false)
  })

  it('redacts a long reflected secret before truncating a non-JSON response', async () => {
    const longSecret = 'fixture-long-' + 'x'.repeat(300)
    const provider = new ConnectorOAuthProvider(spec, async () => new Response(longSecret, { status: 503, headers: { 'content-type': 'text/plain' } }))
    const error = await provider.refreshToken(refresh, 'fixture-client', longSecret).then((): never => { throw new Error('Expected fixture token failure') }, error => error as OAuthTokenRequestError)
    expect(error.message).not.toContain('fixture-long-')
    expect(error.message).toContain('[REDACTED]')
  })

  it('redacts unknown errors in nominally successful responses missing an access token', async () => {
    const provider = new ConnectorOAuthProvider(spec, async () => new Response(JSON.stringify({ error: secret })))
    const error = await provider.refreshToken(refresh, 'fixture-client', secret).then((): never => { throw new Error('Expected fixture token failure') }, error => error as OAuthTokenRequestError)
    expect(error.oauthError).toBe('[REDACTED]')
    expect(error.message).not.toContain(secret)
  })
})
