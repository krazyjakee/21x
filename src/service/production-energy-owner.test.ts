import { afterEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from '../main/agent-manager-core'
import { ProductionEnergyOwner, PRODUCTION_ENERGY_LIMITS } from './production-energy-owner'

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
afterEach(() => { vi.restoreAllMocks() })

describe('captured production sleep intent ownership', () => {
  it('aggregates bounded local tickets, ignores foreign stops and preserves later runtime starts after healthy release', async () => {
    const setActive = vi.fn(async (active: boolean) => active), owner = new ProductionEnergyOwner({ assertCurrent() {}, setActive })
    const first = owner.host.start(), second = owner.host.start()
    expect(Number.isSafeInteger(first)).toBe(true); expect(second).toBeGreaterThan(first)
    await vi.waitFor(() => expect(setActive).toHaveBeenCalledTimes(1)); expect(setActive).toHaveBeenLastCalledWith(true)
    owner.host.stop(first); owner.host.stop(-1); owner.host.stop(123456); await Promise.resolve(); expect(setActive).toHaveBeenCalledTimes(1)
    owner.host.stop(second); await vi.waitFor(() => expect(setActive).toHaveBeenLastCalledWith(false))
    const third = owner.host.start(); await vi.waitFor(() => expect(setActive).toHaveBeenLastCalledWith(true)); expect(third).toBeGreaterThan(second)
    owner.host.stop(third); await owner.close(); expect(setActive.mock.calls.filter(([active]) => active)).toHaveLength(2); expect(owner.inflightCount).toBe(0)
  })
  it('coalesces rapid preflight start/stop into release only and uses no public/native cookie ticket', async () => {
    const setActive = vi.fn(async (active: boolean) => active), owner = new ProductionEnergyOwner({ assertCurrent() {}, setActive })
    for (let i = 0; i < 20; i++) { const id = owner.host.start(); owner.host.stop(id) }
    await owner.close(); expect(setActive.mock.calls).toEqual([[false]]); expect(() => owner.host.start()).toThrow('ENERGY_CLOSED')
  })
  it('allows only sixteen concurrent intent tickets without issuing additional native activations', async () => {
    const setActive = vi.fn(async (active: boolean) => active), owner = new ProductionEnergyOwner({ assertCurrent() {}, setActive })
    const ids = Array.from({ length: PRODUCTION_ENERGY_LIMITS.tickets }, () => owner.host.start())
    expect(new Set(ids).size).toBe(16); expect(() => owner.host.start()).toThrow('ENERGY_CAPACITY')
    await vi.waitFor(() => expect(setActive).toHaveBeenCalledTimes(1)); for (const id of ids) owner.host.stop(id)
    await owner.close(); expect(setActive.mock.calls).toEqual([[true], [false]])
  })
  it('keeps one actual raw call while stop/restart races and serializes its release before new activation', async () => {
    const requests: Array<{ active: boolean; receipt: ReturnType<typeof deferred<boolean>> }> = []
    const owner = new ProductionEnergyOwner({ assertCurrent() {}, setActive: active => { const receipt = deferred<boolean>(); requests.push({ active, receipt }); return receipt.promise } })
    const first = owner.host.start(); await vi.waitFor(() => expect(requests).toHaveLength(1)); owner.host.stop(first); owner.host.start()
    expect(requests.map(row => row.active)).toEqual([true]); expect(owner.inflightCount).toBe(1)
    requests[0]!.receipt.resolve(true); await vi.waitFor(() => expect(requests).toHaveLength(2)); expect(requests[1]!.active).toBe(false)
    requests[1]!.receipt.resolve(false); await vi.waitFor(() => expect(requests).toHaveLength(3)); expect(requests[2]!.active).toBe(true)
    const closing = owner.close(); requests[2]!.receipt.resolve(true); await vi.waitFor(() => expect(requests).toHaveLength(4)); expect(requests[3]!.active).toBe(false)
    requests[3]!.receipt.resolve(false); await closing; expect(owner.inflightCount).toBe(0)
  })
  it('joins a late activation and final release through a public close deadline without treating timeout as raw closure', async () => {
    const activation = deferred<boolean>(), release = deferred<boolean>(), setActive = vi.fn((active: boolean) => active ? activation.promise : release.promise)
    const owner = new ProductionEnergyOwner({ assertCurrent() {}, setActive }); owner.host.start(); await vi.waitFor(() => expect(setActive).toHaveBeenCalledWith(true))
    await expect(owner.close(5)).rejects.toMatchObject({ code: 'ENERGY_DRAIN_INCOMPLETE' }); expect(owner.inflightCount).toBe(1); expect(setActive).toHaveBeenCalledTimes(1)
    activation.resolve(true); await vi.waitFor(() => expect(setActive).toHaveBeenCalledTimes(2)); expect(setActive).toHaveBeenLastCalledWith(false)
    await expect(owner.close(5)).rejects.toMatchObject({ code: 'ENERGY_DRAIN_INCOMPLETE' }); expect(owner.inflightCount).toBe(1)
    release.resolve(false); await owner.close(); expect(owner.inflightCount).toBe(0); expect(setActive.mock.calls).toEqual([[true], [false]])
  })
  it('does not retry a refused activation while tickets remain, but a fresh aggregate demand is permitted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), setActive = vi.fn(async (_active: boolean) => false)
    const owner = new ProductionEnergyOwner({ assertCurrent() {}, setActive }), first = owner.host.start()
    await vi.waitFor(() => expect(setActive).toHaveBeenCalledTimes(1)); const second = owner.host.start(); await Promise.resolve(); expect(setActive).toHaveBeenCalledTimes(1)
    owner.host.stop(first); owner.host.stop(second); const third = owner.host.start(); await vi.waitFor(() => expect(setActive).toHaveBeenCalledTimes(3))
    owner.host.stop(third); await owner.close(); expect(setActive.mock.calls.filter(([active]) => active)).toHaveLength(2); expect(warn.mock.calls.flat().join(' ')).not.toContain('token')
  })
  it('never blindly retries uncertain true and follows its error with owned false using fixed diagnostics', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), setActive = vi.fn(async (active: boolean) => { if (active) throw new Error('private native token and path'); return false })
    const owner = new ProductionEnergyOwner({ assertCurrent() {}, setActive }); owner.host.start()
    await vi.waitFor(() => expect(setActive).toHaveBeenCalledTimes(2)); await Promise.resolve(); expect(setActive.mock.calls).toEqual([[true], [false]])
    expect(warn.mock.calls.flat().join(' ')).not.toContain('private native token'); await owner.close(); expect(setActive.mock.calls.filter(([active]) => active)).toHaveLength(1)
  })
  it.each(['error', 'stillActive', 'malformed'] as const)('retains %s release failure for an explicit false-only retry instead of manufacturing cleanup', async kind => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); let failed = false
    const setActive = vi.fn(async (active: boolean) => {
      if (active) return true
      if (!failed) { failed = true; if (kind === 'error') throw new Error('private cleanup failure'); if (kind === 'malformed') return undefined as never; return true }
      return false
    })
    const owner = new ProductionEnergyOwner({ assertCurrent() {}, setActive }); owner.host.start(); await vi.waitFor(() => expect(setActive).toHaveBeenCalledWith(true))
    await expect(owner.close()).rejects.toMatchObject({ code: 'ENERGY_CLEANUP_FAILED' }); expect(owner.inflightCount).toBe(1); expect(setActive.mock.calls).toEqual([[true], [false]])
    await Promise.resolve(); expect(setActive).toHaveBeenCalledTimes(2); await owner.close(); expect(setActive.mock.calls).toEqual([[true], [false], [false]]); expect(owner.inflightCount).toBe(0)
    await owner.close(); expect(setActive).toHaveBeenCalledTimes(3)
  })
  it('uses captured callbacks and retains release after owner authority is lost during activation', async () => {
    let current = true; const activation = deferred<boolean>(), calls: boolean[] = []
    const options = { assertCurrent() { if (!current) throw new Error('private stale owner') }, setActive: (active: boolean): Promise<boolean> => { calls.push(active); return active ? activation.promise : Promise.resolve(false) } }
    const owner = new ProductionEnergyOwner(options); owner.host.start(); await vi.waitFor(() => expect(calls).toEqual([true]))
    options.setActive = async () => { throw new Error('Replacement must never run') }; current = false; activation.resolve(true)
    await owner.close(); expect(calls).toEqual([true, false]); expect(owner.inflightCount).toBe(0); expect(() => owner.host.start()).toThrow('ENERGY_CLOSED')
  })
})

