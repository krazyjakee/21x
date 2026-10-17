import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { OAuthFlowOwner, type OAuthFlowLease } from './oauth-flow-owner'
import { isNativeOAuthCallback, isNativeOAuthRegistration, OAUTH_NATIVE_CALLBACK_SCHEMAS, type NativeOAuthBridge, type NativeOAuthRegistration } from '../shared/oauth-native-callbacks'

const nonce = 'private_nonce_0123456789'
const redirectUri = 'twentyonex://oauth/callback'
const input = (kind: 'custom-scheme' | 'loopback' = 'custom-scheme') => {
  const uri = kind === 'loopback' ? 'http://localhost:3000/callback' : redirectUri
  return { kind, redirectUri: uri, authorizationUrl: `https://provider.example/authorize?state=${nonce}&redirect_uri=${encodeURIComponent(uri)}`, ttlMs: 300000 }
}
function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no }), resolve: value => resolve(value), reject: error => reject(error) }
}
function setup() {
  let registered!: NativeOAuthRegistration
  const native: NativeOAuthBridge = {
    register: vi.fn(async request => { registered = request; return { flowId: request.flowId, registered: true as const } }),
    open: vi.fn(async ({ flowId }) => ({ flowId, opened: true as const })),
    retire: vi.fn(async ({ flowId }) => ({ flowId, retired: true as const }))
  }
  const scope = vi.fn(), binding = vi.fn()
  let now = 0
  const owner = new OAuthFlowOwner(native, scope, () => now)
  const callback = (flowId: string, extra = {}) => ({ flowId, kind: 'custom-scheme', redirectUri, state: nonce, outcome: { status: 'code', code: 'synthetic-code' }, ...extra })
  return { native, scope, binding, owner, callback, registration: () => registered, setNow: (value: number) => { now = value } }
}
describe('private OAuth flow owner', () => {
  it('publishes cleanup ownership synchronously but refuses opening before a validated registration', async () => {
    const s = setup(), register = deferred<{ flowId: string; registered: true }>()
    vi.mocked(s.native.register).mockReturnValue(register.promise)
    let observed!: OAuthFlowLease
    const pending = s.owner.register(input(), s.binding, lease => { observed = lease })
    expect(Object.isFrozen(observed)).toBe(true)
    await expect(observed.open()).rejects.toThrow('OAUTH_FLOW_UNAVAILABLE')
    expect(s.native.open).not.toHaveBeenCalled()
    register.resolve({ flowId: observed.flowId, registered: true })
    expect(await pending).toBe(observed)
    await observed.open()
    expect(s.native.open).toHaveBeenCalledExactlyOnceWith({ flowId: observed.flowId })
    await observed.close(); await s.owner.close()
  })

  it('retains failed post-ack registration cleanup without opening or retiring an unrelated flow', async () => {
    const s = setup(), unrelatedState = 'unrelated_nonce_0123456789'
    const unrelated = await s.owner.register({ ...input(), authorizationUrl: input().authorizationUrl.replace(nonce, unrelatedState) }, () => {})
    const register = deferred<{ flowId: string; registered: true }>()
    vi.mocked(s.native.register).mockReturnValueOnce(register.promise)
    let observed!: OAuthFlowLease, refuse = true
    vi.mocked(s.native.retire).mockImplementation(async ({ flowId }) => {
      if (flowId === observed.flowId && refuse) throw new Error('native close blocked')
      return { flowId, retired: true }
    })
    const pending = s.owner.register(input(), s.binding, lease => { observed = lease })
    const failed = expect(pending).rejects.toThrow('native close blocked')
    await Promise.resolve()
    s.binding.mockImplementation(() => { throw new Error('binding changed') })
    register.resolve({ flowId: observed.flowId, registered: true }); await failed
    s.binding.mockImplementation(() => {})
    await expect(observed.open()).rejects.toThrow('OAUTH_FLOW_UNAVAILABLE')
    await expect(observed.close()).rejects.toThrow('native close blocked')
    expect(s.native.open).not.toHaveBeenCalled()
    refuse = false; await observed.close()
    expect(s.native.retire).not.toHaveBeenCalledWith({ flowId: unrelated.flowId })
    await unrelated.open()
    expect(s.owner.deliver(s.callback(unrelated.flowId, { state: unrelatedState }))).toEqual({ accepted: true })
    await expect(unrelated.waitForCallback()).resolves.toEqual({ code: 'synthetic-code', state: unrelatedState })
    await unrelated.close(); await s.owner.close()
  })

  it('joins cleanup when the synchronous ownership observer throws', async () => {
    const s = setup(), retire = deferred<{ flowId: string; retired: true }>()
    vi.mocked(s.native.retire).mockReturnValue(retire.promise)
    let observed!: OAuthFlowLease
    const observer = vi.fn((lease: OAuthFlowLease) => { observed = lease; throw new Error('observer refused') })
    const failed = expect(s.owner.register(input(), s.binding, observer)).rejects.toThrow('observer refused')
    await vi.waitFor(() => expect(s.native.retire).toHaveBeenCalledOnce())
    expect(observer).toHaveBeenCalledOnce(); expect(s.native.register).not.toHaveBeenCalled()
    expect(s.native.open).not.toHaveBeenCalled()
    await expect(s.owner.close(5)).rejects.toThrow('OAUTH_FLOW_DRAIN_BLOCKED')
    retire.resolve({ flowId: observed.flowId, retired: true }); await failed
    await s.owner.close()
    expect(s.native.retire).toHaveBeenCalledOnce()
  })

  it('captures a private UUID registration before one-shot browser opening', async () => {
    const s = setup(), lease = await s.owner.register(input(), s.binding)
    expect(s.native.open).not.toHaveBeenCalled()
    expect(s.registration().stateSha256).toBe(createHash('sha256').update(nonce).digest('hex'))
    expect(isNativeOAuthRegistration(s.registration())).toBe(true)
    await lease.open()
    await expect(lease.open()).rejects.toThrow('OAUTH_FLOW_UNAVAILABLE')
    expect(s.native.open).toHaveBeenCalledExactlyOnceWith({ flowId: lease.flowId })
    await lease.close(); await s.owner.close()
  })
  it('claims atomically before async exchange and never routes by callback-selected provider/source', async () => {
    const s = setup(), lease = await s.owner.register(input(), s.binding)
    await lease.open()
    const exchange = deferred(), exchangeStarted = vi.fn()
    const flow = lease.waitForCallback().then(async result => { exchangeStarted(result.code); await exchange.promise })
    expect(s.owner.deliver(s.callback(lease.flowId, { sourceId: 'foreign' }))).toEqual({ accepted: false })
    expect(s.owner.deliver(s.callback(lease.flowId))).toEqual({ accepted: true })
    expect(exchangeStarted).not.toHaveBeenCalled()
    expect(s.owner.deliver(s.callback(lease.flowId))).toEqual({ accepted: false })
    await Promise.resolve()
    expect(exchangeStarted).toHaveBeenCalledExactlyOnceWith('synthetic-code')
    expect(s.native.retire).not.toHaveBeenCalled() // no delivery/retirement join cycle
    exchange.resolve(); await flow; await lease.close(); await s.owner.close()
  })
  it.each(['denied', 'failed'] as const)('claims sanitized %s without redemption or waiting for TTL', async status => {
    const s = setup(), lease = await s.owner.register(input(), s.binding)
    await lease.open()
    const waiter = lease.waitForCallback()
    expect(s.owner.deliver(s.callback(lease.flowId, { outcome: { status } }))).toEqual({ accepted: true })
    await expect(waiter).rejects.toThrow(status === 'denied' ? 'OAUTH_FLOW_DENIED' : 'OAUTH_FLOW_FAILED')
    expect(s.owner.deliver(s.callback(lease.flowId))).toEqual({ accepted: false })
    await lease.close(); await s.owner.close()
  })
  it('rejects early, foreign, wrong-kind, wrong-redirect, expired, cancelled and old-owner deliveries', async () => {
    const s = setup(), lease = await s.owner.register(input(), s.binding)
    expect(s.owner.deliver(s.callback(lease.flowId))).toEqual({ accepted: false })
    await lease.open()
    for (const extra of [{ state: 'foreign_nonce_0123456789' }, { redirectUri: 'nuanu://oauth/callback' }, { kind: 'loopback' }]) expect(s.owner.deliver(s.callback(lease.flowId, extra))).toEqual({ accepted: false })
    s.setNow(300000)
    expect(s.owner.deliver(s.callback(lease.flowId))).toEqual({ accepted: false })
    await lease.close()
    expect(s.owner.deliver(s.callback(lease.flowId))).toEqual({ accepted: false })
    const replacement = setup()
    expect(replacement.owner.deliver(s.callback(lease.flowId))).toEqual({ accepted: false })
    await s.owner.close(); await replacement.owner.close()
  })
  it('rechecks captured provider/source/epoch/intent fences at launch and claim', async () => {
    const s = setup(), lease = await s.owner.register(input(), s.binding)
    s.binding.mockImplementation(() => { throw new Error('binding changed') })
    await expect(lease.open()).rejects.toThrow('binding changed')
    expect(s.native.open).not.toHaveBeenCalled()
    s.binding.mockImplementation(() => {})
    await lease.open()
    s.scope.mockImplementation(() => { throw new Error('epoch retired') })
    expect(s.owner.deliver(s.callback(lease.flowId))).toEqual({ accepted: false })
    await lease.close(); await s.owner.close()
  })
  it('retains loopback separation and the exact provider redirect', async () => {
    const s = setup(), lease = await s.owner.register(input('loopback'), s.binding)
    await lease.open()
    expect(s.registration().redirectUri).toBe('http://localhost:3000/callback')
    await expect(lease.waitForCallback()).rejects.toThrow('OAUTH_FLOW_UNAVAILABLE')
    expect(s.owner.deliver(s.callback(lease.flowId))).toEqual({ accepted: false })
    await lease.close(); await s.owner.close()
  })
  it('fences admission immediately but joins a late registration before retiring', async () => {
    const s = setup(), register = deferred<{ flowId: string; registered: true }>()
    vi.mocked(s.native.register).mockImplementation(() => register.promise)
    const pending = s.owner.register(input(), s.binding)
    await Promise.resolve()
    s.owner.stop()
    await expect(s.owner.register(input(), s.binding)).rejects.toThrow('OAUTH_FLOW_UNAVAILABLE')
    await expect(s.owner.close(5)).rejects.toThrow('OAUTH_FLOW_DRAIN_BLOCKED')
    expect(s.native.retire).not.toHaveBeenCalled()
    const request = vi.mocked(s.native.register).mock.calls[0][0]
    register.resolve({ flowId: request.flowId, registered: true })
    await expect(pending).rejects.toThrow('OAUTH_FLOW_UNAVAILABLE')
    await s.owner.close()
    expect(s.native.retire).toHaveBeenCalledExactlyOnceWith({ flowId: request.flowId })
  })
  it('retains raw browser opening across close deadlines, then permits explicit close retry', async () => {
    const s = setup(), lease = await s.owner.register(input(), s.binding), opening = deferred<{ flowId: string; opened: true }>()
    vi.mocked(s.native.open).mockReturnValue(opening.promise)
    const pending = lease.open()
    await Promise.resolve()
    await expect(s.owner.close(5)).rejects.toThrow('OAUTH_FLOW_DRAIN_BLOCKED')
    expect(s.native.retire).not.toHaveBeenCalled()
    opening.resolve({ flowId: lease.flowId, opened: true })
    await expect(pending).rejects.toThrow('OAUTH_FLOW_UNAVAILABLE')
    await s.owner.close()
    expect(s.native.retire).toHaveBeenCalledExactlyOnceWith({ flowId: lease.flowId })
  })
  it('retains failed native retirement for explicit retry', async () => {
    const s = setup(), lease = await s.owner.register(input(), s.binding)
    vi.mocked(s.native.retire).mockRejectedValueOnce(new Error('native close blocked'))
    await expect(lease.close()).rejects.toThrow('native close blocked')
    await s.owner.close()
    expect(s.native.retire).toHaveBeenCalledTimes(2)
  })
  it('rejects a foreign registration receipt and still obtains native retirement acknowledgement', async () => {
    const s = setup()
    vi.mocked(s.native.register).mockResolvedValueOnce({ flowId: 'bdf2af85-5898-414c-a64c-27c38ce72eb2', registered: true })
    await expect(s.owner.register(input(), s.binding)).rejects.toThrow('OAUTH_FLOW_UNAVAILABLE')
    expect(s.native.retire).toHaveBeenCalledTimes(1)
    await s.owner.close()
  })
  it('retains a foreign retirement receipt as incomplete ownership for explicit retry', async () => {
    const s = setup(), lease = await s.owner.register(input(), s.binding)
    vi.mocked(s.native.retire).mockResolvedValueOnce({ flowId: 'bdf2af85-5898-414c-a64c-27c38ce72eb2', retired: true })
    await expect(lease.close()).rejects.toThrow('OAUTH_FLOW_UNAVAILABLE')
    await s.owner.close()
    expect(s.native.retire).toHaveBeenCalledTimes(2)
  })
})
describe('private OAuth wire bounds', () => {
  it('denies arbitrary outcome/error descriptions and callback-selected authority', () => {
    const s = setup(), value = s.callback('bdf2af85-5898-414c-a64c-27c38ce72eb2')
    expect(isNativeOAuthCallback(value)).toBe(true)
    for (const extra of [{ providerId: 'linear' }, { outcome: { status: 'denied', error_description: 'secret' } }, { outcome: { status: 'code', code: 'x'.repeat(4097) } }, { state: 'bad\nstate' }]) expect(isNativeOAuthCallback({ ...value, ...extra })).toBe(false)
    expect(OAUTH_NATIVE_CALLBACK_SCHEMAS['host.oauth.open'].validatePayload({ flowId: value.flowId, url: 'https://foreign.example' })).toBe(false)
  })
  it.each(['http://provider.example/authorize', 'https://user@provider.example/authorize', 'https://provider.example/authorize#fragment', 'https://provider.example/authorize?state=duplicate'])('rejects ambiguous authorization URL %s', async authorizationUrl => {
    const s = setup()
    await expect(s.owner.register({ ...input(), authorizationUrl: `${authorizationUrl}${authorizationUrl.includes('?') ? '&' : '?'}state=${nonce}&redirect_uri=${encodeURIComponent(redirectUri)}` }, s.binding)).rejects.toThrow()
    expect(s.native.register).not.toHaveBeenCalled(); await s.owner.close()
  })
})
