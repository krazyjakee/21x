import { describe, expect, it, vi } from 'vitest'
import {
  ConnectorOAuthClosedError, ConnectorOAuthError, ConnectorOAuthService, ConnectorOAuthShutdownIncompleteError,
  type ConnectorOAuthServiceOptions
} from './oauth'
import type { ConnectorOAuth2Credentials } from './credentials'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture() {
  const response = deferred<Response>()
  const token: ConnectorOAuth2Credentials = { type: 'oauth2', clientId: 'fixture-client',
    clientSecret: null, accessToken: 'fixture-access', refreshToken: 'fixture-refresh',
    expiresAt: 0, tokenType: 'Bearer', scope: null }
  const credentials = { get: vi.fn(() => token), getStorage: vi.fn(() => 'session'),
    set: vi.fn(), clear: vi.fn(), isPersistentStorageAvailable: vi.fn(() => true) }
  const store = { getInstance: vi.fn(() => ({ pieceName: '@activepieces/piece-todoist', displayName: 'Fixture' })) }
  const fetch = vi.fn(() => response.promise)
  const openExternal = vi.fn()
  const options = { credentials, store, fetch, openExternal, now: () => 1000 } as unknown as ConnectorOAuthServiceOptions
  return { response, token, credentials, store, fetch, options, service: new ConnectorOAuthService(options) }
}

