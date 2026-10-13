import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { CaptainRollover, captainRolloverSeed, captainSummarySettings } from './captain-rollover'
import { AdapterEngine } from './adapter-engine'
import { HandoffEngine, type HandoffTurn } from './handoff'
import type { ChatProvider } from '../chat/providers/types'
import { CHAT_SETTING_KEYS } from '../../shared/chat'

const resources: Array<{ db: ReturnType<typeof createPortableTestDb>; directory: string; rollover: CaptainRollover }> = []
afterEach(() => {
  for (const { db, directory, rollover } of resources.splice(0)) { rollover.shutdown(); db.close(); rmSync(directory, { recursive: true, force: true }) }
  vi.restoreAllMocks()
})
async function fixture(mode = 'on', managed = true, provider?: ChatProvider) {
  const db = createPortableTestDb()
  db.setSetting('sessions.rollover', mode)
  db.setSetting('sessions.rollover_thresholds', JSON.stringify({ turns: 1 }))
  if (managed) db.setSetting('sessions.captain_managed', 'true')
  const agent = db.createAgent({ name: 'Source agent', config: { coding_agent: 'codex', model: 'gpt-4o', auth_method: 'api_key', api_keys: { openai: 'own-auth' } } })!
  const project = db.createProject({ name: 'Source project', captain_agent_id: agent.id })!
  const task = db.getCoordinatorTask(project.id)!
  const observer = new AdapterEngine(db.db, 'test')
  await observer.observe(task.id, 'old-native', 'session_started', 'start', { model: 'gpt-4o' })
  await observer.observe(task.id, 'old-native', 'turn_started', 'turn-start', { kind: 'captain', input: 'Original goal' }, 'turn')
  await observer.finishTurn(task.id, 'old-native', 'turn', 'end_turn')
  const directory = mkdtempSync(join(tmpdir(), 'captain-rollover-'))
  writeFileSync(join(directory, 'MEMORY.md'), 'Human memory must remain.\n')
  const model: ChatProvider = provider ?? { id: 'fixture', model: 'gpt-4o', async *stream() {
    yield { type: 'text_delta', text: 'The previous task completed; inspect current status before starting anything new.' }
    yield { type: 'message_end', stopReason: 'end_turn' }
  } }
  const factory = vi.fn((settings: Parameters<typeof captainSummarySettings>[0]) => {
    void settings
    return model
  })
  const rollover = new CaptainRollover(db, factory)
  resources.push({ db, directory, rollover })
  const turns: HandoffTurn[] = [{ id: 'user-1', role: 'user', content: 'Original goal' },
    { id: 'tool-1', role: 'assistant', content: 'Task started and finished', toolName: 'start_task', state: 'completed' }]
  const input = { ownerId: task.id, engine: 'adapter' as const, generationKey: 'adapter:old-native', model: 'gpt-4o',
    backendId: 'old-native', workspaceDir: directory, reasons: [], turns, agent }
  const createGeneration = vi.fn(async () => ({ backendId: 'new-native' }))
  const bindGeneration = vi.fn(async () => {})
  const notice = vi.fn()
  return { db, rollover, factory, directory, input, task, agent, turns, callbacks: { mayContinue: () => true, createGeneration, bindGeneration, notice }, createGeneration, bindGeneration, notice }
}

