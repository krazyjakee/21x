import { afterEach, describe, expect, it, vi } from 'vitest'
import https from 'https'
import { clearTlsOverride, installTlsGuard } from './tls-guard'

const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED
afterEach(() => {
  if (saved === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved
})

describe('piece host TLS guard', () => {
  it('clears a "0" override before the underlying fetch runs, the way pieces-common sets it', async () => {
    const seen: Array<string | undefined> = []
    const target = { fetch: vi.fn(async () => { seen.push(process.env.NODE_TLS_REJECT_UNAUTHORIZED); return new Response('ok') }) as unknown as typeof globalThis.fetch }
    installTlsGuard(target)

    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' // what sendRequest() does
    await target.fetch('https://api.example.test/')

    expect(seen).toEqual([undefined])
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
  })

  it('leaves any other value alone and pins https.globalAgent to verify peers', () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1'
    clearTlsOverride()
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('1')
    installTlsGuard({ fetch: (async () => new Response('')) as unknown as typeof globalThis.fetch })
    expect(https.globalAgent.options.rejectUnauthorized).toBe(true)
  })
})
