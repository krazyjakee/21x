/** Internal browser boundary; no application capability is granted to remote pages. */
export const BROWSER_POLICY_LIMITS = {
  panels: 128,
  sessions: 128,
  operations: 128,
  tasksPerPanel: 128,
  requestBytes: 64 * 1024,
  urlCharacters: 8192
} as const

export const BROWSER_POLICY_ERRORS = {
  INVALID_ARGUMENTS: 'Invalid browser operation arguments.',
  NAVIGATION_DENIED: 'Browser navigation is not allowed.',
  NOT_AUTHORIZED: 'Browser operation is not authorized.',
  PANEL_UNAVAILABLE: 'The browser panel is unavailable.',
  AMBIGUOUS_PANEL: 'Choose an explicitly linked browser panel.',
  APPROVAL_REQUIRED: 'Browser operation requires approval.',
  UNSUPPORTED_OPERATION: 'Browser operation is unsupported.',
  CAPACITY_REACHED: 'Browser operation capacity has been reached.'
} as const

export class BrowserPolicyError extends Error {
  constructor(readonly code: keyof typeof BROWSER_POLICY_ERRORS) {
    super(BROWSER_POLICY_ERRORS[code])
    this.name = 'BrowserPolicyError'
  }
}

export function isBrowserIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value)
}

/** HTTP(S) intranet/localhost sites remain supported; application/API origins are explicit exclusions. */
export class BrowserNavigationPolicy {
  private readonly excludedOrigins = new Set<string>()

  constructor(applicationOrigins: readonly string[] = []) {
    for (const origin of applicationOrigins) {
      const url = this.parse(origin)
      if (url.pathname !== '/' || url.search || url.hash) throw new BrowserPolicyError('INVALID_ARGUMENTS')
      this.excludedOrigins.add(this.originKey(url))
    }
  }

  normalize(value: unknown): string {
    const url = this.parse(value)
    // These are native transport origins, independent of the developer server's port.
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
    if (hostname === 'tauri.localhost' || hostname === 'ipc.localhost' || this.excludedOrigins.has(this.originKey(url))) {
      throw new BrowserPolicyError('NAVIGATION_DENIED')
    }
    return url.href
  }

  allows(value: unknown): boolean {
    try { this.normalize(value); return true } catch { return false }
  }

  private parse(value: unknown): URL {
    if (typeof value !== 'string' || value.length === 0 || value.length > BROWSER_POLICY_LIMITS.urlCharacters ||
      /[\u0000-\u0020\u007f\\]/.test(value) || !/^https?:\/\/[^/]/i.test(value) ||
      /^https?:\/\/[^/?#]*@/i.test(value)) {
      throw new BrowserPolicyError('NAVIGATION_DENIED')
    }
    try {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
        throw new BrowserPolicyError('NAVIGATION_DENIED')
      }
      return url
    } catch { throw new BrowserPolicyError('NAVIGATION_DENIED') }
  }

  private originKey(url: URL): string {
    return `${url.protocol}//${url.hostname.toLowerCase().replace(/\.$/, '')}${url.port ? ':' + url.port : ''}`
  }
}
