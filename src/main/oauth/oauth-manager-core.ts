import { AsyncLocalStorage } from 'node:async_hooks'
/**
 * OAuth Manager
 *
 * Generic OAuth 2.0 orchestrator that delegates provider-specific logic to OAuthProvider implementations.
 * Handles PKCE flow, token storage, refresh scheduling, and localhost server for providers that need it.
 */

import { createId } from '@paralleldrive/cuid2'
import { randomBytes, createHash } from 'crypto'
import { OwnedOperationLifetime } from '../owned-operation-lifetime'
import type { DatabaseManager } from '../database/manager'
import { LocalOAuthServer } from './local-oauth-server'
import type { OAuthProvider } from './oauth-provider'
import { LinearProvider, HubSpotProvider, McpOAuthProvider } from './providers'
import type { McpOAuthRegistration } from '../database/types'
import { McpDiscovery } from './mcp-discovery'

interface PendingFlow {
  verifier: string
  config: Record<string, unknown>
}

export interface OAuthHost {
  openExternal(url: string): Promise<void> | void
  notify(title: string, body: string): void
}

export class OAuthManager {
  private readonly lifetime = new OwnedOperationLifetime()
  private readonly requestGuard = new AsyncLocalStorage<(() => void) | undefined>()
  private readonly servers = new Set<LocalOAuthServer>()
  private db: DatabaseManager
  private providers: Map<string, OAuthProvider>
  private pendingFlows: Map<string, PendingFlow>
  private notifiedOAuthFailures = new Set<string>()

  constructor(db: DatabaseManager, private readonly host: OAuthHost) {
    this.db = db
    this.providers = new Map()
    this.pendingFlows = new Map()

    // Register available providers
    this.registerProvider(new LinearProvider())
    this.registerProvider(new HubSpotProvider())
    this.registerProvider(new McpOAuthProvider())
  }

  /** A caller scope fences token writes while the actual OAuth owner retains raw refresh work. */
  withRequestGuard<T>(effect: () => Promise<T>, beforeEffect: () => void): Promise<T> {
    const parent = this.requestGuard.getStore()
    return this.requestGuard.run(() => { parent?.(); beforeEffect() }, () => this.lifetime.run(async () => {
      this.assertRequestCurrent()
      const result = await effect()
      this.assertRequestCurrent()
      return result
    }))
  }

  private assertRequestCurrent(): void { this.requestGuard.getStore()?.() }

  /**
   * Register an OAuth provider
   */
  private registerProvider(provider: OAuthProvider): void {
    this.providers.set(provider.id, provider)
    console.log(`[OAuthManager] Registered provider: ${provider.id}`)
  }

  /**
   * Get a registered provider by ID
   */
  private getProvider(providerId: string): OAuthProvider {
    const provider = this.providers.get(providerId)
    if (!provider) {
      throw new Error(`Unknown OAuth provider: ${providerId}`)
    }
    return provider
  }

  /**
   * Generate PKCE code verifier and challenge
   */
  private generatePKCE(): { verifier: string; challenge: string } {
    // Generate 43-128 character random string
    const verifier = randomBytes(32).toString('base64url')

    // Create SHA256 hash and base64url encode
    const challenge = createHash('sha256').update(verifier).digest('base64url')

    return { verifier, challenge }
  }

