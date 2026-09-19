import { createId } from '@paralleldrive/cuid2'
import type { DatabaseManager } from '../database'
import { deserializeOAuthToken, encryptSecret } from './serializers'
import type { CreateOAuthTokenData, OAuthTokenRecord, OAuthTokenRow } from './types'

export function createOAuthToken(m: DatabaseManager, data: CreateOAuthTokenData): OAuthTokenRecord | undefined {
  const id = createId()
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString()

  m.prepare(`
    INSERT INTO oauth_tokens (id, provider, source_id, mcp_server_id, access_token, refresh_token, expires_at, scope, token_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.provider,
    data.source_id ?? null,
    data.mcp_server_id ?? null,
    encryptSecret(data.access_token),
    data.refresh_token ? encryptSecret(data.refresh_token) : null,
    expiresAt,
    data.scope,
    'Bearer',
    now,
    now
  )

  return getOAuthToken(m, id)
}

export function getOAuthToken(m: DatabaseManager, id: string): OAuthTokenRecord | undefined {
  const row = m.prepare(
    'SELECT * FROM oauth_tokens WHERE id = ?'
  ).get(id) as OAuthTokenRow | undefined

  return row ? deserializeOAuthToken(row) : undefined
}

export function getOAuthTokenBySource(m: DatabaseManager, sourceId: string): OAuthTokenRecord | undefined {
  const row = m.prepare(
    'SELECT * FROM oauth_tokens WHERE source_id = ?'
  ).get(sourceId) as OAuthTokenRow | undefined

  return row ? deserializeOAuthToken(row) : undefined
}

export function updateOAuthToken(m: DatabaseManager, id: string, accessToken: string, refreshToken: string | null, expiresIn: number): OAuthTokenRecord | undefined {
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

  m.prepare(
    'UPDATE oauth_tokens SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ? WHERE id = ?'
  ).run(encryptSecret(accessToken), refreshToken ? encryptSecret(refreshToken) : null, expiresAt, now, id)

  return getOAuthToken(m, id)
}

export function deleteOAuthToken(m: DatabaseManager, id: string): boolean {
  const result = m.prepare('DELETE FROM oauth_tokens WHERE id = ?').run(id)
  return result.changes > 0
}

export function deleteOAuthTokenBySource(m: DatabaseManager, sourceId: string): boolean {
  const result = m.prepare('DELETE FROM oauth_tokens WHERE source_id = ?').run(sourceId)
  return result.changes > 0
}

export function getOAuthTokenByMcpServer(m: DatabaseManager, mcpServerId: string): OAuthTokenRecord | undefined {
  const row = m.prepare(
    'SELECT * FROM oauth_tokens WHERE mcp_server_id = ?'
  ).get(mcpServerId) as OAuthTokenRow | undefined
  return row ? deserializeOAuthToken(row) : undefined
}

export function deleteOAuthTokenByMcpServer(m: DatabaseManager, mcpServerId: string): boolean {
  const result = m.prepare('DELETE FROM oauth_tokens WHERE mcp_server_id = ?').run(mcpServerId)
  return result.changes > 0
}
