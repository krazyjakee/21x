import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { readProductionStdinDescriptor } from './production-stdio'
import { PRODUCTION_DESCRIPTOR_MAX_BYTES, type ProductionLaunchDescriptor } from '../shared/production-bootstrap'

function descriptor(): ProductionLaunchDescriptor {
  const root = '/private-🚀'
  return { version: 1, kind: 'production-private-launch', launchId: 'launch_fixture_001', profileId: 'synthetic-profile',
    profileIntent: 'create-new', buildIdentity: 'production-fixture', resourceManifestSha256: 'a'.repeat(64),
    paths: { profileRoot: `${root}/profile`, workspaceRoot: `${root}/workspaces`, attachmentRoot: `${root}/attachments`,
      reposRoot: `${root}/repos`, resourceRoot: `${root}/resources`, tempRoot: `${root}/temp` },
    capabilities: { externalUrls: 'unsupported', notifications: 'unsupported', energy: 'unsupported', ui: 'unsupported', voice: 'unsupported',
      configuredMcp: 'disabled', managedTaskMcp: 'disabled', connectors: 'disabled' } }
}
describe('inherited private stdin bootstrap prefix', () => {
  it('preserves every pipelined RPC byte at every descriptor split, including UTF-8 splits', async () => {
    const value = descriptor(), bytes = Buffer.from(JSON.stringify(value) + '\n')
    const rpc = Buffer.from('{"kind":"request","requestId":"host:1"}\nsecond frame\n')
    for (let split = 0; split <= bytes.length; split++) {
      const input = new PassThrough(), result = readProductionStdinDescriptor(input)
      input.write(bytes.subarray(0, split))
      await new Promise<void>(resolve => setImmediate(resolve))
      input.write(Buffer.concat([bytes.subarray(split), rpc]))
      expect(await result).toEqual(value)
      expect(input.destroyed).toBe(false)
      expect(input.read()).toEqual(rpc)
      expect(input.listenerCount('readable')).toBe(0)
      expect(input.listenerCount('end')).toBe(0)
      expect(input.listenerCount('error')).toBe(0)
      input.destroy()
    }
  })
  it('accepts the exact descriptor byte bound and leaves the stream available to the peer', async () => {
    const input = new PassThrough(), result = readProductionStdinDescriptor(input), json = JSON.stringify(descriptor())
    input.write(json + ' '.repeat(PRODUCTION_DESCRIPTOR_MAX_BYTES - Buffer.byteLength(json)) + '\n')
    expect(await result).toEqual(descriptor()); expect(input.destroyed).toBe(false); input.destroy()
  })
  it('refuses an over-limit unterminated prefix before engine import and closes the private input', async () => {
    const input = new PassThrough(), result = readProductionStdinDescriptor(input)
    const refused = expect(result).rejects.toThrow('DESCRIPTOR_TOO_LARGE')
    input.write(Buffer.alloc(PRODUCTION_DESCRIPTOR_MAX_BYTES + 1, 32)); await refused
    expect(input.destroyed).toBe(true)
  })
  it.each(['eof', 'invalid-json', 'invalid-utf8', 'unknown-field', 'error'] as const)('refuses %s and retires bootstrap listeners', async mode => {
    const input = new PassThrough(), result = readProductionStdinDescriptor(input), refused = expect(result).rejects.toThrow()
    if (mode === 'eof') input.end(JSON.stringify(descriptor()))
    else if (mode === 'invalid-json') input.write('{not-json}\n')
    else if (mode === 'invalid-utf8') input.write(Buffer.from([0xff, 10]))
    else if (mode === 'unknown-field') input.write(JSON.stringify({ ...descriptor(), privateCanary: 'refuse' }) + '\n')
    else input.destroy(new Error('controlled pipe loss'))
    await refused
    expect(input.destroyed).toBe(true)
    expect(input.listenerCount('readable')).toBe(0); expect(input.listenerCount('end')).toBe(0); expect(input.listenerCount('error')).toBe(0)
  })
})
