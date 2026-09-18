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
}

export interface ConnectorOAuthFlowOptions {
  provider: OAuthProvider
  /** `client_id` and, for confidential clients, `client_secret`. */
  config: Record<string, unknown>
  openExternal: (url: string) => Promise<void> | void
  server?: LoopbackCallbackServer
}

export interface ConnectorOAuthFlowResult {
  token: TokenResponse
  redirectUri: string
}

export async function runLoopbackOAuthFlow(options: ConnectorOAuthFlowOptions): Promise<ConnectorOAuthFlowResult> {
  const server = options.server ?? new LocalOAuthServer()
  try {
    const redirectUri = await server.start()
    const { verifier, challenge } = generatePkce()
    const state = createId()
    const authUrl = options.provider.generateAuthUrl(options.config, state, challenge, redirectUri)
    // Listen before the browser opens so a fast redirect cannot be missed.
    const callback = server.waitForCallback()
    callback.catch(() => undefined)
    await options.openExternal(authUrl)
    const received = await callback
    if (received.state !== state) throw new Error('OAuth state mismatch - possible CSRF attack')
    const token = await options.provider.exchangeCode(received.code, verifier, options.config, redirectUri)
    return { token, redirectUri }
  } finally {
    server.stop()
  }
}
