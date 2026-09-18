import { describe, expect, it } from 'vitest'
import { assertSafeUrl, classifyAddress, SsrfBlockedError, type HostLookup } from './ssrf'

const lookup: HostLookup = async (host) => {
  const table: Record<string, string[]> = {
    'public.example': ['93.184.216.34'],
    'mixed.example': ['93.184.216.34', '192.168.1.10'],
    'v6-local.example': ['fe80::1']
  }
  if (table[host]) return table[host]
  throw new Error('ENOTFOUND')
}

describe('classifyAddress', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.20.0.1', 'private'],
    ['192.168.0.1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['100.64.0.1', 'carrier-grade-nat'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fd00::1', 'private'],
    ['fe80::abcd', 'link-local'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['64:ff9b::a00:1', 'private'],
    ['2606:4700:4700::1111', 'public']
  ])('%s is %s', (ip, expected) => {
    expect(classifyAddress(ip)).toBe(expected)
  })
})

describe('assertSafeUrl', () => {
  const blocked = (url: string, policy = {}): Promise<void> =>
    expect(assertSafeUrl('url', url, policy, lookup)).rejects.toBeInstanceOf(SsrfBlockedError)

  it('allows public http(s) destinations', async () => {
    await expect(assertSafeUrl('url', 'https://public.example/path', {}, lookup)).resolves.toBeUndefined()
    await expect(assertSafeUrl('url', 'http://8.8.8.8/', {}, lookup)).resolves.toBeUndefined()
  })

  it('blocks non-http(s) protocols and embedded credentials', async () => {
    await blocked('file:///etc/passwd')
    await blocked('ftp://public.example/')
    await blocked('javascript:alert(1)')
    await blocked('https://user:pass@public.example/')
  })

  it('blocks loopback, private and link-local hosts, including encoded forms', async () => {
    await blocked('http://localhost:3000/')
    await blocked('http://api.localhost/')
    await blocked('http://127.0.0.1/')
    await blocked('http://2130706433/')
    await blocked('http://0x7f.0.0.1/')
    await blocked('http://[::1]/')
    await blocked('http://[::ffff:127.0.0.1]/')
    await blocked('http://169.254.169.254/latest/meta-data/')
    await blocked('http://mixed.example/')
    await blocked('http://v6-local.example/')
    await blocked('http://unresolvable.example/')
  })

  it('permits private networks only when the allowlist entry opts in', async () => {
    await expect(assertSafeUrl('url', 'http://192.168.1.10/', { allowPrivateNetwork: true }, lookup)).resolves.toBeUndefined()
    await blocked('file:///etc/passwd', { allowPrivateNetwork: true })
  })
})
