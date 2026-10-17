import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { observeAgentProcess } from '../main/adapters/shared/owned-process'
import { PiAdapter } from '../main/adapters/pi-adapter'
import { AcpAdapter } from '../main/adapters/acp-adapter'
import { CodexAppServerAdapter } from '../main/adapters/codex-app-server-adapter'
import { type CodingAgentAdapter, type SessionConfig } from '../main/adapters/coding-agent-adapter'
import { ProductionAdapters } from './production-adapters'
import { AgentManager } from '../main/agent-manager-core'
import { ProductionAgentBackend, type ProductionAgentBackendOptions } from './production-agent-backend'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import type { DesktopCallerContext } from './transport/desktop-registry'

const roots: string[] = []
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const finish of cleanup.splice(0).reverse()) await finish()
  vi.unstubAllEnvs(); vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('raw agent process retirement receipts', () => {
  it('joins concurrent stops, escalates despite killed=true, and waits beyond exit for close', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), { killed: false, kill: vi.fn((_signal: NodeJS.Signals) => { child.killed = true; return true }) })
    const owner = observeAgentProcess(child as unknown as ChildProcess)
    const first = owner.stop(), second = owner.stop()
    expect(first).toBe(second)
    let acknowledged = false
    void first.then(() => { acknowledged = true })
    child.emit('exit', null, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(1000)
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(acknowledged).toBe(false)
    child.emit('close', null, 'SIGKILL')
    await first
    expect(acknowledged).toBe(true)
    await vi.advanceTimersByTimeAsync(10000)
    expect(child.kill).toHaveBeenCalledTimes(2)
  })

  it('refuses an unacknowledged close and retains a late close for retry without signaling a dead child', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => false) })
    const owner = observeAgentProcess(child as unknown as ChildProcess)
    const rejected = expect(owner.stop()).rejects.toThrow('AGENT_PROCESS_CLOSE_UNACKNOWLEDGED')
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    child.emit('close', 0, null)
    await owner.stop()
    expect(child.kill).toHaveBeenCalledTimes(2)
  })
})

function fixture(protocol: 'pi' | 'acp' | 'codex') {
  const root = mkdtempSync(join(tmpdir(), '21x-agent-process-')); roots.push(root)
  const emptyPath = join(root, 'empty-path'); mkdirSync(emptyPath)
  const cli = join(root, 'synthetic-cli.cjs')
  writeFileSync(cli, `#!${process.execPath}\n` + readFileSync(resolve('test/fixtures/agent-rpc-process.cjs'), 'utf8'), { mode: 0o700 })
  vi.stubEnv('HOME', root); vi.stubEnv('PATH', emptyPath); vi.stubEnv('PI_CODING_AGENT_DIR', root)
  vi.stubEnv('TWENTYX_SYNTHETIC_AGENT', '1'); vi.stubEnv('TWENTYX_FIXTURE_PROTOCOL', protocol)
  const receipt = join(root, 'receipt.json'); vi.stubEnv('TWENTYX_FIXTURE_RECEIPT', receipt)
  const config: SessionConfig = { agentId: 'synthetic-agent', taskId: 'synthetic-task', workspaceDir: root,
    authMethod: 'subscription', permissionMode: 'ask', secretEnvVars: { TWENTYX_FIXTURE_SECRET: 'synthetic-only-211' } }
  let adapter: CodingAgentAdapter
  if (protocol === 'pi') {
    const pi = new PiAdapter()
    Object.assign(pi, { piExecutablePath: cli }); adapter = pi
  } else if (protocol === 'acp') {
    const acp = new AcpAdapter('cursor')
    Object.assign(acp, { agentConfig: { command: process.execPath, args: [cli], env: {} } }); adapter = acp
  } else {
    const codex = new CodexAppServerAdapter()
    Object.assign(codex, { codexExecutablePath: cli }); adapter = codex
    cleanup.push(async () => { clearInterval((codex as unknown as { orphanSweepTimer: NodeJS.Timeout }).orphanSweepTimer) })
  }
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  return { root, emptyPath, receipt, config, adapter }
}