describe('Captain rollover orchestration', () => {
  it('uses the exact source model with no tools and preserves actual triggering reasons, source and memory', async () => {
    const requests: unknown[] = []
    const h = await fixture('on', true, { id: 'own-provider', model: 'gpt-4o', async *stream(request) {
      requests.push(request)
      yield { type: 'text_delta', text: 'A source-model summary' }
    } })
    const result = await h.rollover.consider(h.input, h.callbacks)
    expect(result?.state).toBe('completed')
    expect(result?.source.reasons).toEqual(['turns'])
    expect(result?.source.turns).toEqual(h.turns)
    expect(result?.source.workspaceDir).toBe(h.directory)
    expect(result?.model).toBe('gpt-4o')
    expect(requests[0]).toMatchObject({ tools: [], toolChoice: 'none', maxTokens: 1500 })
    expect(h.createGeneration).toHaveBeenCalledOnce()
    expect(h.bindGeneration).toHaveBeenCalledOnce()
    expect(readFileSync(join(h.directory, 'MEMORY.md'), 'utf8')).toContain('Human memory must remain.')
    expect(readFileSync(join(h.directory, '.21x', 'session-journal.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it.each([['off', true], ['observe', true], ['on', false]])('honors %s with managed=%s without summary, memory or backend work', async (mode, managed) => {
    const h = await fixture(mode as string, managed as boolean)
    expect(await h.rollover.consider(h.input, h.callbacks)).toBeNull()
    expect(h.factory).not.toHaveBeenCalled()
    expect(h.createGeneration).not.toHaveBeenCalled()
    expect(readFileSync(join(h.directory, 'MEMORY.md'), 'utf8')).toBe('Human memory must remain.\n')
    expect(h.db.db.prepare('SELECT COUNT(*) AS count FROM session_handoffs').get()).toEqual({ count: 0 })
  })

  it('refuses a source that cannot verify idle and retains unsupported own-model continuity deterministically', async () => {
    const h = await fixture()
    await h.rollover.consider(h.input, { ...h.callbacks, verifyIdle: async () => false })
    expect(h.createGeneration).not.toHaveBeenCalled()
    h.factory.mockImplementationOnce(() => { throw new Error('Own model unsupported') })
    const result = await h.rollover.consider(h.input, h.callbacks)
    expect(result?.summary?.source).toBe('fallback')
    expect(result?.summary?.text).toContain('Original goal')
    expect(h.factory).toHaveBeenCalledOnce()
    expect(h.createGeneration).toHaveBeenCalledOnce()
  })

  it('keeps accepted native identity after cancellation and includes later original-backend work when binding resumes', async () => {
    const h = await fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = vi.fn()
    h.createGeneration.mockImplementationOnce(async () => { entered(); await gate; return { backendId: 'accepted-after-cancel' } })
    const attempt = h.rollover.consider(h.input, h.callbacks)
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
      h.rollover.cancel(h.task.id)
      release(); await attempt
      const saved = new HandoffEngine(h.db.db).get(h.task.id, h.input.generationKey)!
      expect(saved.state).toBe('created')
      expect(saved.targetBackendId).toBe('accepted-after-cancel')
      expect(h.bindGeneration).not.toHaveBeenCalled()
      const tail: HandoffTurn[] = [...h.turns, { id: 'new-user', role: 'user', content: 'Do this newer work first' },
        { id: 'new-tool', role: 'assistant', toolName: 'start_task', state: 'completed', content: 'Newer task completed once' }]
      let seed = ''
      await h.rollover.consider({ ...h.input, turns: tail }, { ...h.callbacks, bindGeneration: async (record) => { seed = captainRolloverSeed(record, tail) } })
      expect(h.createGeneration).toHaveBeenCalledOnce()
      expect(seed).toContain('Do this newer work first')
      expect(seed).toContain('Newer task completed once')
      expect(new HandoffEngine(h.db.db).get(h.task.id, h.input.generationKey)?.source.turns).toEqual(h.turns)
      expect(() => captainRolloverSeed(saved, [...tail, { id: 'too-large', role: 'user', content: 'x'.repeat(60000) }])).toThrow('cannot fit safely')
    } finally { release(); await attempt }
  })

  it('retains ambiguous creation without issuing another create on retry', async () => {
    const h = await fixture()
    h.createGeneration.mockRejectedValueOnce(new Error('Transport reset after create'))
    expect((await h.rollover.consider(h.input, h.callbacks))?.state).toBe('creation_unconfirmed')
    expect((await h.rollover.consider(h.input, h.callbacks))?.state).toBe('creation_unconfirmed')
    expect(h.createGeneration).toHaveBeenCalledOnce()
    expect(h.bindGeneration).not.toHaveBeenCalled()
    expect(h.notice).toHaveBeenCalled()
  })

  it('uses deterministic continuity when the portable host supplies no summary transport', async () => {
    const h = await fixture()
    const portable = new CaptainRollover(h.db)
    try {
      const result = await portable.consider(h.input, h.callbacks)
      expect(result?.summarySource).toBe('fallback')
      expect(result?.summary?.text).toContain('Original goal')
      expect(h.factory).not.toHaveBeenCalled()
      expect(h.createGeneration).toHaveBeenCalledOnce()
    } finally { portable.shutdown() }
  })

  it('ignores saved Commander model/endpoint settings and exposes only source-agent vendor authentication', async () => {
    const h = await fixture()
    h.db.setSetting(CHAT_SETTING_KEYS.model, 'another-model')
    h.db.setSetting(CHAT_SETTING_KEYS.baseUrl, 'https://other-provider.invalid')
    const shim = captainSummarySettings(h.db, h.agent, 'gpt-4o')
    expect(shim.getSetting(CHAT_SETTING_KEYS.model)).toBeUndefined()
    expect(shim.getSetting(CHAT_SETTING_KEYS.baseUrl)).toBeUndefined()
    expect(shim.getAgents()).toHaveLength(1)
    expect(shim.getAgents()[0].config).toMatchObject({ model: 'gpt-4o', auth_method: 'api_key', api_keys: { openai: 'own-auth' } })
    h.agent.config.model = 'changed-after-snapshot'
    expect(shim.getAgents()[0].config.model).toBe('gpt-4o')
  })
})
