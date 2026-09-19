/**
 * MCP OAuth Discovery Module
 *
 * Implements the MCP Authorization spec (2025-11-25) discovery flow:
 * 1. Probe MCP server for 401 → extract WWW-Authenticate header
 * 2. Discover Protected Resource Metadata (RFC 9728)
 * 3. Discover Authorization Server Metadata (RFC 8414 / OpenID Connect)
 * 4. Dynamic Client Registration (RFC 7591)
 *
 * @see https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
 */

import { mcpInitializeRequest } from '../mcp-client-messages'

const FETCH_TIMEOUT = 10_000

/** RFC 9728 Protected Resource Metadata */
export interface ProtectedResourceMetadata {
  resource: string
  authorization_servers: string[]
  scopes_supported?: string[]
  bearer_methods_supported?: string[]
}

/** RFC 8414 Authorization Server Metadata */
export interface AuthorizationServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  revocation_endpoint?: string
  scopes_supported?: string[]
  code_challenge_methods_supported?: string[]
  grant_types_supported?: string[]
  response_types_supported?: string[]
  client_id_metadata_document_supported?: boolean
}

/** RFC 7591 Dynamic Client Registration Response */
export interface DcrResponse {
  client_id: string
  client_secret?: string
  client_id_issued_at?: number
  client_secret_expires_at?: number
}

/** Result of probing an MCP server for auth requirements */
export interface ProbeResult {
  requiresAuth: boolean
  wwwAuthenticate?: string
  resourceMetadataUrl?: string
  scope?: string
}

/** Full discovery result */
export interface DiscoveryResult {
  resourceUrl: string
  authorizationServerUrl: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  revocationEndpoint?: string
  scopes?: string
  codeChallengeMethodsSupported?: string[]
  clientId?: string
  clientSecret?: string
  registrationMethod?: 'dcr' | 'manual'
  needsManualClientId: boolean
}

/** JSON from a GET with a timeout, or null on any failure. */
async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT)
    })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

function parseUrlParts(url: string): { origin: string; path: string } {
  const parsed = new URL(url)
  const path = parsed.pathname === '/' ? '' : parsed.pathname
  return { origin: parsed.origin, path }
}

/** The quoted resource_metadata and scope values of a WWW-Authenticate header. */
function parseWwwAuthenticate(header: string): { resourceMetadataUrl?: string; scope?: string } {
  return {
    resourceMetadataUrl: header.match(/resource_metadata="([^"]+)"/)?.[1],
    scope: header.match(/scope="([^"]+)"/)?.[1]
  }
}

export class McpDiscovery {
  /**
   * Step 1: an unauthenticated request. Per spec, a server that needs auth
   * MUST answer 401 with a WWW-Authenticate header.
   */
  static async probeForAuth(serverUrl: string): Promise<ProbeResult> {
    try {
      const response = await fetch(serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mcpInitializeRequest()),
        signal: AbortSignal.timeout(FETCH_TIMEOUT)
      })

      if (response.status === 401) {
        const wwwAuth = response.headers.get('www-authenticate') || ''
        const parsed = parseWwwAuthenticate(wwwAuth)
        return {
          requiresAuth: true,
          wwwAuthenticate: wwwAuth || undefined,
          resourceMetadataUrl: parsed.resourceMetadataUrl,
          scope: parsed.scope
        }
      }

