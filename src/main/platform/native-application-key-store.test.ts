import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nativeCredentialEnvironment, NativeApplicationKeyStore } from './native-application-key-store'

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }))
const helperPath = resolve('trusted-helper')

class Child extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  kill = vi.fn()
}

let child: Child
beforeEach(() => { child = new Child(); mocked.spawn.mockReset().mockReturnValue(child) })

describe('native key-store private bootstrap boundary', () => {
  it('retains only OS/keychain/session environment, dropping API secrets and preload hooks', () => {
    const environment = nativeCredentialEnvironment({ PATH: '/bin', HOME: '/home/fixture', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture', XDG_DATA_HOME: '/fixture', API_TOKEN: 'secret', OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--require injected', ELECTRON_RUN_AS_NODE: '1' })
    expect(environment).toEqual({ PATH: '/bin', HOME: '/home/fixture', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture', XDG_DATA_HOME: '/fixture' })
  })

  it('reads a canonical 32-byte key only from its bounded private response pipe', async () => {
    const store = new NativeApplicationKeyStore(helperPath)
    const pending = store.load('fixture-profile')
    const key = Buffer.alloc(32, 17)
    child.stdout.write(JSON.stringify({ version: 1, ok: true, backend: 'linux-secret-service', key: key.toString('base64') }))
    child.emit('close', 0)
    expect(await pending).toEqual(key)
    expect(mocked.spawn).toHaveBeenCalledWith(helperPath, [], expect.objectContaining({ stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }))
  })

  it('passes key material via stdin without adding it to argv or environment', async () => {
    const store = new NativeApplicationKeyStore(helperPath)
    let input = ''
    child.stdin.on('data', (chunk) => { input += chunk.toString() })
    const key = Buffer.alloc(32, 19)
    const pending = store.create('fixture-profile', key)
    expect(JSON.parse(input)).toMatchObject({ operation: 'create', account: 'fixture-profile', key: key.toString('base64') })
    expect(mocked.spawn.mock.calls[0][1]).toEqual([])
    expect(JSON.stringify(mocked.spawn.mock.calls[0][2])).not.toContain(key.toString('base64'))
    child.stdout.write(JSON.stringify({ version: 1, ok: true, backend: 'linux-secret-service' }))
    child.emit('close', 0)
    await pending
  })

  it.each([
    { version: 1, ok: false, code: 'KEYSTORE_NO_ACCESS', detail: 'secret-provider-text' },
    { version: 1, ok: false, code: 'secret-provider-text' },
    { version: 1, ok: true, backend: 'mock', key: Buffer.alloc(32).toString('base64') },
    { version: 1, ok: true, backend: 'linux-secret-service', key: 'wrong-key' }
  ])('rejects unsafe errors, fake backends and malformed keys without forwarding provider text', async (response) => {
    const pending = new NativeApplicationKeyStore(helperPath).load('fixture')
    child.stdout.write(JSON.stringify(response))
    child.emit('close', response.ok ? 0 : 1)
    await expect(pending).rejects.toThrow(/^KEYSTORE_/)
    try { await pending } catch (error) { expect(String(error)).not.toContain('secret-provider-text') }
  })

  it('rejects oversized output and kills the helper without exposing its bytes', async () => {
    const pending = new NativeApplicationKeyStore(helperPath).load('fixture')
    child.stdout.write(Buffer.alloc(4097, 83))
    await expect(pending).rejects.toThrow('KEYSTORE_PROTOCOL_ERROR')
    expect(child.kill).toHaveBeenCalled()
  })
})