  /**
   * Generate OAuth authorization URL with PKCE
   * For custom URL scheme providers (Linear), returns the URL directly.
   * For localhost providers (HubSpot), this is handled by startLocalhostOAuthFlow instead.
   */
  generateAuthUrl(providerId: string, config: Record<string, unknown>): string {
    this.lifetime.assertOpen()
    const provider = this.getProvider(providerId)

    if (provider.requiresLocalhost) {
      throw new Error(
        `Provider ${providerId} requires localhost redirect. Use startLocalhostOAuthFlow instead.`
      )
    }

    const { verifier, challenge } = this.generatePKCE()
    const state = createId()

    // Store verifier for later exchange
    this.pendingFlows.set(state, { verifier, config })

    return provider.generateAuthUrl(config, state, challenge)
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCode(
    providerId: string,
    code: string,
    state: string,
    sourceId: string
  ): Promise<void> {
    return this.lifetime.run(() => this.performExchangeCode(providerId, code, state, sourceId))
  }

  private async performExchangeCode(
    providerId: string,
    code: string,
    state: string,
    sourceId: string
  ): Promise<void> {
    const provider = this.getProvider(providerId)

    // Retrieve pending flow
    const pending = this.pendingFlows.get(state)
    if (!pending) {
      throw new Error('Invalid OAuth state parameter')
    }

    try {
      const data = await provider.exchangeCode(code, pending.verifier, pending.config)

      // Delete existing token for this source if any
      this.db.deleteOAuthTokenBySource(sourceId)

      // Store encrypted token
      this.db.createOAuthToken({
        provider: providerId,
        source_id: sourceId,
        access_token: data.access_token,
        refresh_token: data.refresh_token || null,
        expires_in: data.expires_in,
        scope: data.scope || null
      })
    } finally {
      // Clean up pending flow
      this.pendingFlows.delete(state)
    }
  }

  /**
   * Get a valid access token, refreshing if necessary
   */
  async getValidToken(sourceId: string): Promise<string | null> {
    return this.lifetime.run(() => this.performGetValidToken(sourceId))
  }

  private async performGetValidToken(sourceId: string): Promise<string | null> {
    this.assertRequestCurrent()
    const tokenRecord = this.db.getOAuthTokenBySource(sourceId)
    if (!tokenRecord) {
      return null
    }

    // Check if token expires in < 5 minutes
    const expiresAt = new Date(tokenRecord.expires_at).getTime()
    const nowPlus5Min = Date.now() + 5 * 60 * 1000

    if (expiresAt < nowPlus5Min) {
      // Token expired or expiring soon, refresh it
      try {
        await this.refreshToken(tokenRecord.id, tokenRecord.provider, tokenRecord.refresh_token)

        // Fetch the refreshed token
        this.assertRequestCurrent()
        const refreshedToken = this.db.getOAuthTokenBySource(sourceId)
        return refreshedToken?.access_token || null
      } catch {
        this.assertRequestCurrent()
        // If refresh fails (e.g., missing credentials), log and return null
        console.error('[OAuthManager] Source token refresh failed')
        return null
      }
    }

    return tokenRecord.access_token
  }

  /**
   * Refresh an expired access token
   */
  private async refreshToken(
    tokenId: string,
    providerId: string,
    refreshToken: string | null
  ): Promise<void> {
    this.assertRequestCurrent()
    if (!refreshToken) {
      throw new Error('No refresh token available')
    }

    const provider = this.getProvider(providerId)

    // Get the token record to access source
    const tokenRecord = this.db.getOAuthToken(tokenId)
    if (!tokenRecord) {
      throw new Error('Token not found')
    }

    // For MCP server tokens, get credentials from the MCP server's oauth_metadata
    if (tokenRecord.mcp_server_id) {
      await this.refreshMcpServerToken(tokenRecord)
      return
    }

    // For task source tokens, get credentials from task source config
    if (!tokenRecord.source_id) {
      throw new Error('Token has neither source_id nor mcp_server_id')
    }

    const taskSource = this.db.getTaskSource(tokenRecord.source_id)
    if (!taskSource) {
      throw new Error('Task source not found')
    }

    const clientId = taskSource.config.client_id as string
    const clientSecret = taskSource.config.client_secret as string

    if (!clientId || !clientSecret) {
      // OAuth credentials missing from config (likely due to config update that didn't preserve them)
      // Delete the invalid token so user can re-authenticate
      console.warn(
        `[OAuthManager] OAuth credentials missing for source ${tokenRecord.source_id}, deleting token`
      )
      this.db.deleteOAuthToken(tokenId)
      throw new Error('OAuth client credentials not found in task source config. Please re-authenticate.')
    }

    // Delegate to provider
    const data = await provider.refreshToken(refreshToken, clientId, clientSecret)

    // Update token in database
    this.assertRequestCurrent()
    this.db.updateOAuthToken(
      tokenId,
      data.access_token,
      data.refresh_token || refreshToken, // Use new refresh token if provided, otherwise keep old one
      data.expires_in
    )
  }

  /**
   * Revoke OAuth token for a source
   */
  async revokeToken(sourceId: string): Promise<void> {
    return this.lifetime.run(() => this.performRevokeToken(sourceId))
  }

  private async performRevokeToken(sourceId: string): Promise<void> {
    const tokenRecord = this.db.getOAuthTokenBySource(sourceId)
    if (!tokenRecord) {
      return
    }

    // Most providers don't have a revocation endpoint
    // Just delete from our database
    this.db.deleteOAuthToken(tokenRecord.id)
  }

  /**
   * Start OAuth flow with localhost redirect (for providers like HubSpot)
   * This is a complete flow that handles: server start → auth → callback → token exchange
   */
  async startLocalhostOAuthFlow(
    providerId: string,
    config: Record<string, unknown>,
    sourceId: string
  ): Promise<void> {
    return this.lifetime.run(() => this.performStartLocalhostOAuthFlow(providerId, config, sourceId))
  }

  private async performStartLocalhostOAuthFlow(
    providerId: string,
    config: Record<string, unknown>,
    sourceId: string
  ): Promise<void> {
    const provider = this.getProvider(providerId)

    if (!provider.requiresLocalhost) {
      throw new Error(
        `Provider ${providerId} doesn't require localhost redirect. Use generateAuthUrl instead.`
      )
    }

    const server = new LocalOAuthServer()
    this.servers.add(server)

    try {
      // Start local server and get redirect URI
      const redirectUri = await server.start()
      console.log(`[OAuthManager] Local server started with redirect URI: ${redirectUri}`)

      // Generate PKCE
      const { verifier, challenge } = this.generatePKCE()
      const state = createId()

      // Build auth URL with localhost redirect
      const authUrl = provider.generateAuthUrl(config, state, challenge, redirectUri)

      // Open auth URL in browser
      console.log(`[OAuthManager] Opening auth URL in browser`)
      this.lifetime.assertOpen()
      await this.host.openExternal(authUrl)
      this.lifetime.assertOpen()

      // Wait for callback from server
      console.log(`[OAuthManager] Waiting for OAuth callback...`)
      const callback = await server.waitForCallback()

      // Verify state matches
      if (callback.state !== state) {
        throw new Error('OAuth state mismatch - possible CSRF attack')
      }

      console.log(`[OAuthManager] Received callback, exchanging code for token`)

      // Exchange code for token
      this.lifetime.assertOpen()
      const data = await provider.exchangeCode(callback.code, verifier, config, redirectUri)

      // Delete existing token for this source if any
      this.db.deleteOAuthTokenBySource(sourceId)

      // Store encrypted token
      this.db.createOAuthToken({
        provider: providerId,
        source_id: sourceId,
        access_token: data.access_token,
        refresh_token: data.refresh_token || null,
        expires_in: data.expires_in,
        scope: data.scope || null
      })

      console.log(`[OAuthManager] OAuth flow completed successfully`)
    } finally {
      // Always stop the server
      await server.close()
      this.servers.delete(server)
    }
  }

  // ── MCP Server OAuth (spec-compliant discovery flow) ──────

  /**
   * Start OAuth flow for an MCP server.
   *
   * Implements the MCP Authorization spec (2025-11-25):
   * 1. Check for existing valid registration in oauth_metadata
   * 2. If missing, run full discovery: probe → PRM → AS metadata → DCR
   * 3. Run OAuth 2.1 + PKCE flow with `resource` parameter
   *
   * @throws Error with message 'NEEDS_MANUAL_CLIENT_ID' if DCR unavailable
   * @returns { needsManualClientId: true } if manual client_id input required
   */
  async startMcpServerOAuthFlow(mcpServerId: string): Promise<{ needsManualClientId?: boolean }> {
    return this.lifetime.run(() => this.performStartMcpServerOAuthFlow(mcpServerId))
  }

  private async performStartMcpServerOAuthFlow(mcpServerId: string): Promise<{ needsManualClientId?: boolean }> {
    const mcpServer = this.db.getMcpServer(mcpServerId)
    if (!mcpServer) throw new Error(`MCP server not found: ${mcpServerId}`)
    if (!mcpServer.url) throw new Error('MCP server has no URL configured')

    // Start the local OAuth server ONCE — same port used for both DCR and the callback
    const server = new LocalOAuthServer()
    this.servers.add(server)
    try {
      const redirectUri = await server.start()
      console.log(`[OAuthManager] MCP OAuth: local server started at ${redirectUri}`)

      let registration = mcpServer.oauth_metadata as McpOAuthRegistration | Record<string, never>
      const hasValidRegistration = registration
        && 'client_id' in registration
        && 'resource_url' in registration
        && registration.client_id

      if (!hasValidRegistration) {
        // Run spec-compliant discovery flow
        console.log(`[OAuthManager] MCP OAuth: starting discovery for ${mcpServer.url}`)

        const discovery = await McpDiscovery.discover(mcpServer.url, redirectUri)

        if (discovery.needsManualClientId) {
          // Store partial discovery (without client_id) so user only needs to provide client_id
          this.db.updateMcpServer(mcpServerId, {
            oauth_metadata: {
              resource_url: discovery.resourceUrl,
              authorization_server_url: discovery.authorizationServerUrl,
              authorization_endpoint: discovery.authorizationEndpoint,
              token_endpoint: discovery.tokenEndpoint,
              registration_endpoint: discovery.registrationEndpoint,
              revocation_endpoint: discovery.revocationEndpoint,
              scopes: discovery.scopes,
              code_challenge_methods_supported: discovery.codeChallengeMethodsSupported,
              client_id: '', // Placeholder — will be filled by completeManualRegistration
              registration_method: 'manual',
              discovered_at: new Date().toISOString()
            } as McpOAuthRegistration
          })
          return { needsManualClientId: true }
        }

        // Full registration obtained (via DCR)
        registration = {
          resource_url: discovery.resourceUrl,
          authorization_server_url: discovery.authorizationServerUrl,
          authorization_endpoint: discovery.authorizationEndpoint,
          token_endpoint: discovery.tokenEndpoint,
          registration_endpoint: discovery.registrationEndpoint,
          revocation_endpoint: discovery.revocationEndpoint,
          scopes: discovery.scopes,
          code_challenge_methods_supported: discovery.codeChallengeMethodsSupported,
          client_id: discovery.clientId!,
          client_secret: discovery.clientSecret,
          registration_method: discovery.registrationMethod || 'dcr',
          discovered_at: new Date().toISOString()
        } as McpOAuthRegistration

        // Persist registration to DB
        this.db.updateMcpServer(mcpServerId, { oauth_metadata: registration as McpOAuthRegistration })
      }

      // Now run the actual OAuth 2.1 + PKCE flow (same server, same port)
      const reg = registration as McpOAuthRegistration
      const provider = this.getProvider('mcp-server')
      const config: Record<string, unknown> = { ...reg }

      const { verifier, challenge } = this.generatePKCE()
      const state = createId()

      const authUrl = provider.generateAuthUrl(config, state, challenge, redirectUri)

      console.log(`[OAuthManager] MCP OAuth: opening auth URL in browser`)
      this.lifetime.assertOpen()
      await this.host.openExternal(authUrl)
      this.lifetime.assertOpen()

      console.log(`[OAuthManager] MCP OAuth: waiting for callback...`)
      const callback = await server.waitForCallback()

      if (callback.state !== state) {
        throw new Error('OAuth state mismatch - possible CSRF attack')
      }

      console.log(`[OAuthManager] MCP OAuth: exchanging code for token`)
      this.lifetime.assertOpen()
      const data = await provider.exchangeCode(callback.code, verifier, config, redirectUri)

      // Delete existing token for this MCP server if any
      this.db.deleteOAuthTokenByMcpServer(mcpServerId)

      // Store encrypted token linked to MCP server
      this.db.createOAuthToken({
        provider: 'mcp-server',
        mcp_server_id: mcpServerId,
        access_token: data.access_token,
        refresh_token: data.refresh_token || null,
        expires_in: data.expires_in,
        scope: data.scope || null
      })

      console.log(`[OAuthManager] MCP OAuth flow completed successfully for server: ${mcpServer.name}`)
      return {}
    } finally {
      await server.close()
      this.servers.delete(server)
    }
  }

  /**
   * Complete a partial MCP OAuth registration with a manually-provided client_id.
   * Called when DCR is unavailable and user provides client_id through UI.
   */
  async completeManualRegistration(mcpServerId: string, clientId: string): Promise<{ needsManualClientId?: boolean }> {
    return this.lifetime.run(() => this.performCompleteManualRegistration(mcpServerId, clientId))
  }

  private async performCompleteManualRegistration(mcpServerId: string, clientId: string): Promise<{ needsManualClientId?: boolean }> {
    const mcpServer = this.db.getMcpServer(mcpServerId)
    if (!mcpServer) throw new Error(`MCP server not found: ${mcpServerId}`)

    const partial = mcpServer.oauth_metadata as McpOAuthRegistration | Record<string, never>
    if (!partial || !('authorization_endpoint' in partial)) {
      throw new Error('No partial registration found. Run startMcpServerOAuthFlow first.')
    }

    // Update registration with user-provided client_id
    const reg: McpOAuthRegistration = {
      ...(partial as McpOAuthRegistration),
      client_id: clientId,
      registration_method: 'manual'
    }
    this.db.updateMcpServer(mcpServerId, { oauth_metadata: reg })

    // Now run the OAuth flow
    return this.startMcpServerOAuthFlow(mcpServerId)
  }

  /**
   * Get a valid access token for an MCP server, refreshing if needed.
   */
  async getValidMcpServerToken(mcpServerId: string, beforeEffect?: () => void): Promise<string | null> {
    if (beforeEffect) return this.withRequestGuard(() => this.getValidMcpServerToken(mcpServerId), beforeEffect)
    return this.lifetime.run(() => this.performGetValidMcpServerToken(mcpServerId))
  }

  private async performGetValidMcpServerToken(mcpServerId: string): Promise<string | null> {
    this.assertRequestCurrent()
    const tokenRecord = this.db.getOAuthTokenByMcpServer(mcpServerId)
    if (!tokenRecord) return null

    const expiresAt = new Date(tokenRecord.expires_at).getTime()
    const nowPlus5Min = Date.now() + 5 * 60 * 1000

    if (expiresAt < nowPlus5Min) {
      try {
        await this.refreshMcpServerToken(tokenRecord)
        this.assertRequestCurrent()
        const refreshed = this.db.getOAuthTokenByMcpServer(mcpServerId)
        return refreshed?.access_token || null
      } catch (error) {
        this.assertRequestCurrent()
        const serverName = this.db.getMcpServer(mcpServerId)?.name || mcpServerId
        console.error('[OAuthManager] MCP token refresh failed')

        // If the refresh token is permanently invalid, clean up the stale record
        // so UI correctly shows "disconnected" instead of a false "connected" badge
        const errMsg = String(error)
        if (errMsg.includes('invalid_grant') || errMsg.includes('Invalid refresh token')) {
          this.db.deleteOAuthTokenByMcpServer(mcpServerId)
          console.warn(`[OAuthManager] Deleted stale OAuth token for "${serverName}" — re-authentication required`)
        }

        // Notify user once per server per app run
        if (!this.notifiedOAuthFailures.has(mcpServerId)) {
          this.notifiedOAuthFailures.add(mcpServerId)
          try {
            this.host.notify('MCP OAuth Expired', `"${serverName}" OAuth token is invalid — please re-authenticate in Settings → Tools.`)
          } catch { /* ignore in headless / test */ }
        }

        return null
      }
    }

    return tokenRecord.access_token
  }

  /**
   * Refresh an MCP server's OAuth token using credentials from oauth_metadata registration.
   */
  private async refreshMcpServerToken(tokenRecord: import('../database/types').OAuthTokenRecord): Promise<void> {
    this.assertRequestCurrent()
    if (!tokenRecord.refresh_token) throw new Error('No refresh token available')
    if (!tokenRecord.mcp_server_id) throw new Error('No MCP server ID on token')

    const mcpServer = this.db.getMcpServer(tokenRecord.mcp_server_id)
    if (!mcpServer) throw new Error('MCP server not found')

    const registration = mcpServer.oauth_metadata as McpOAuthRegistration | undefined
    if (!registration?.client_id || !registration?.token_endpoint) {
      this.db.deleteOAuthToken(tokenRecord.id)
      throw new Error('MCP server OAuth registration incomplete. Please re-authenticate.')
    }

    const provider = this.getProvider('mcp-server')
    const data = await provider.refreshToken(
      tokenRecord.refresh_token,
      registration.client_id,
      registration.client_secret || '',
      registration.token_endpoint
    )

    this.assertRequestCurrent()
    this.db.updateOAuthToken(
      tokenRecord.id,
      data.access_token,
      data.refresh_token || tokenRecord.refresh_token,
      data.expires_in
    )
  }

  /**
   * Revoke OAuth token for an MCP server.
   */
  async revokeMcpServerToken(mcpServerId: string): Promise<void> {
    return this.lifetime.run(() => this.performRevokeMcpServerToken(mcpServerId))
  }

  private async performRevokeMcpServerToken(mcpServerId: string): Promise<void> {
    this.db.deleteOAuthTokenByMcpServer(mcpServerId)
  }

  /**
   * Check if an MCP server has a valid OAuth token.
   */
  getMcpServerOAuthStatus(mcpServerId: string): { connected: boolean; expiresAt?: string } {
    this.lifetime.assertOpen()
    const token = this.db.getOAuthTokenByMcpServer(mcpServerId)
    if (!token) return { connected: false }
    return { connected: true, expiresAt: token.expires_at }
  }

  /**
   * Probe an MCP server URL to determine if it requires OAuth authentication.
   * Sends an unauthenticated request and checks for a 401 response.
   */
  static async probeForAuth(serverUrl: string): Promise<{ requiresAuth: boolean }> {
    const result = await McpDiscovery.probeForAuth(serverUrl)
    return { requiresAuth: result.requiresAuth }
  }

  /**
   * Fence new token/flow work and cancel owned callback waits. Hosts must
   * join close() before releasing the database or credential provider.
   */
  destroy(): void {
    this.lifetime.stop()
    this.pendingFlows.clear()
    for (const server of this.servers) server.stop()
  }

  async close(timeoutMs = 3000): Promise<void> {
    this.destroy()
    await this.lifetime.close(timeoutMs)
    await Promise.all([...this.servers].map(server => server.close()))
    this.servers.clear()
  }
}