      return { requiresAuth: false }
    } catch {
      // Unreachable: can't tell, so assume no auth.
      return { requiresAuth: false }
    }
  }

  /**
   * Step 2: Discover Protected Resource Metadata (RFC 9728).
   *
   * Try in order:
   * 1. Fetch from resource_metadata URL (from WWW-Authenticate header)
   * 2. GET /.well-known/oauth-protected-resource/{path}
   * 3. GET /.well-known/oauth-protected-resource (root)
   */
  static async discoverProtectedResource(
    serverUrl: string,
    resourceMetadataUrl?: string
  ): Promise<ProtectedResourceMetadata | null> {
    if (resourceMetadataUrl) {
      const meta = await fetchJson<ProtectedResourceMetadata>(resourceMetadataUrl)
      if (meta?.authorization_servers?.length) return meta
    }

    const { origin, path } = parseUrlParts(serverUrl)

    if (path) {
      const meta = await fetchJson<ProtectedResourceMetadata>(
        `${origin}/.well-known/oauth-protected-resource${path}`
      )
      if (meta?.authorization_servers?.length) return meta
    }

    const meta = await fetchJson<ProtectedResourceMetadata>(
      `${origin}/.well-known/oauth-protected-resource`
    )
    if (meta?.authorization_servers?.length) return meta

    return null
  }

  /** Step 3: Authorization Server Metadata (RFC 8414 + OIDC), well-known URLs in priority order. */
  static async discoverAuthorizationServer(
    authServerUrl: string
  ): Promise<AuthorizationServerMetadata | null> {
    const { origin, path } = parseUrlParts(authServerUrl)

    const urls: string[] = []

    if (path) {
      urls.push(`${origin}/.well-known/oauth-authorization-server${path}`)
      urls.push(`${origin}/.well-known/openid-configuration${path}`)
      urls.push(`${origin}${path}/.well-known/openid-configuration`)
    } else {
      urls.push(`${origin}/.well-known/oauth-authorization-server`)
      urls.push(`${origin}/.well-known/openid-configuration`)
    }

    for (const url of urls) {
      const meta = await fetchJson<AuthorizationServerMetadata>(url)
      if (meta?.authorization_endpoint && meta?.token_endpoint) {
        return meta
      }
    }

    return null
  }

  /**
   * Step 4: Dynamic Client Registration (RFC 7591) as a public client, so
   * token_endpoint_auth_method is "none" per OAuth 2.1.
   */
  static async registerClient(
    registrationEndpoint: string,
    redirectUri: string
  ): Promise<DcrResponse | null> {
    try {
      const response = await fetch(registrationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: '21x Desktop',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none'
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT)
      })

      if (!response.ok) {
        console.warn(`[mcp-discovery] DCR failed: ${response.status} ${response.statusText}`)
        return null
      }

      return (await response.json()) as DcrResponse
    } catch (err) {
      console.warn('[mcp-discovery] DCR error:', err)
      return null
    }
  }

  /** probe → Protected Resource Metadata → AS Metadata → DCR; everything McpOAuthRegistration needs. */
  static async discover(serverUrl: string, redirectUri: string): Promise<DiscoveryResult> {
    const probe = await McpDiscovery.probeForAuth(serverUrl)
    if (!probe.requiresAuth) {
      throw new Error('Server does not require authentication')
    }

    const prm = await McpDiscovery.discoverProtectedResource(serverUrl, probe.resourceMetadataUrl)
    if (!prm) {
      throw new Error(
        'Server requires auth but does not advertise OAuth Protected Resource Metadata. ' +
        'Expected /.well-known/oauth-protected-resource or WWW-Authenticate resource_metadata header.'
      )
    }

    let asMeta: AuthorizationServerMetadata | null = null
    for (const asUrl of prm.authorization_servers) {
      asMeta = await McpDiscovery.discoverAuthorizationServer(asUrl)
      if (asMeta) break
    }

    if (!asMeta) {
      throw new Error(
        `Could not discover Authorization Server metadata from: ${prm.authorization_servers.join(', ')}`
      )
    }

    const scopes = probe.scope || prm.scopes_supported?.join(' ') || undefined

    if (
      asMeta.code_challenge_methods_supported &&
      !asMeta.code_challenge_methods_supported.includes('S256')
    ) {
      throw new Error('Authorization server does not support S256 PKCE code challenge method')
    }

    const result: DiscoveryResult = {
      resourceUrl: prm.resource || serverUrl,
      authorizationServerUrl: asMeta.issuer || prm.authorization_servers[0],
      authorizationEndpoint: asMeta.authorization_endpoint,
      tokenEndpoint: asMeta.token_endpoint,
      registrationEndpoint: asMeta.registration_endpoint,
      revocationEndpoint: asMeta.revocation_endpoint,
      scopes,
      codeChallengeMethodsSupported: asMeta.code_challenge_methods_supported,
      needsManualClientId: true
    }

    if (asMeta.registration_endpoint) {
      const dcr = await McpDiscovery.registerClient(asMeta.registration_endpoint, redirectUri)
      if (dcr) {
        result.clientId = dcr.client_id
        result.clientSecret = dcr.client_secret
        result.registrationMethod = 'dcr'
        result.needsManualClientId = false
      }
    }

    return result
  }
}