describe('connector OAuth shutdown ownership', () => {
  it('redacts cached access and refresh credentials from a failed renewal message', async () => {
    const f = fixture()
    f.token.clientSecret = 'fixture-client-secret+/123456'
    const result = f.service.get('instance').then((): never => { throw new Error('Expected fixture renewal failure') },
      error => error as ConnectorOAuthError)
    f.response.resolve(new Response(JSON.stringify({ error: 'temporarily_unavailable',
      error_description: [f.token.accessToken, f.token.refreshToken, f.token.clientSecret, encodeURIComponent(f.token.clientSecret)].join(' ') }), { status: 503 }))
    const error = await result
    expect(error).toBeInstanceOf(ConnectorOAuthError)
    expect(error.reason).toBe('refresh_failed')
    for (const value of [f.token.accessToken, f.token.refreshToken!, f.token.clientSecret, encodeURIComponent(f.token.clientSecret)]) {
      expect(error.message).not.toContain(value)
    }
    expect(error.message).toContain('[REDACTED]')
    expect(f.credentials.set).not.toHaveBeenCalled()
    await f.service.close()
  })
  it.each([false, true])('joins raw refresh without late persistence or revoke writes (invalid grant: %s)', async invalid => {
    const f = fixture()
    const work = f.service.get('instance')
    const result = expect(work).rejects.toBeInstanceOf(ConnectorOAuthClosedError)
    expect(f.service.get('instance')).toBe(work)
    expect(f.fetch).toHaveBeenCalledOnce()
    let finished = false
    const close = f.service.close().then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    const reads = f.credentials.get.mock.calls.length
    await expect(f.service.get('instance')).rejects.toBeInstanceOf(ConnectorOAuthClosedError)
    expect(() => f.service.status('instance')).toThrow(ConnectorOAuthClosedError)
    expect(() => f.service.disconnect('instance')).toThrow(ConnectorOAuthClosedError)
    await expect(f.service.connect('instance', { clientId: 'fixture', clientSecret: 'fixture' })).rejects.toBeInstanceOf(ConnectorOAuthClosedError)
    expect(f.credentials.get).toHaveBeenCalledTimes(reads)
    f.response.resolve(new Response(JSON.stringify(invalid ? { error: 'invalid_grant' } : { access_token: 'new-fixture' }),
      { status: invalid ? 400 : 200, headers: { 'content-type': 'application/json' } }))
    await result
    await close
    expect(finished).toBe(true)
    expect(f.credentials.set).not.toHaveBeenCalled()
    expect(f.credentials.getStorage).not.toHaveBeenCalled()
    expect(f.credentials.clear).not.toHaveBeenCalled()
  })

  it('keeps unfinished refresh ownership after a deadline and lets a later close join it', async () => {
    const f = fixture()
    const result = expect(f.service.get('instance')).rejects.toBeInstanceOf(ConnectorOAuthClosedError)
    await expect(f.service.close(5)).rejects.toBeInstanceOf(ConnectorOAuthShutdownIncompleteError)
    let finished = false
    const retry = f.service.close().then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    f.response.resolve(new Response(JSON.stringify({ access_token: 'new-fixture' })))
    await result
    await retry
    expect(f.credentials.set).not.toHaveBeenCalled()
  })

  it('joins an authorization code exchange and refuses its late credential write', async () => {
    const f = fixture()
    const callback = deferred<{ code: string; state: string }>()
    const stop = vi.fn()
    const service = new ConnectorOAuthService({ ...f.options,
      createServer: () => ({ start: async () => 'http://localhost:3000/callback',
        waitForCallback: () => callback.promise, stop }),
      openExternal: url => callback.resolve({ code: 'fixture-code', state: new URL(url).searchParams.get('state')! }) })
    const result = expect(service.connect('instance', { clientId: 'fixture-client', clientSecret: 'fixture-secret' }, 'session'))
      .rejects.toBeInstanceOf(ConnectorOAuthClosedError)
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce())
    let finished = false
    const close = service.close().then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    f.response.resolve(new Response(JSON.stringify({ access_token: 'new-fixture' })))
    await result
    await close
    expect(stop).toHaveBeenCalledTimes(2)
    expect(f.credentials.set).not.toHaveBeenCalled()
  })

  it('rejects an invalid close deadline before shutting down admission', async () => {
    const f = fixture()
    await expect(f.service.close(0)).rejects.toBeInstanceOf(RangeError)
    expect(f.service.status('instance')).toEqual({ state: 'connected', expiresAt: 0 })
    await f.service.close()
    await f.service.close()
  })

  it('cancels a waiting browser callback and joins its flow before close resolves', async () => {
    const f = fixture()
    const callback = deferred<{ code: string; state: string }>()
    const opened = vi.fn()
    const stop = vi.fn(() => callback.reject(new Error('Fixture server stopped')))
    const service = new ConnectorOAuthService({ ...f.options, openExternal: opened,
      createServer: () => ({ start: async () => 'http://localhost:3000/callback',
        waitForCallback: () => callback.promise, stop }) })
    const result = expect(service.connect('instance', { clientId: 'fixture', clientSecret: 'fixture' }, 'session'))
      .rejects.toBeInstanceOf(ConnectorOAuthClosedError)
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce())
    await service.close()
    await result
    expect(stop).toHaveBeenCalledTimes(2)
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.credentials.set).not.toHaveBeenCalled()
  })

  it('owns a late callback server startup without opening the browser after shutdown', async () => {
    const f = fixture()
    const started = deferred<string>()
    const stop = vi.fn()
    const opened = vi.fn()
    const service = new ConnectorOAuthService({ ...f.options, openExternal: opened,
      createServer: () => ({ start: () => started.promise, waitForCallback: vi.fn(), stop }) })
    const result = expect(service.connect('instance', { clientId: 'fixture', clientSecret: 'fixture' }, 'session'))
      .rejects.toBeInstanceOf(ConnectorOAuthClosedError)
    let finished = false
    const close = service.close().then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    started.resolve('http://localhost:3000/callback')
    await result
    await close
    expect(stop).toHaveBeenCalledTimes(2)
    expect(opened).not.toHaveBeenCalled()
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('retains the callback server close acknowledgement after the token exchange completes', async () => {
    const f = fixture()
    const callback = deferred<{ code: string; state: string }>()
    const acknowledged = deferred<void>()
    const closeServer = vi.fn(() => acknowledged.promise)
    const service = new ConnectorOAuthService({ ...f.options,
      createServer: () => ({ start: async () => 'http://localhost:3000/callback',
        waitForCallback: () => callback.promise, stop: vi.fn(), close: closeServer }),
      openExternal: url => callback.resolve({ code: 'fixture-code', state: new URL(url).searchParams.get('state')! }) })
    const result = expect(service.connect('instance', { clientId: 'fixture-client', clientSecret: 'fixture-secret' }, 'session'))
      .rejects.toBeInstanceOf(ConnectorOAuthClosedError)
    f.response.resolve(new Response(JSON.stringify({ access_token: 'new-fixture' })))
    await vi.waitFor(() => expect(closeServer).toHaveBeenCalledOnce())
    let closed = false
    const close = service.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(f.credentials.set).not.toHaveBeenCalled()
    acknowledged.resolve()
    await result
    await close
  })
})
