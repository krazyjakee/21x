import type { OAuthProvider, TokenResponse } from '../oauth-provider'

/**
 * Generic OAuth 2.0 authorization-code provider for embedded connector pieces
 * (issue #15, docs/taskSources.md "Connector OAuth2").
 *
 * An Activepieces OAuth2 piece declares `PieceAuth.OAuth2({ authUrl, tokenUrl,
 * scope })`. One instance of this class is built per piece from its allowlist
 * entry (`oauth` in src/main/connectors/allowlist.ts) and plugs into the same
 * OAuthProvider contract the Linear / HubSpot / MCP providers use. It always
 * redirects to the loopback server (`requiresLocalhost`), sends PKCE only when
 * the entry says the provider supports it, and never embeds a client secret:
 * the secret arrives in `config.client_secret` from the user's own app
 * registration (or is absent for a public client).
 */

export interface ConnectorOAuthSpec {
  /** Provider id, e.g. `connector:@activepieces/piece-todoist`. */
  id: string
  authUrl: string
  tokenUrl: string
  scopes: string[]
  pkce: boolean
  /** Joins `scopes` in the authorization URL; a space unless the provider wants otherwise. */
  scopeSeparator?: string
  /** Extra authorization query parameters (e.g. `access_type=offline`). */
  authParams?: Record<string, string>
}

/** A token endpoint answered with an error (RFC 6749 §5.2) or an unusable body. */
export class OAuthTokenRequestError extends Error {
  readonly code = 'OAUTH_TOKEN_REQUEST'
  constructor(
    readonly status: number,
    /** The `error` field of the response, when it was JSON; e.g. `invalid_grant`. */
    readonly oauthError: string | null,
    message: string
  ) {
    super(message)
    this.name = 'OAuthTokenRequestError'
  }

  /** The refresh token (or code) is no longer accepted: revoked, expired or already used. */
  get isInvalidGrant(): boolean {
    return this.oauthError === 'invalid_grant' || this.oauthError === 'invalid_token'
  }
}

type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/** Parses a token response body: JSON, or form-encoded for providers that still answer that way. */
function parseTokenBody(text: string, contentType: string | null): Record<string, unknown> {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || (contentType ?? '').includes('json')) {
    return JSON.parse(trimmed) as Record<string, unknown>
  }
  return Object.fromEntries(new URLSearchParams(trimmed).entries())
}

export class ConnectorOAuthProvider implements OAuthProvider {
  readonly id: string
  readonly requiresLocalhost = true

  constructor(
    readonly spec: ConnectorOAuthSpec,
    private readonly fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init)
  ) {
    this.id = spec.id
  }

  generateAuthUrl(config: Record<string, unknown>, state: string, challenge: string, redirectUri?: string): string {
    if (!redirectUri) throw new Error('Connector OAuth needs the loopback redirect URI')
    const clientId = optionalString(config.client_id)
    if (!clientId) throw new Error('OAuth client id is missing')
    const url = new URL(this.spec.authUrl)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    if (this.spec.scopes.length) url.searchParams.set('scope', this.spec.scopes.join(this.spec.scopeSeparator ?? ' '))
    url.searchParams.set('state', state)
    if (this.spec.pkce) {
      url.searchParams.set('code_challenge', challenge)
      url.searchParams.set('code_challenge_method', 'S256')
    }
    for (const [k, v] of Object.entries(this.spec.authParams ?? {})) url.searchParams.set(k, v)
    return url.toString()
  }

  async exchangeCode(code: string, verifier: string, config: Record<string, unknown>, redirectUri?: string): Promise<TokenResponse> {
    if (!redirectUri) throw new Error('Connector OAuth needs the loopback redirect URI')
    const clientId = optionalString(config.client_id)
    if (!clientId) throw new Error('OAuth client id is missing')
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId
    })
    const secret = optionalString(config.client_secret)
    if (secret) params.set('client_secret', secret)
    if (this.spec.pkce) params.set('code_verifier', verifier)
    return this.tokenRequest(this.spec.tokenUrl, params, 'exchange')
  }

  async refreshToken(refreshToken: string, clientId: string, clientSecret: string, tokenEndpoint?: string): Promise<TokenResponse> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId
    })
    if (clientSecret) params.set('client_secret', clientSecret)
    return this.tokenRequest(tokenEndpoint || this.spec.tokenUrl, params, 'refresh')
  }

  private async tokenRequest(url: string, params: URLSearchParams, what: 'exchange' | 'refresh'): Promise<TokenResponse> {
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString()
    })
    const text = await response.text()
    let body: Record<string, unknown> = {}
    try {
      body = parseTokenBody(text, response.headers.get('content-type'))
    } catch {
      /* not JSON or form data; handled below */
    }
    if (!response.ok) {
      const error = optionalString(body.error) ?? null
      const description = optionalString(body.error_description)
      const detail = error ? `${error}${description ? `: ${description}` : ''}` : text.replace(/\s+/g, ' ').trim().slice(0, 200)
      throw new OAuthTokenRequestError(response.status, error, `OAuth token ${what} failed (${response.status})${detail ? `: ${detail}` : ''}`)
    }
    const accessToken = optionalString(body.access_token)
    if (!accessToken) {
      const error = optionalString(body.error) ?? null
      throw new OAuthTokenRequestError(response.status, error, `OAuth token ${what} returned no access token${error ? ` (${error})` : ''}`)
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in
      : typeof body.expires_in === 'string' && /^\d+$/.test(body.expires_in) ? parseInt(body.expires_in, 10)
      : undefined
    return {
      access_token: accessToken,
      refresh_token: optionalString(body.refresh_token),
      // 0 = no expiry reported (Todoist tokens never expire); callers treat it as non-expiring.
      expires_in: expiresIn ?? 0,
      scope: optionalString(body.scope),
      token_type: optionalString(body.token_type) ?? 'Bearer'
    }
  }
}
