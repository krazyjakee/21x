/**
 * The fork's identity in one place: the product name, the database file, the
 * deep-link scheme and the name the app gives when it talks to MCP servers and
 * agent CLIs.
 *
 * The fork was called 20x until the rename to 21x (issue #25). The LEGACY_*
 * values exist only so an upgrade keeps the user's data and OAuth callbacks
 * keep working for one release. Nothing here imports electron, so the tests can
 * use it directly.
 */

export const APP_NAME = '21x'

/** Name sent as `clientInfo.name` to MCP servers and agent CLIs. */
export const CLIENT_NAME = APP_NAME

/** The SQLite database file inside Electron's userData directory. */
export const DB_FILE_NAME = '21x.db'

/** The database file name used before the rename. */
export const LEGACY_DB_FILE_NAME = 'pf-desktop.db'

/**
 * Earlier product names. Electron derives userData from the product name, so
 * each of these is a sibling directory of the current userData that an upgrade
 * may need to copy data from.
 */
export const LEGACY_PRODUCT_NAMES: readonly string[] = ['20x']

/** The deep-link scheme, as in twentyonex://oauth/callback. */
export const DEEP_LINK_SCHEME = 'twentyonex'

/**
 * Schemes still registered and handled for one release after the rename, so an
 * OAuth app whose redirect URI still says nuanu:// keeps completing.
 * TODO(#25): remove after the first release that ships the twentyonex scheme.
 */
export const LEGACY_DEEP_LINK_SCHEMES: readonly string[] = ['nuanu']

export const DEEP_LINK_SCHEMES: readonly string[] = [DEEP_LINK_SCHEME, ...LEGACY_DEEP_LINK_SCHEMES]

export const OAUTH_CALLBACK_URL = `${DEEP_LINK_SCHEME}://oauth/callback`
export const LEGACY_OAUTH_CALLBACK_URL = `${LEGACY_DEEP_LINK_SCHEMES[0]}://oauth/callback`

/**
 * The redirect URI to send to a custom-scheme OAuth provider. It must match
 * what the user registered with the provider, so a source that still has the
 * legacy nuanu:// URI selected keeps using it; everything else gets the current
 * one.
 */
export function oauthRedirectUri(configured: unknown): string {
  return configured === LEGACY_OAUTH_CALLBACK_URL ? LEGACY_OAUTH_CALLBACK_URL : OAUTH_CALLBACK_URL
}

/**
 * Parses an OAuth deep link. Accepts the current scheme and the legacy ones;
 * anything that is not <scheme>://oauth/callback returns null. `code` and
 * `state` are null when the URL lacks them.
 */
export function parseOAuthCallbackUrl(url: string): { code: string | null; state: string | null } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (!DEEP_LINK_SCHEMES.includes(scheme)) return null
  if (parsed.hostname !== 'oauth' || parsed.pathname !== '/callback') return null
  return { code: parsed.searchParams.get('code'), state: parsed.searchParams.get('state') }
}

