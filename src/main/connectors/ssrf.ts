import { lookup as dnsLookup } from 'dns/promises'
import { isIP } from 'net'
import { SsrfBlockedError } from './piece-host/errors'

export { SsrfBlockedError }

/**
 * SSRF guard for URL-valued connector props (issue #18).
 *
 * The allowlist declares which props of an action or trigger are URLs
 * (`urlProps`). Before the piece runs, the piece host checks each one:
 * only http(s), and no private, loopback, link-local, CGNAT, multicast or
 * reserved destinations unless that entry sets `allowPrivateNetwork`.
 * Hostnames are resolved and every returned address must pass.
 *
 * Limitation: this validates the configured value, not the socket the piece
 * eventually opens, so DNS rebinding between the check and the request is not
 * covered. Pieces with free-form URL props should stay off the allowlist until
 * the host routes their HTTP through a pinned-address agent.
 */

export type AddressClass =
  | 'public'
  | 'private'
  | 'loopback'
  | 'link-local'
  | 'unspecified'
  | 'multicast'
  | 'reserved'
  | 'carrier-grade-nat'

export interface SsrfPolicy {
  /** Permit private/loopback/link-local destinations (e.g. a self-hosted server on the LAN). */
  allowPrivateNetwork?: boolean
  /** Protocols a URL may use. Default: http: and https:. */
  allowedProtocols?: string[]
}

export type HostLookup = (hostname: string) => Promise<string[]>

export const defaultHostLookup: HostLookup = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true })
  return results.map((r) => r.address)
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
}

function inV4(ip: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ip & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0
}

export function classifyIPv4(ip: string): AddressClass {
  const n = ipv4ToInt(ip)
  if (inV4(n, '0.0.0.0', 8)) return 'unspecified'
  if (inV4(n, '127.0.0.0', 8)) return 'loopback'
  if (inV4(n, '10.0.0.0', 8) || inV4(n, '172.16.0.0', 12) || inV4(n, '192.168.0.0', 16)) return 'private'
  if (inV4(n, '169.254.0.0', 16)) return 'link-local'
  if (inV4(n, '100.64.0.0', 10)) return 'carrier-grade-nat'
  if (inV4(n, '224.0.0.0', 4)) return 'multicast'
  if (
    inV4(n, '192.0.0.0', 24) ||
    inV4(n, '192.0.2.0', 24) ||
    inV4(n, '198.18.0.0', 15) ||
    inV4(n, '198.51.100.0', 24) ||
    inV4(n, '203.0.113.0', 24) ||
    inV4(n, '240.0.0.0', 4)
  ) {
    return 'reserved'
  }
  return 'public'
}

/** Expands an IPv6 address (no zone id) to eight 16-bit groups, or null when malformed. */
function expandIPv6(ip: string): number[] | null {
  let addr = ip
  let tail: number[] = []
  const lastColon = addr.lastIndexOf(':')
  const maybeV4 = addr.slice(lastColon + 1)
  if (maybeV4.includes('.')) {
    if (isIP(maybeV4) !== 4) return null
    const n = ipv4ToInt(maybeV4)
    tail = [(n >>> 16) & 0xffff, n & 0xffff]
    addr = addr.slice(0, lastColon + 1) + '0'
    // The placeholder '0' occupies one group; drop it after expansion.
  }
  const halves = addr.split('::')
  if (halves.length > 2) return null
  const parse = (s: string): number[] => (s === '' ? [] : s.split(':').map((g) => parseInt(g, 16)))
  const head = parse(halves[0])
  const rest = halves.length === 2 ? parse(halves[1]) : []
  const targetGroups = tail.length ? 7 : 8
  let groups: number[]
  if (halves.length === 2) {
    const fill = targetGroups - head.length - rest.length
    if (fill < 0) return null
    groups = [...head, ...new Array(fill).fill(0), ...rest]
  } else {
    groups = head
  }
  if (tail.length) groups = [...groups.slice(0, 6), ...tail]
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null
  return groups
}

export function classifyIPv6(ip: string): AddressClass {
  const groups = expandIPv6(ip.split('%')[0])
  if (!groups) return 'reserved'
  if (groups.every((g) => g === 0)) return 'unspecified'
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return 'loopback'
  const embeddedV4 = (): string => `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the embedded address.
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    return classifyIPv4(embeddedV4())
  }
  // NAT64 well-known prefix 64:ff9b::/96.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return classifyIPv4(embeddedV4())
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return 'private'
  if ((groups[0] & 0xffc0) === 0xfe80) return 'link-local'
  if ((groups[0] & 0xff00) === 0xff00) return 'multicast'
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return 'reserved'
  return 'public'
}

export function classifyAddress(ip: string): AddressClass {
  const version = isIP(ip)
  if (version === 4) return classifyIPv4(ip)
  if (version === 6) return classifyIPv6(ip)
  return 'reserved'
}

/**
 * Throws SsrfBlockedError unless `raw` is an http(s) URL whose host resolves
 * only to public addresses (or the policy allows private networks).
 */
export async function assertSafeUrl(
  prop: string,
  raw: unknown,
  policy: SsrfPolicy = {},
  lookup: HostLookup = defaultHostLookup
): Promise<void> {
  if (typeof raw !== 'string' || raw.trim() === '') throw new SsrfBlockedError(prop, 'not a URL')
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new SsrfBlockedError(prop, 'not a valid URL')
  }
  const protocols = policy.allowedProtocols ?? ['http:', 'https:']
  if (!protocols.includes(url.protocol)) throw new SsrfBlockedError(prop, `protocol ${url.protocol} is not allowed`)
  if (url.username || url.password) throw new SsrfBlockedError(prop, 'URLs with embedded credentials are not allowed')

  if (policy.allowPrivateNetwork) return

  // WHATWG URL already normalises decimal/hex/octal IPv4 forms to dotted quads.
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) throw new SsrfBlockedError(prop, 'loopback host')

  let addresses: string[]
  if (isIP(host)) {
    addresses = [host]
  } else {
    try {
      addresses = await lookup(host)
    } catch {
      throw new SsrfBlockedError(prop, `could not resolve ${host}`)
    }
    if (addresses.length === 0) throw new SsrfBlockedError(prop, `could not resolve ${host}`)
  }
  for (const address of addresses) {
    const cls = classifyAddress(address)
    if (cls !== 'public') throw new SsrfBlockedError(prop, `${host} resolves to a ${cls} address`)
  }
}

/** Checks every declared URL prop that has a value. Absent optional props are skipped. */
export async function assertSafeUrlProps(
  propsValue: Record<string, unknown>,
  urlProps: readonly string[] | undefined,
  policy: SsrfPolicy = {},
  lookup: HostLookup = defaultHostLookup
): Promise<void> {
  for (const prop of urlProps ?? []) {
    const value = propsValue[prop]
    if (value === undefined || value === null || value === '') continue
    await assertSafeUrl(prop, value, policy, lookup)
  }
}
