import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server, type RequestListener } from 'node:http'
import { connect } from 'node:net'
import { SecretBroker, type SecretBrokerSource } from './secret-broker-core'

const fixtureSecrets = [
  { id: 'a', env_var_name: 'FIXTURE_KEY', value: "it's $(fixture) `quoted`\nsecond line" },
  { id: 'b', env_var_name: 'OTHER_KEY', value: 'other fixture' },
  { id: 'bad', env_var_name: 'BAD; command', value: 'never exported' }
]
function source(): SecretBrokerSource {
  return { getSecretsWithValues: vi.fn(ids => fixtureSecrets.filter(secret => ids.includes(secret.id))) } as unknown as SecretBrokerSource
}
const owners: SecretBroker[] = []
function own(db = source(), factory?: (listener: RequestListener) => Server): SecretBroker {
  const owner = new SecretBroker(db, factory)
  owners.push(owner)
  return owner
}
afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.close())); vi.restoreAllMocks() })
const exportsUrl = (port: number, token: string): string => `http://127.0.0.1:${port}/secrets/export?token=${token}`

describe('portable loopback secret broker ownership', () => {
  it('coalesces binds and keeps different listener generations and sources isolated', async () => {
    const factory = vi.fn((listener: RequestListener) => createServer(listener))
    const first = own(source(), factory), second = own()
    const started = first.start()
    expect(first.start()).toBe(started)
    const [port, otherPort] = await Promise.all([started, second.start()])
    expect(factory).toHaveBeenCalledOnce()
    expect(port).not.toBe(otherPort)
    first.register('first', 'agent', ['a'])
    second.register('second', 'agent', ['b'])
    expect((await fetch(exportsUrl(otherPort, 'first'))).status).toBe(403)
    expect((await fetch(exportsUrl(port, 'second'))).status).toBe(403)
    await first.close()
    expect((await fetch(exportsUrl(otherPort, 'second'))).status).toBe(200)
  })

  it('copies session scope, quotes values, filters invalid names and revokes tokens', async () => {
    const owner = own(), port = await owner.start(), ids = ['a', 'bad']
    owner.register('fixture', 'agent', ids)
    ids.push('b')
    const response = await fetch(exportsUrl(port, 'fixture'))
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe("export FIXTURE_KEY='it'\\''s $(fixture) `quoted`\nsecond line'")
    const body = await (await fetch(exportsUrl(port, 'fixture') + '&format=base64')).text()
    expect(body).toBe('FIXTURE_KEY=' + Buffer.from(fixtureSecrets[0].value).toString('base64'))
    owner.unregister('fixture')
    expect((await fetch(exportsUrl(port, 'fixture'))).status).toBe(403)
  })

  it('rejects unauthenticated and unsupported requests before source reads and redacts errors', async () => {
    const db = source(), owner = own(db), port = await owner.start()
    expect((await fetch(exportsUrl(port, 'unknown'))).status).toBe(403)
    expect((await fetch(exportsUrl(port, 'unknown'), { method: 'POST' })).status).toBe(405)
    expect((await fetch(`http://127.0.0.1:${port}/missing`)).status).toBe(404)
    expect(db.getSecretsWithValues).not.toHaveBeenCalled()
    owner.register('fixture', 'agent', ['a'])
    vi.mocked(db.getSecretsWithValues).mockImplementation(() => { throw new Error('fixture credential must stay private') })
    const log = vi.spyOn(console, 'log'), error = vi.spyOn(console, 'error')
    const response = await fetch(exportsUrl(port, 'fixture'))
    expect(response.status).toBe(500)
    expect(await response.text()).toBe('')
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled()
  })

  it('closes an in-flight bind before reporting shutdown complete', async () => {
    const server = createServer(), owner = own(source(), () => server)
    const start = owner.start()
    owner.shutdown()
    await expect(start).rejects.toThrow('SECRET_BROKER_CLOSED')
    await owner.close()
    expect(server.address()).toBeNull()
    expect(owner.port).toBeNull()
    await expect(owner.start()).rejects.toThrow('SECRET_BROKER_CLOSED')
    expect(() => owner.register('late', 'agent', ['a'])).toThrow('SECRET_BROKER_CLOSED')
  })

  it('destroys a partial HTTP connection without allowing a late database read', async () => {
    const db = source(), owner = own(db), port = await owner.start()
    owner.register('fixture', 'agent', ['a'])
    const socket = connect(port, '127.0.0.1')
    socket.on('error', () => {})
    const ended = new Promise<void>(resolve => socket.once('close', () => resolve()))
    await new Promise<void>(resolve => socket.once('connect', resolve))
    socket.write('GET /secrets/export?token=fixture HTTP/1.1\r\n')
    await owner.close()
    await ended
    expect(db.getSecretsWithValues).not.toHaveBeenCalled()
  })

  it('retains the real native-close acknowledgement through a bounded timeout and retry', async () => {
    const server = createServer(), close = server.close.bind(server)
    const owner = own(source(), () => server)
    await owner.start()
    let release!: () => void
    const intercepted = vi.spyOn(server, 'close').mockImplementation(callback => close(error => {
      release = () => callback?.(error)
    }))
    await expect(owner.close(5)).rejects.toThrow('SECRET_BROKER_SHUTDOWN_INCOMPLETE')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(server.address()).toBeNull()
    const retry = owner.close()
    release()
    await retry
    expect(intercepted).toHaveBeenCalledOnce()
  })

  it('retains ownership after a native-close failure and retries the same listener', async () => {
    const server = createServer(), owner = own(source(), () => server)
    const port = await owner.start()
    const intercepted = vi.spyOn(server, 'close').mockImplementationOnce(callback => {
      callback?.(new Error('fixture close failure'))
      return server
    })
    await expect(owner.close()).rejects.toThrow('fixture close failure')
    expect((server.address() as { port: number }).port).toBe(port)
    expect(owner.port).toBeNull()
    await owner.close()
    expect(intercepted).toHaveBeenCalledTimes(2)
    expect(server.address()).toBeNull()
  })

  it('redacts bind errors and can still join the failed listener', async () => {
    const server = createServer(), owner = own(source(), () => server)
    vi.spyOn(server, 'listen').mockImplementation(() => { throw new Error('sensitive fixture bind error') })
    await expect(owner.start()).rejects.toThrow('SECRET_BROKER_START_FAILED')
    await owner.close()
    expect(owner.port).toBeNull()
    const failedFactory = own(source(), () => { throw new Error('sensitive fixture factory error') })
    await expect(failedFactory.start()).rejects.toThrow('SECRET_BROKER_START_FAILED')
    await failedFactory.close()
  })

  it('rejects invalid deadlines without closing a live owner', async () => {
    const owner = own(), port = await owner.start()
    await expect(owner.close(0)).rejects.toThrow(RangeError)
    await expect(owner.close(3001)).rejects.toThrow(RangeError)
    expect(owner.port).toBe(port)
  })
})
