import { describe, expect, it } from 'vitest'
import {
  CLIENT_NAME,
  DEEP_LINK_SCHEMES,
  LEGACY_OAUTH_CALLBACK_URL,
  OAUTH_CALLBACK_URL,
  oauthRedirectUri,
  parseOAuthCallbackUrl
} from './app-identity'
import { LinearProvider } from './oauth/providers/linear-provider'

describe('app identity', () => {
  it('names the app 21x to MCP servers and agent CLIs', () => {
    expect(CLIENT_NAME).toBe('21x')
  })

  it('registers twentyonex and, for one release, nuanu', () => {
    expect(DEEP_LINK_SCHEMES).toEqual(['twentyonex', 'nuanu'])
    expect(OAUTH_CALLBACK_URL).toBe('twentyonex://oauth/callback')
    expect(LEGACY_OAUTH_CALLBACK_URL).toBe('nuanu://oauth/callback')
  })
})

describe('parseOAuthCallbackUrl', () => {
  it.each(['twentyonex', 'nuanu', 'TwentyOneX'])('accepts the %s scheme', (scheme) => {
    expect(parseOAuthCallbackUrl(`${scheme}://oauth/callback?code=abc&state=xyz`)).toEqual({ code: 'abc', state: 'xyz' })
  })

  it('reports a missing code or state as null', () => {
    expect(parseOAuthCallbackUrl('twentyonex://oauth/callback?state=xyz')).toEqual({ code: null, state: 'xyz' })
  })

  it.each([
    'other://oauth/callback?code=a&state=b',
    'twentyonex://oauth/elsewhere?code=a&state=b',
    'twentyonex://login/callback?code=a&state=b',
    'https://oauth/callback?code=a&state=b',
    'not a url'
  ])('rejects %s', (url) => {
    expect(parseOAuthCallbackUrl(url)).toBeNull()
  })
})

describe('Linear redirect URI', () => {
  const config = { client_id: 'id', client_secret: 'secret', scope: 'read' }

  it('defaults to twentyonex://oauth/callback', () => {
    expect(oauthRedirectUri(undefined)).toBe(OAUTH_CALLBACK_URL)
    expect(oauthRedirectUri('https://evil.example/callback')).toBe(OAUTH_CALLBACK_URL)
    const url = new URL(new LinearProvider().generateAuthUrl(config, 'state', 'challenge'))
    expect(url.searchParams.get('redirect_uri')).toBe(OAUTH_CALLBACK_URL)
  })

  it('keeps the legacy nuanu:// URI for a source that selected it', () => {
    const url = new URL(new LinearProvider().generateAuthUrl({ ...config, redirect_uri: LEGACY_OAUTH_CALLBACK_URL }, 'state', 'challenge'))
    expect(url.searchParams.get('redirect_uri')).toBe(LEGACY_OAUTH_CALLBACK_URL)
  })
})
