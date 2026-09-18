/**
 * OAuth Provider Registry
 *
 * Exports all available OAuth providers.
 */

export { LinearProvider } from './linear-provider'
export { HubSpotProvider } from './hubspot-provider'
export { McpOAuthProvider } from './mcp-oauth-provider'
export { ConnectorOAuthProvider, OAuthTokenRequestError, type ConnectorOAuthSpec } from './connector-oauth-provider'
