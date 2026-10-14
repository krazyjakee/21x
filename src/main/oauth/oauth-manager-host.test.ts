import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPortableDbFixture } from '../../../test/helpers/portable-db-test-helper'
import { OAuthManager } from './oauth-manager-core'
import { LinearProvider } from './providers/linear-provider'

function held() {
  let finish!: () => void
  const promise = new Promise<void>(resolve => { finish = resolve })
  return { promise, finish }
}

afterEach(() => vi.restoreAllMocks())

describe('portable OAuth owner', () => {
  it('does not log provider credential text when a saved source token refresh fails', async () => {
    const source = createPortableDbFixture()
    const owner = new OAuthManager(source.db, { openExternal: vi.fn(), notify: vi.fn() })
    const taskSource = source.db.createTaskSource({ name: 'Fixture OAuth', plugin_id: 'linear', mcp_server_id: null, config: { client_id: 'fixture', client_secret: 'fixture-secret' } })!
    source.db.createOAuthToken({ provider: 'linear', source_id: taskSource.id, access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: -1, scope: null })
    vi.spyOn(LinearProvider.prototype, 'refreshToken').mockRejectedValue(new Error('fixture-access fixture-refresh fixture-secret'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await owner.getValidToken(taskSource.id)).toBeNull()
      expect(log).toHaveBeenCalledWith('[OAuthManager] Source token refresh failed')
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/fixture-access|fixture-refresh|fixture-secret/)
    } finally { await owner.close(); source.rawDb.close() }
  })
  it('joins an ignored-abort refresh and preserves the accepted rotated token before the database closes', async () => {
    const source = createPortableDbFixture()
    const gate = held(), entered = held()
    const host = { openExternal: vi.fn(async () => {}), notify: vi.fn() }
    const owner = new OAuthManager(source.db, host)
    const taskSource = source.db.createTaskSource({ name: 'Fixture OAuth', plugin_id: 'linear', mcp_server_id: null,
      config: { client_id: 'fixture', client_secret: 'fixture' } })!
    source.db.createOAuthToken({ provider: 'linear', source_id: taskSource.id, access_token: 'old', refresh_token: 'old-refresh', expires_in: -1, scope: null })
    const refresh = vi.spyOn(LinearProvider.prototype, 'refreshToken').mockImplementation(async () => {
      entered.finish(); await gate.promise
      return { access_token: 'accepted-rotated', refresh_token: 'accepted-refresh', expires_in: 3600 }
    })
    const token = owner.getValidToken(taskSource.id)
    try {
      await entered.promise
      await expect(owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED')
      expect(source.rawDb.open).toBe(true)
      gate.finish()
      expect(await token).toBe('accepted-rotated')
      await owner.close()
      expect(source.db.getOAuthTokenBySource(taskSource.id)?.refresh_token).toBe('accepted-refresh')
      expect(refresh).toHaveBeenCalledOnce()
      await expect(owner.getValidToken(taskSource.id)).rejects.toThrow('OWNER_CLOSING')
      expect(host.openExternal).not.toHaveBeenCalled()
    } finally { gate.finish(); await token; await owner.close(); source.rawDb.close() }
  })

  it('fences a localhost flow whose native browser launch finishes after destroy, without starting a new callback wait', async () => {
    const source = createPortableDbFixture()
    const open = held(), entered = held()
    const owner = new OAuthManager(source.db, { openExternal: async () => { entered.finish(); await open.promise }, notify: vi.fn() })
    // The actual callback listener is owned and closed; only the OS browser
    // launch is controlled. No provider token endpoint is contacted.
    const flow = owner.startLocalhostOAuthFlow('hubspot', { client_id: 'fixture', scope: 'oauth' }, 'unused-fixture-source')
    const result = expect(flow).rejects.toThrow('OWNER_CLOSING')
    try {
      await entered.promise
      await expect(owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED')
      open.finish()
      await result
      await owner.close()
      expect(source.rawDb.open).toBe(true)
    } finally { open.finish(); await result; await owner.close(); source.rawDb.close() }
  })
})