describe('actual AgentManager session energy intent integration', () => {
  it('keeps the aggregate intent across two real sessions and releases it when the last actual session stops', async () => {
    const db = createPortableTestDb(), root = dirname(dirname(db.getWorkspaceDir('energy-fixture'))), native = vi.fn(async (active: boolean) => active)
    const owner = new ProductionEnergyOwner({ assertCurrent() { if (!db.db.open) throw new Error('Closed profile') }, setActive: native })
    const manager = new AgentManager(db, { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: owner.host, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => new FakeAdapter(), isCodexAppServerAdapter: () => false })
    try {
      const agent = db.createAgent({ name: 'Energy fixture owner', config: { coding_agent: 'opencode', max_parallel_sessions: 2 } })!, first = db.createTask({ title: 'First owned session' })!, second = db.createTask({ title: 'Second owned session' })!
      const one = await manager.requestSession(agent.id, first.id), two = await manager.requestSession(agent.id, second.id)
      expect(one.status).toBe('started'); expect(two.status).toBe('started'); await vi.waitFor(() => expect(native.mock.calls).toEqual([[true]]))
      await manager.stopByTaskId(first.id); expect(native.mock.calls).toEqual([[true]])
      await manager.stopByTaskId(second.id); await vi.waitFor(() => expect(native).toHaveBeenLastCalledWith(false))
      await owner.close(); expect(native.mock.calls.filter(([active]) => active)).toHaveLength(1); expect(owner.inflightCount).toBe(0)
    } finally { await manager.stopAllSessions(); await manager.stopServer(); await owner.close(); db.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
