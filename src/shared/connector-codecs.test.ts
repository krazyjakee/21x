import { describe, expect, it } from 'vitest'
import { CONNECTOR_CODECS, CONNECTOR_WRITE_ERROR, CONNECTOR_SYNC_ERROR } from './connector-codecs'
const trello = '@activepieces/piece-trello'
describe('finite connector desktop codecs', () => {
  it('preserves omitted/session/persistent semantics without raw secret outputs', () => {
    const input = { username: 'synthetic-key', password: 'synthetic-token' }
    expect(CONNECTOR_CODECS['connectors:setCredentials'].encodeArguments(['instance', input])).toEqual({ instanceId: 'instance', input })
    expect(CONNECTOR_CODECS['connectors:setCredentials'].decodeArguments({ instanceId: 'instance', input, storage: 'session' })).toEqual(['instance', input, 'session'])
    expect(CONNECTOR_CODECS['connectors:oauthConnect'].encodeArguments(['instance', { clientId: 'synthetic', clientSecret: undefined }])).toEqual({ instanceId: 'instance', input: { clientId: 'synthetic' } })
    expect(() => CONNECTOR_CODECS['connectors:oauthConnect'].decodeArguments({ instanceId: 'instance', input: { clientId: 'synthetic', extra: null } })).toThrow()
    expect(CONNECTOR_CODECS['connectors:clearCredentials'].encodeResult(undefined)).toEqual({ defined: false })
    expect(() => CONNECTOR_CODECS['connectors:clearCredentials'].decodeResult(null)).toThrow()
    expect(() => CONNECTOR_CODECS['connectors:credentialStatus'].decodeResult({ storage: 'session', persistentAvailable: true, secret: 'private' })).toThrow()
    expect(() => CONNECTOR_CODECS['connectors:setCredentials'].encodeResult({ ok: true, storage: 'session', secret: 'private' })).toThrow()
  })
  it('rejects arbitrary pieces, authority envelopes, paths, storage values and saved-key markers', () => {
    expect(() => CONNECTOR_CODECS['connectors:ensureInstance'].encodeArguments(['@activepieces/piece-unreviewed'])).toThrow()
    expect(() => CONNECTOR_CODECS['connectors:ensureInstance'].decodeArguments({ pieceName: trello, profilePath: '/private' })).toThrow()
    for (const input of [{ password: '__21x_api_key_set__' }, { password: ' __21x_mcp_secret_set__ ' }, { secret: 'x'.repeat(4097) }, { password: 'private\nline' }, { username: 'x', password: 'y', path: '/private' }]) expect(() => CONNECTOR_CODECS['connectors:setCredentials'].encodeArguments(['instance', input])).toThrow()
    expect(() => CONNECTOR_CODECS['connectors:oauthConnect'].encodeArguments(['instance', { clientId: 'private', clientSecret: '__21x_api_key_set__' }])).toThrow()
    expect(() => CONNECTOR_CODECS['connectors:oauthConnect'].decodeArguments({ instanceId: 'instance', input: { clientId: 'x' }, storage: 'export' })).toThrow()
    expect(() => CONNECTOR_CODECS['connectors:syncStatus'].decodeArguments({ instanceId: '../foreign' })).toThrow()
  })
  it('replaces raw errors and withholds sync cursor/dead-letter payloads', () => {
    expect(CONNECTOR_CODECS['connectors:oauthConnect'].encodeResult({ ok: false, error: 'private-provider-url', sessionOnlyAvailable: false })).toEqual({ defined: true, value: { ok: false, error: CONNECTOR_WRITE_ERROR } })
    expect(CONNECTOR_CODECS['connectors:syncStatus'].encodeResult({ lastError: 'private-provider-url', lastSyncedAt: 1, attemptCount: 2, nextRetryAt: 3, deadLetterCount: 1 })).toEqual({ defined: true, value: { lastError: CONNECTOR_SYNC_ERROR, lastSyncedAt: 1, attemptCount: 2, nextRetryAt: 3, deadLetterCount: 1 } })
    expect(() => CONNECTOR_CODECS['connectors:syncStatus'].encodeResult({ lastError: null, lastSyncedAt: null, attemptCount: 0, nextRetryAt: null, deadLetterCount: 0, cursor: 'private' })).toThrow()
    expect(() => CONNECTOR_CODECS['connectors:syncStatus'].encodeResult({ lastError: null, lastSyncedAt: null, attemptCount: -1, nextRetryAt: null, deadLetterCount: 0 })).toThrow()
  })
})
