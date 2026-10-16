import { describe, expect, it, vi } from 'vitest'
import { ProductionWorkspaceProcessOwner } from './production-workspace-process-owner'
import type { WorkspaceCleanupObserver } from '../shared/workspace-native-callbacks'
const leaseId = '8bac4cd9-4ef5-4a20-b109-89d28df6857b'
function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
const observer: WorkspaceCleanupObserver = async request => request.action === 'acquire' ? { status: 'idle', leaseId } : request.action === 'release' ? { released: true } : { status: 'idle' }
describe('captured production workspace process exclusion', () => {
  it('holds an exact task lease through fresh checks, actual effect and native release', async () => {
    const observe = vi.fn(observer), owner = new ProductionWorkspaceProcessOwner('/synthetic/workspaces', observe), current = vi.fn()
    await owner.run(['task-one'], async () => {
      expect(owner.inflightCount).toBe(1)
      await owner.assertIdleWorkspace('task-one', '/synthetic/workspaces/task-one')
      await expect(owner.assertIdleWorkspace('foreign', '/synthetic/workspaces/foreign')).rejects.toThrow('SCOPE_CHANGED')
      await expect(owner.assertIdleWorkspace('task-one', '/foreign/task-one')).rejects.toThrow('SCOPE_CHANGED')
    }, current, new AbortController().signal)
    expect(observe.mock.calls.map(([request]) => request.action)).toEqual(['acquire', 'check', 'release'])
    expect(current).toHaveBeenCalled(); expect(owner.inflightCount).toBe(0); await owner.close()
  })
  it.each(['busy', 'unknown'] as const)('refuses %s observation without running effects or fabricating a ticket', async status => {
    const observe = vi.fn<WorkspaceCleanupObserver>(async () => ({ status })), effect = vi.fn(), owner = new ProductionWorkspaceProcessOwner('/synthetic/workspaces', observe)
    await expect(owner.run(['task-one'], effect, () => {}, new AbortController().signal)).rejects.toThrow(status === 'busy' ? 'PROCESS_NOT_IDLE' : 'OBSERVATION_UNAVAILABLE')
    expect(effect).not.toHaveBeenCalled(); expect(observe).toHaveBeenCalledOnce(); expect(owner.inflightCount).toBe(0); await owner.close()
  })
  it('rejects a caller-supplied idle assertion and uncertain acquisition retains the drain barrier', async () => {
    const owner = new ProductionWorkspaceProcessOwner('/synthetic/workspaces', async () => ({ status: 'idle' })), effect = vi.fn()
    await expect(owner.run(['task-one'], effect, () => {}, new AbortController().signal)).rejects.toThrow('PROCESS_RESULT_INVALID')
    expect(effect).not.toHaveBeenCalled(); expect(() => owner.assertOtherWorkAllowed()).toThrow('BUSY')
    await expect(owner.close()).rejects.toThrow('DRAIN_INCOMPLETE')
  })
  it('retains a late acquisition and its release after cancellation and shutdown deadline', async () => {
    const acquire = held(), entered = held(), release = held(), releasing = held(), controller = new AbortController(), effect = vi.fn()
    const observe = vi.fn<WorkspaceCleanupObserver>(async request => {
      if (request.action === 'acquire') { entered.release(); await acquire.promise; return { status: 'idle', leaseId } }
      if (request.action === 'release') { expect(request.leaseId).toBe(leaseId); releasing.release(); await release.promise; return { released: true } }
      return { status: 'idle' }
    })
    const owner = new ProductionWorkspaceProcessOwner('/synthetic/workspaces', observe)
    const result = owner.run(['task-one'], effect, () => {}, controller.signal).catch(error => error)
    await entered.promise; controller.abort()
    expect(() => owner.assertOtherWorkAllowed()).toThrow('BUSY')
    await expect(owner.close(5)).rejects.toThrow('DRAIN_INCOMPLETE')
    acquire.release(); await releasing.promise
    expect(owner.inflightCount).toBe(1); expect(effect).not.toHaveBeenCalled()
    release.release()
    const failure = await result
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error('Expected a cancelled cleanup Error')
    expect(failure.message).toBe('WORKSPACE_CLEANUP_CANCELLED'); await owner.close()
    expect(owner.inflightCount).toBe(0)
  })
  it('refuses other owners during the effect and retains failed cleanup ownership', async () => {
    const gate = held(), entered = held(), owner = new ProductionWorkspaceProcessOwner('/synthetic/workspaces', async request => {
      if (request.action === 'release') throw new Error('private error')
      return request.action === 'acquire' ? { status: 'idle', leaseId } : { status: 'idle' }
    })
    const result = owner.run(['task-one'], async () => { entered.release(); await gate.promise }, () => {}, new AbortController().signal).catch(error => error)
    await entered.promise
    expect(() => owner.assertOtherWorkAllowed()).toThrow('BUSY')
    await expect(owner.run(['task-two'], async () => {}, () => {}, new AbortController().signal)).rejects.toThrow('BUSY')
    gate.release()
    const failure = await result
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error('Expected a cleanup drain Error')
    expect(failure.message).toBe('WORKSPACE_CLEANUP_PROCESS_DRAIN_INCOMPLETE')
    expect(owner.inflightCount).toBe(1); await expect(owner.close()).rejects.toThrow('DRAIN_INCOMPLETE')
  })
})
