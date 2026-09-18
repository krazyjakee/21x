import https from 'https'

const TLS_ENV = 'NODE_TLS_REJECT_UNAUTHORIZED'

/**
 * Keeps certificate verification on inside the piece host.
 *
 * pieces-common's sendRequest() sets NODE_TLS_REJECT_UNAUTHORIZED="0" right
 * before every request, which Node reads at connection time, so the host
 * would accept any certificate for the provider's API and a man-in-the-middle
 * could read the piece's credentials. The env object cannot be made read-only,
 * so the guard sits on the two paths a request can take instead: the global
 * fetch (undici) and https.globalAgent (axios). Each call clears the override
 * before the connection is made.
 *
 * Returns the previous fetch so tests can restore it.
 */
export function installTlsGuard(target: { fetch: typeof globalThis.fetch } = globalThis): typeof globalThis.fetch {
  const original = target.fetch
  const guarded: typeof globalThis.fetch = (input, init) => {
    clearTlsOverride()
    return original(input, init)
  }
  target.fetch = guarded
  // An explicit agent option wins over the env check in tls.connect.
  https.globalAgent.options.rejectUnauthorized = true
  return original
}

/** Drops an in-flight "0" so tls.connect verifies the peer. Never sets any other value. */
export function clearTlsOverride(): void {
  if (process.env[TLS_ENV] === '0') delete process.env[TLS_ENV]
}
