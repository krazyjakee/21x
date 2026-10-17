import { createId } from '@paralleldrive/cuid2'
import { LocalOAuthServer } from './local-oauth-server'
import type { OAuthProvider, TokenResponse } from './oauth-provider'
import { generatePkce } from './pkce'

/**
 * Loopback authorization-code flow for connector pieces (issue #15). The same
 * steps as OAuthManager.startLocalhostOAuthFlow — start the localhost callback
 * server, build the PKCE pair and state, open the browser, wait for the
 * callback, check the state, exchange the code — without the manager's
 * task-source token storage: the caller decides where the token goes.
 *
 * `openExternal` and the server are injectable so tests can stand in a fake
 * browser and never open anything.
 */

export interface LoopbackCallbackServer {
  start(): Promise<string>
  waitForCallback(): Promise<{ code: string; state: string }>
  stop(): void
  close?(): Promise<void>
}

/** Captured host authority; a connector can retire only its own lease. */
export interface ConnectorOAuthFlowLease {
  open(): Promise<void>
  close(): Promise<void>
}
export interface ConnectorOAuthFlowAuthority {
  register(input: { kind: 'loopback'; redirectUri: string; authorizationUrl: string; ttlMs: number }, beforeEffect: () => void, onOwnedLease?: (lease: ConnectorOAuthFlowLease) => void): Promise<ConnectorOAuthFlowLease>
}

export interface ConnectorOAuthFlowOptions {
  provider: OAuthProvider
  /** `client_id` and, for confidential clients, `client_secret`. */
  config: Record<string, unknown>
  openExternal: (url: string) => Promise<void> | void
  server?: LoopbackCallbackServer
  signal?: AbortSignal
  nativeFlows?: ConnectorOAuthFlowAuthority
  beforeEffect?: () => void
}

export interface ConnectorOAuthFlowResult {
  token: TokenResponse
  redirectUri: string
}

export async function runLoopbackOAuthFlow(options: ConnectorOAuthFlowOptions): Promise<ConnectorOAuthFlowResult> {
  const server = options.server ?? new LocalOAuthServer()
  let nativeLease: ConnectorOAuthFlowLease | undefined
  const beforeEffect = (): void => { options.signal?.throwIfAborted(); options.beforeEffect?.() }
  const stopOnAbort = () => server.stop()
  options.signal?.addEventListener('abort', stopOnAbort, { once: true })
  try {
    beforeEffect()
    const redirectUri = await server.start()
    beforeEffect()
    const { verifier, challenge } = generatePkce()
    const state = createId()
    const authUrl = options.provider.generateAuthUrl(options.config, state, challenge, redirectUri)
    // Listen before the browser opens so a fast redirect cannot be missed.
    const callback = server.waitForCallback()
    callback.catch(() => undefined)
    if (options.nativeFlows) {
      nativeLease = await options.nativeFlows.register({ kind: 'loopback', redirectUri, authorizationUrl: authUrl, ttlMs: 300000 }, beforeEffect)
      beforeEffect()
      await nativeLease.open()
    } else await options.openExternal(authUrl)
    beforeEffect()
    const received = await callback
    beforeEffect()
    if (received.state !== state) throw new Error('OAuth state mismatch - possible CSRF attack')
    // Validation and the one-shot listener claim precede any asynchronous exchange.
    const token = await options.provider.exchangeCode(received.code, verifier, options.config, redirectUri)
    beforeEffect()
    return { token, redirectUri }
  } finally {
    options.signal?.removeEventListener('abort', stopOnAbort)
    let stopError: unknown
    try { server.stop() } catch (error) { stopError = error }
    // Neither close may prevent the other owner from receiving its retirement.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => server.close?.()),
      ...(nativeLease ? [Promise.resolve().then(() => nativeLease!.close())] : [])
    ])
    if (stopError) throw stopError
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}
