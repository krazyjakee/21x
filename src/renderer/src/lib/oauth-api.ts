import { desktopApi } from '@/lib/desktop-api'
/**
 * OAuth API client for IPC communication
 */

export const oauthApi = {
  /**
   * Generate OAuth authorization URL
   */
  startFlow: (provider: string, config: Record<string, unknown>): Promise<string> =>
    desktopApi.oauth.startFlow(provider, config),

  /**
   * Exchange authorization code for access token
   */
  exchangeCode: (provider: string, code: string, state: string, sourceId: string): Promise<void> =>
    desktopApi.oauth.exchangeCode(provider, code, state, sourceId),

  /**
   * Start OAuth flow with localhost redirect (for HubSpot)
   */
  startLocalhostFlow: (provider: string, config: Record<string, unknown>, sourceId: string): Promise<void> =>
    desktopApi.oauth.startLocalhostFlow(provider, config, sourceId),

  /**
   * Get a valid access token (refreshes if needed)
   */
  getValidToken: (sourceId: string): Promise<string | null> =>
    desktopApi.oauth.getValidToken(sourceId),

  /**
   * Revoke OAuth token for a source
   */
  revokeToken: (sourceId: string): Promise<void> =>
    desktopApi.oauth.revokeToken(sourceId)
}
