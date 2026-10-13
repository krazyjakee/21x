import { describe, expect, it, vi } from 'vitest'
import type { CodingAgentAdapter, SessionConfig } from '../main/adapters/coding-agent-adapter'
import { ProductionAdapters } from './production-adapters'

function held<T>() {
  let finish!: (value: T) => void
  const promise = new Promise<T>(resolve => { finish = resolve })
  return { promise, finish }
}

function fixture() {
  const source = { createSession: vi.fn(async () => 'native'), resumeSession: vi.fn(async () => []),
    sendPrompt: vi.fn(async () => {}), destroySession: vi.fn(async () => {}) }
  const owner = new ProductionAdapters()
  const adapter = owner.wrap(source as unknown as CodingAgentAdapter)!
  const config: SessionConfig = { agentId: 'fixture-agent', taskId: 'fixture-task', workspaceDir: '/fixture', model: 'fixture' }
  return { source, owner, adapter, config }
}

describe('production adapter cleanup acknowledgement', () => {
  it('joins a late accepted create, destroys its exact identity, and sends no prompt', async () => {
    const { source, owner, adapter, config } = fixture()
    const create = held<string>(), destroy = held<void>()
    source.createSession.mockImplementation(() => create.promise)
    source.destroySession.mockImplementation(() => destroy.promise)
    const creating = adapter.createSession(config)
    owner.shutdown()
    let closed = false
    const close = owner.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    create.finish('accepted-late')
    expect(await creating).toBe('accepted-late')
    await vi.waitFor(() => expect(source.destroySession).toHaveBeenCalledWith('accepted-late', config))
    expect(closed).toBe(false)
    destroy.finish()
    await close
    expect(source.createSession).toHaveBeenCalledOnce()
    expect(source.sendPrompt).not.toHaveBeenCalled()
    await expect(adapter.createSession(config)).rejects.toThrow('PRODUCTION_ADAPTER_CLOSED')
  })

  it('retains a refused destroy and retries only cleanup after the manager loses its handle', async () => {
    const { source, owner, adapter, config } = fixture()
    await adapter.createSession(config)
    source.destroySession.mockRejectedValue(new Error('controlled refusal'))
    await expect(adapter.destroySession('native', config)).rejects.toThrow('controlled refusal')
    await expect(owner.close()).rejects.toThrow('PRODUCTION_ADAPTER_CLEANUP_FAILED')
    source.destroySession.mockResolvedValue(undefined)
    await owner.close()
    expect(source.destroySession).toHaveBeenCalledTimes(3)
    expect(source.createSession).toHaveBeenCalledOnce()
    expect(source.sendPrompt).not.toHaveBeenCalled()
    await owner.close()
    expect(source.destroySession).toHaveBeenCalledTimes(3)
  })

  it('joins concurrent cleanup of one resumed identity and binds methods to the real instance', async () => {
    const { source, owner, adapter, config } = fixture()
    const destroy = held<void>()
    source.destroySession.mockImplementation(() => destroy.promise)
    await adapter.resumeSession('resumed', config)
    const first = adapter.destroySession('resumed', config)
    const second = adapter.destroySession('resumed', config)
    const close = owner.close()
    await vi.waitFor(() => expect(source.destroySession).toHaveBeenCalledOnce())
    destroy.finish()
    await Promise.all([first, second, close])
    expect(source.resumeSession).toHaveBeenCalledOnce()
  })
})