// These are controlled protocol children, never installed/account CLIs.
describe.skipIf(process.platform !== 'linux')('actual adapter children with restricted PATH', () => {
  it.each(['pi', 'acp', 'codex'] as const)('%s retains the production owner through real TERM refusal and pipe close', async protocol => {
    const f = fixture(protocol), owner = new ProductionAdapters()
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const unrelatedOwner = observeAgentProcess(unrelated)
    cleanup.push(() => unrelatedOwner.stop())
    await once(unrelated, 'spawn')
    const adapter = owner.wrap(f.adapter)!
    const id = await adapter.createSession(f.config)
    cleanup.push(() => owner.close())
    const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'))
    expect(receipt).toMatchObject({ runtime: process.execPath, path: f.emptyPath, secretInjected: true,
      electron: !!process.versions.electron })
    let stopped = false
    const stop = adapter.destroySession(id, f.config).then(() => { stopped = true })
    await delay(50)
    expect(stopped).toBe(false)
    expect(() => process.kill(receipt.pid, 0)).not.toThrow()
    await stop
    expect(() => process.kill(receipt.pid, 0)).toThrow()
    expect(unrelated.exitCode).toBe(null)
    expect(unrelated.signalCode).toBe(null)
    await owner.close()
  })

  it('joins the actual child after startup rejection before returning a failed create without an ID', async () => {
    const f = fixture('pi'), owner = new ProductionAdapters(), adapter = owner.wrap(f.adapter)!
    cleanup.push(() => owner.close())
    await expect(adapter.createSession({ ...f.config, systemPrompt: 'TWENTYX_SYNTHETIC_CREATE_FAIL' })).rejects.toThrow('Synthetic startup rejection')
    const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'))
    expect(() => process.kill(receipt.pid, 0)).toThrow()
    await owner.close()
  })

  it('uses real manager/service scope for native permission, question, compaction, tool failure and strict abort refusal', async () => {
    const f = fixture('pi'), db = createPortableTestDb(), owner = new ProductionAdapters()
    const databaseRoot = dirname(dirname(db.getWorkspaceDir('fixture'))); roots.push(databaseRoot)
    const manager = new AgentManager(db, { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' },
      energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' },
      createAdapter: () => owner.wrap(f.adapter), isCodexAppServerAdapter: () => false })
    const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'controlled-process-epoch', webviewId: 'main', origin: 'app://synthetic' }
    const backendOptions: ProductionAgentBackendOptions = { manager, database: db, engineEpoch: caller.engineEpoch, assertAvailable() {},
      isTrustedDesktop: identity => identity.origin === caller.origin && identity.webviewId === caller.webviewId,
      canAccessTask: () => true, canAccessProject: () => true, canAccessAgent: () => true }
    let backend = new ProductionAgentBackend(backendOptions)
    cleanup.push(async () => { await backend.close(); await manager.stopAllSessions(); await owner.close(); db.close() })
    const command = (operation: string, payload: import('../shared/service-protocol').JsonValue) => backend.registry.invoke(operation, payload, caller, new AbortController().signal)
    const agent = db.createAgent({ name: 'Synthetic process agent', config: { coding_agent: 'pi', auth_method: 'subscription', permission_mode: 'ask' } })!
    const task = db.createTask({ title: 'Synthetic process task' })!; db.updateTask(task.id, { agent_id: agent.id })
    const started = await command('agentSession:start', { agentId: agent.id, taskId: task.id }) as { value: { sessionId: string } }
    const sessionId = started.value.sessionId
    await expect.poll(() => manager.getSessionRequestScope(sessionId, 'native-permission-211', 'permission')).toMatchObject({ taskId: task.id, agentId: agent.id })
    await expect(command('agentSession:approve', { sessionId, approved: true, requestId: 'stale', responseType: 'permission' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await command('agentSession:approve', { sessionId, approved: true, requestId: 'native-permission-211', responseType: 'permission' })
    await expect.poll(() => manager.getSessionRequestScope(sessionId, 'native-question-211', 'question')).toMatchObject({ taskId: task.id })
    await command('agentSession:approve', { sessionId, approved: true, requestId: 'native-question-211', responseType: 'question', message: JSON.stringify({ answer: 'synthetic-value' }) })
    await expect.poll(() => db.getTranscriptParts(task.id).some(part => (part.tool as { status?: string } | undefined)?.status === 'error')).toBe(true)
    await expect.poll(async () => (await f.adapter.getCompactionObservations?.(sessionId, f.config))?.length).toBe(1)
    await expect(command('agentSession:abort', { sessionId })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect((await f.adapter.getStatus(sessionId, f.config)).type).toBe('busy')
    expect(manager.getSession(sessionId)).toBeDefined()
    const pid = JSON.parse(readFileSync(f.receipt, 'utf8')).pid
    await expect.poll(() => db.getTranscriptParts(task.id).some(part => part.content === 'Synthetic retained reply')).toBe(true)
    const next = db.createAgent({ name: 'Synthetic replacement', config: { coding_agent: 'pi', auth_method: 'subscription' } })!
    const switched = await command('agentSession:switchAgent', { taskId: task.id, newAgentId: next.id }) as { value: { sessionId: string } }
    const replacementId = switched.value.sessionId
    expect(replacementId).not.toBe(sessionId)
    expect(manager.getSession(sessionId)).toBeUndefined()
    expect(() => process.kill(pid, 0)).toThrow()
    await expect.poll(() => JSON.parse(readFileSync(f.receipt, 'utf8')).recapReceived).toBe(true)
    await expect.poll(() => manager.getSessionRequestScope(replacementId, 'native-permission-211', 'permission')).toMatchObject({ agentId: next.id })
    await backend.close(); backend = new ProductionAgentBackend(backendOptions)
    await command('agentSession:resume', { agentId: next.id, taskId: task.id, sessionId: replacementId })
    expect(await manager.getSessionRequestScope(replacementId, 'native-permission-211', 'permission')).toMatchObject({ agentId: next.id })
    await expect(command('agentSession:approve', { sessionId, approved: true, requestId: 'native-permission-211' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await command('agentSession:approve', { sessionId: replacementId, approved: false, requestId: 'native-permission-211', responseType: 'permission' })
    const replacementPid = JSON.parse(readFileSync(f.receipt, 'utf8')).pid
    await command('agentSession:stop', { sessionId: replacementId })
    expect(() => process.kill(replacementPid, 0)).toThrow()
  }, 15000)

  it('hands an exhausted real protocol child to the configured fallback once, with a durable recap and remaining intent', async () => {
    const f = fixture('pi'), db = createPortableTestDb(), owner = new ProductionAdapters()
    roots.push(dirname(dirname(db.getWorkspaceDir('fixture'))))
    const manager = new AgentManager(db, { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' },
      energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' },
      createAdapter: () => owner.wrap(f.adapter), isCodexAppServerAdapter: () => false })
    const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'quota-process-epoch', webviewId: 'main', origin: 'app://synthetic' }
    const backend = new ProductionAgentBackend({ manager, database: db, engineEpoch: caller.engineEpoch, assertAvailable() {},
      isTrustedDesktop: () => true, canAccessTask: () => true, canAccessProject: () => true, canAccessAgent: () => true })
    cleanup.push(async () => { await backend.close(); await manager.stopAllSessions(); await owner.close(); db.close() })
    const next = db.createAgent({ name: 'Synthetic quota fallback', config: { coding_agent: 'pi', auth_method: 'subscription' } })!
    const primary = db.createAgent({ name: 'Synthetic exhausted provider', config: { coding_agent: 'pi', auth_method: 'subscription',
      system_prompt: 'TWENTYX_SYNTHETIC_QUOTA', fallback_agent_ids: [next.id] } })!
    const task = db.createTask({ title: 'Synthetic quota recovery' })!; db.updateTask(task.id, { agent_id: primary.id })
    const started = await backend.registry.invoke('agentSession:start', { agentId: primary.id, taskId: task.id }, caller, new AbortController().signal) as { value: { sessionId: string } }
    const oldPid = JSON.parse(readFileSync(f.receipt, 'utf8')).pid
    await expect.poll(() => db.getTask(task.id)?.agent_id, { timeout: 10000 }).toBe(next.id)
    await expect.poll(() => JSON.parse(readFileSync(f.receipt, 'utf8')).remainingIntentReceived, { timeout: 10000 }).toBe(true)
    const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'))
    expect(receipt).toMatchObject({ promptCount: 1, recapReceived: true })
    expect(receipt.pid).not.toBe(oldPid)
    expect(() => process.kill(oldPid, 0)).toThrow()
    expect(manager.getSession(started.value.sessionId)).toBeUndefined()
    const replacementId = db.getTask(task.id)!.session_id!
    await expect.poll(() => manager.getSessionRequestScope(replacementId, 'native-permission-211', 'permission')).toMatchObject({ agentId: next.id, taskId: task.id })
    expect(db.getTranscriptParts(task.id).some(part => part.content === 'Synthetic retained reply')).toBe(true)
  }, 20000)
})
