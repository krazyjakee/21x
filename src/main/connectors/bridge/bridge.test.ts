import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../../../test/helpers/db-test-helper'
import type { DatabaseManager } from '../../database'
import { TaskStatus, PluginActionId } from '../../../shared/constants'
import { CONNECTOR_PIECE_ALLOWLIST, type ConnectorPieceAllowlist } from '../allowlist'
import { ConnectorStore } from '../connector-store'
import type { ConnectorCredentials } from '../credentials'
import { kvBackendFromConnectorStore, PieceHostClient, type PieceHostTransport } from '../piece-host/client'
import type { HostInboundMessage, HostOutboundMessage } from '../piece-host/protocol'
import { ConnectorBridgePlugin } from '../../plugins/connector-bridge-plugin'
import type { PluginContext } from '../../plugins/types'
import { ConnectorBridgeEngine, type BridgeRuntime } from './engine'
import { mapItem, validateMapping, type ConnectorTaskMapping } from './mapping'
import { CONNECTOR_TASK_MAPPINGS } from './mappings'
import { backoffDelayMs, classifyError, parseRetryAfter, type RetryPolicy } from './retry'
import { BridgeScheduler } from './scheduler'
import { readCursor } from './state'

/**
 * Drives the connector bridge through a real PieceHostClient whose transport
 * is a stub piece (no utilityProcess), against an in-memory database.
 */

const PIECE = '@21x/stub-tasks'
const VERSION = '1.0.0'
const SECRET = 'sekrit-token-12345'
const CREDS: ConnectorCredentials = { type: 'secret_text', secret: SECRET }

const ALLOWLIST: ConnectorPieceAllowlist = {
  allowedLicenses: ['MIT'],
  commercialPathPatterns: [],
  packages: {},
  reviewedLicenseExceptions: [],
  reviewedPathExceptions: [],
  pieces: {
    [PIECE]: {
      version: VERSION,
      exportName: 'stub',
      actions: { list_items: {}, update_item: {} },
      triggers: { new_items: { strategy: 'POLLING' } }
    }
  }
}

const MAPPING: ConnectorTaskMapping = {
  pieceName: PIECE,
  label: 'Stub',
  auth: { type: 'secret_text', labels: { secret: 'Token' } },
  configProps: [{ key: 'board', label: 'Board', required: true }],
  import: { target: { type: 'action', name: 'list_items' }, props: { board: { config: 'board' } }, itemsPath: 'items' },
  fields: {
    externalId: 'id',
    title: 'name',
    description: 'desc',
    dueDate: 'due',
    url: 'url',
    labels: 'labels[].name',
    status: { path: 'closed', completedValues: [true] }
  },
  update: {
    action: 'update_item',
    idProp: 'item_id',
    titleProp: 'name',
    dueDateProp: 'due',
    status: { prop: 'closed', completedValue: true, openValue: false }
  }
}

const RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 60_000 }

interface Item {
  id: string
  name: unknown
  desc?: unknown
  due?: unknown
  url?: string
  closed?: boolean
  labels?: { name: string }[]
}

/** The stub piece: handlers keyed by `action:name` / `trigger:name:hook`. */
type Handler = (props: Record<string, unknown>, auth: unknown) => unknown
let handlers: Record<string, Handler>
let calls: { key: string; props: Record<string, unknown> }[]

class StubTransport implements PieceHostTransport {
  private readonly listeners: ((m: HostOutboundMessage) => void)[] = []
  private readonly exits: ((code: number | null) => void)[] = []
  private dead = false

  constructor() {
    setImmediate(() => this.emit({ kind: 'ready' }))
  }

  private emit(m: HostOutboundMessage): void {
    if (!this.dead) this.listeners.forEach((l) => l(structuredClone(m)))
  }

  postMessage(message: HostInboundMessage): void {
    if (message.kind !== 'invoke') return
    const { target, propsValue, auth } = message.invocation
    const key = target.type === 'action' ? `action:${target.name}` : `trigger:${target.name}:${target.hook}`
    calls.push({ key, props: propsValue })
    const handler = handlers[key]
    void (async () => {
      try {
        if (!handler) throw new Error(`no stub for ${key}`)
        const output = await handler(propsValue, auth)
        this.emit({ kind: 'result', id: message.id, ok: true, output })
      } catch (err) {
        this.emit({ kind: 'result', id: message.id, ok: false, error: { code: 'PIECE_EXECUTION_FAILED', message: (err as Error).message } })
      }
    })()
  }

  onMessage(handler: (m: HostOutboundMessage) => void): void {
    this.listeners.push(handler)
  }

  onExit(handler: (code: number | null) => void): void {
    this.exits.push(handler)
  }

  kill(): void {
    this.dead = true
    this.exits.forEach((h) => h(null))
  }
}

let db: DatabaseManager
let store: ConnectorStore
let instanceId: string
let projectId: string
let sourceId: string
let config: Record<string, unknown>
let ctx: PluginContext
let now: number
let remote: Item[]

function runtime(): BridgeRuntime {
  const credentials = { get: () => CREDS }
  const client = new PieceHostClient({
    createTransport: () => new StubTransport(),
    kv: kvBackendFromConnectorStore(store),
    credentials,
    allowlist: ALLOWLIST
  })
  return { store, credentials, client }
}

const engineOptions = () => ({
  mappings: { [PIECE]: MAPPING },
  allowlist: ALLOWLIST,
  retry: RETRY,
  itemMaxAttempts: 3,
  now: () => now,
  log: () => undefined
})

function makeEngine(): ConnectorBridgeEngine {
  return new ConnectorBridgeEngine({ ...engineOptions(), runtime: runtime() })
}

function makePlugin(): ConnectorBridgePlugin {
  const rt = runtime()
  return new ConnectorBridgePlugin({ runtime: () => rt, engine: engineOptions() })
}

function listCalls(): number {
  return calls.filter((c) => c.key === 'action:list_items').length
}

function tasks() {
  return db.getTasks({ projectId }).filter((t) => t.source_id === sourceId)
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

beforeEach(() => {
  ;({ db } = createTestDb())
  store = new ConnectorStore(db)
  instanceId = store.createInstance({ pieceName: PIECE, pieceVersion: VERSION }).id
  projectId = db.createProject({ name: 'Connector project' })!.id
  config = { piece_name: PIECE, connector_instance_id: instanceId, props: { board: 'b1' }, poll_interval_minutes: 10 }
  sourceId = db.createTaskSource({ name: 'Stub', plugin_id: 'connector-bridge', mcp_server_id: null, project_id: projectId, config })!.id
  ctx = { db, sourceId }
  now = 1_700_000_000_000
  calls = []
  remote = [
    { id: 'a', name: 'First card', desc: 'Do it', due: '2026-10-01T12:00:00.000Z', url: 'https://stub.example.com/c/a', labels: [{ name: 'bug' }] },
    { id: 'b', name: 'Second card', closed: false }
  ]
  handlers = {
    'action:list_items': () => ({ items: remote }),
    'action:update_item': () => ({ ok: true })
  }
})

// ── Mapping ─────────────────────────────────────────────────────

describe('mapping validation', () => {
  it('accepts the bundled mappings against the real allowlist', () => {
    for (const mapping of Object.values(CONNECTOR_TASK_MAPPINGS)) {
      expect(validateMapping(mapping, CONNECTOR_PIECE_ALLOWLIST)).toEqual([])
    }
    expect(validateMapping(MAPPING, ALLOWLIST)).toEqual([])
  })

  it('rejects non-allowlisted actions, triggers and unsafe paths', () => {
    const bad: ConnectorTaskMapping = {
      ...MAPPING,
      import: { ...MAPPING.import, target: { type: 'action', name: 'custom_api_call' } },
      fields: { ...MAPPING.fields, title: '__proto__.x', dueDate: 'a[].b' },
      update: { ...MAPPING.update!, action: 'delete_everything' }
    }
    const problems = validateMapping(bad, ALLOWLIST).join('\n')
    expect(problems).toContain('import action "custom_api_call" is not allowlisted')
    expect(problems).toContain('invalid title path')
    expect(problems).toContain('dueDate path cannot use []')
    expect(problems).toContain('update action "delete_everything" is not allowlisted')
    expect(validateMapping({ ...MAPPING, import: { ...MAPPING.import, target: { type: 'trigger', name: 'nope' } } }, ALLOWLIST))
      .toContain('import trigger "nope" is not allowlisted')
  })

  it('validates types and lengths of mapped output', () => {
    const ok = mapItem({ id: 'x', name: 'T'.repeat(900), desc: 'd\u0007ok', due: '2026-01-02', labels: [{ name: 'a' }, { name: 5 }] }, MAPPING)
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.item.fields.title!.length).toBe(500)
      expect(ok.item.fields.description).toBe('dok')
      expect(ok.item.fields.due_date).toBe('2026-01-02T00:00:00.000Z')
      expect(ok.item.fields.labels).toEqual(['a'])
    }
    expect(mapItem({ id: 'x', name: 42 }, MAPPING)).toMatchObject({ ok: false, externalId: 'x' })
    expect(mapItem({ id: 'x', name: 'n', due: 'not a date' }, MAPPING)).toMatchObject({ ok: false, error: expect.stringContaining('not a valid date') })
    expect(mapItem({ id: 'x', name: 'n', desc: { html: true } }, MAPPING)).toMatchObject({ ok: false })
    expect(mapItem({ name: 'no id' }, MAPPING)).toMatchObject({ ok: false, externalId: null })
    expect(mapItem({ id: 'x', name: 'n', desc: 'x'.repeat(300 * 1024) }, MAPPING)).toMatchObject({ ok: false, error: expect.stringContaining('bytes') })
  })

  it('never keeps URL userinfo and redacts credentials from mapped text', () => {
    const r = mapItem({ id: 'x', name: `leak ${SECRET}`, desc: `auth=${SECRET}`, url: 'https://user:pw@stub.example.com/c/x', labels: [{ name: SECRET }] }, MAPPING, CREDS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(JSON.stringify(r.item.fields)).not.toContain(SECRET)
    expect(r.item.fields.title).toBe('leak [REDACTED]')
    expect(r.item.fields.description).toContain('https://stub.example.com/c/x')
    expect(r.item.fields.description).not.toContain('user:pw')
  })
})

describe('retry classification', () => {
  it('retries 429 and 5xx only, and parses Retry-After', () => {
    expect(classifyError(new Error('{"response":{"status":503,"body":{}}}'))).toMatchObject({ retryable: true, status: 503 })
    expect(classifyError(new Error('Trello rate limit exceeded. Retry after a short delay.'))).toMatchObject({ retryable: true, rateLimited: true })
    expect(classifyError(new Error('{"response":{"status":429}} retry-after: 30'))).toMatchObject({ retryable: true, retryAfterMs: 30_000 })
    expect(classifyError(new Error('{"response":{"status":404}}'))).toMatchObject({ retryable: false })
    expect(classifyError(new Error('Permission denied'))).toMatchObject({ retryable: false })
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:10 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'))).toBe(10_000)
    expect(backoffDelayMs(1, RETRY)).toBe(1000)
    expect(backoffDelayMs(3, RETRY)).toBe(4000)
    expect(backoffDelayMs(20, RETRY)).toBe(60_000)
    expect(backoffDelayMs(1, RETRY, 5000)).toBe(5000)
  })
})

// ── Import ──────────────────────────────────────────────────────

describe('import', () => {
  it('upserts idempotently by stable external id', async () => {
    const plugin = makePlugin()
    expect(await plugin.importTasks(sourceId, config, ctx)).toEqual({ imported: 2, updated: 0, errors: [] })
    remote[0].name = 'First card (renamed)'
    expect(await plugin.importTasks(sourceId, config, ctx)).toEqual({ imported: 0, updated: 2, errors: [] })
    expect(tasks()).toHaveLength(2)
    expect(db.getTaskByExternalId(sourceId, 'a')?.title).toBe('First card (renamed)')
    expect(calls.find((c) => c.key === 'action:list_items')?.props).toEqual({ board: 'b1' })
  })

  it("lands tasks in the source's project with the source label", async () => {
    await makePlugin().importTasks(sourceId, config, ctx)
    const task = db.getTaskByExternalId(sourceId, 'a')!
    expect(task.project_id).toBe(projectId)
    expect(task.source).toBe('Stub')
    expect(task.due_date).toBe('2026-10-01T12:00:00.000Z')
    expect(task.labels).toEqual(['bug'])
  })

  it('completes cached tasks closed at the source but never creates closed ones', async () => {
    const plugin = makePlugin()
    await plugin.importTasks(sourceId, config, ctx)
    remote[1].closed = true
    remote.push({ id: 'c', name: 'Archived long ago', closed: true })
    await plugin.importTasks(sourceId, config, ctx)
    expect(db.getTaskByExternalId(sourceId, 'b')?.status).toBe(TaskStatus.Completed)
    expect(db.getTaskByExternalId(sourceId, 'c')).toBeUndefined()
  })

  it('runs one job at a time per connector instance', async () => {
    const gate = deferred<unknown>()
    handlers['action:list_items'] = () => gate.promise
    const engine = makeEngine()
    const first = engine.sync(sourceId, config, ctx, { manual: true })
    const second = engine.sync(sourceId, config, ctx, { manual: true })
    expect(engine.isBusy(instanceId)).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    gate.resolve({ items: remote })
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(listCalls()).toBe(1)
    expect(tasks()).toHaveLength(2)
  })

  it('refuses allowlist-external targets before reaching the piece', async () => {
    const engine = new ConnectorBridgeEngine({
      ...engineOptions(),
      mappings: { [PIECE]: { ...MAPPING, import: { ...MAPPING.import, target: { type: 'action', name: 'custom_api_call' } } } },
      runtime: runtime()
    })
    const result = await engine.sync(sourceId, config, ctx)
    expect(result.errors[0]).toContain('not allowlisted')
    expect(calls).toHaveLength(0)
  })

  it('imports through a polling trigger, enabling it once', async () => {
    handlers['trigger:new_items:onEnable'] = () => null
    handlers['trigger:new_items:run'] = () => remote
    const engine = new ConnectorBridgeEngine({
      ...engineOptions(),
      mappings: { [PIECE]: { ...MAPPING, import: { target: { type: 'trigger', name: 'new_items' }, props: {} } } },
      runtime: runtime()
    })
    await engine.sync(sourceId, config, ctx, { manual: true })
    await engine.sync(sourceId, config, ctx, { manual: true })
    expect(calls.filter((c) => c.key === 'trigger:new_items:onEnable')).toHaveLength(1)
    expect(calls.filter((c) => c.key === 'trigger:new_items:run')).toHaveLength(2)
    expect(tasks()).toHaveLength(2)
  })

  it('keeps cached tasks usable when the piece fails', async () => {
    const plugin = makePlugin()
    await plugin.importTasks(sourceId, config, ctx)
    const before = tasks().map((t) => ({ id: t.id, title: t.title, status: t.status }))
    handlers['action:list_items'] = () => {
      throw new Error('Board not found. Verify the board_id.')
    }
    const result = await plugin.importTasks(sourceId, config, ctx)
    expect(result.errors[0]).toContain('Existing tasks were kept')
    expect(tasks().map((t) => ({ id: t.id, title: t.title, status: t.status }))).toEqual(before)
    expect(store.getSyncState(instanceId)?.lastError).toContain('Board not found')
  })

  it('reports per-item errors and dead-letters items that keep failing', async () => {
    remote.push({ id: 'bad', name: 'Bad due', due: 'someday' })
    const plugin = makePlugin()
    for (let i = 1; i <= 3; i++) {
      const result = await plugin.importTasks(sourceId, config, ctx)
      expect(result.imported + result.updated).toBe(2)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('Stub item bad')
    }
    const dead = store.listDeadLetters(instanceId)
    expect(dead).toHaveLength(1)
    expect(dead[0]).toMatchObject({ externalId: 'bad', attempts: 3 })
    // Unchanged dead items are skipped, not re-reported.
    expect((await plugin.importTasks(sourceId, config, ctx)).errors).toEqual([])
    expect(store.listDeadLetters(instanceId)).toHaveLength(1)
  })
})

// ── Retries ─────────────────────────────────────────────────────

describe('retries', () => {
  it('backs off on 429, honouring Retry-After even for manual syncs', async () => {
    handlers['action:list_items'] = () => {
      throw new Error('Request failed {"response":{"status":429,"body":{}}} retry-after: 120')
    }
    const engine = makeEngine()
    const result = await engine.sync(sourceId, config, ctx, { manual: true })
    expect(result.errors[0]).toContain('attempt 1 of 3')
    const state = store.getSyncState(instanceId)!
    expect(state.attemptCount).toBe(1)
    expect(state.nextRetryAt).toBe(now + 120_000)

    const early = await engine.sync(sourceId, config, ctx, { manual: true })
    expect(early.errors[0]).toContain('slow down')
    expect(listCalls()).toBe(1)

    handlers['action:list_items'] = () => ({ items: remote })
    now += 120_000
    expect((await engine.sync(sourceId, config, ctx)).imported).toBe(2)
    expect(store.getSyncState(instanceId)).toMatchObject({ attemptCount: 0, nextRetryAt: null, lastError: null })
  })

  it('retries 5xx with exponential backoff, then dead-letters the job', async () => {
    handlers['action:list_items'] = () => {
      throw new Error('{"response":{"status":503,"body":"unavailable"}}')
    }
    const engine = makeEngine()
    await engine.sync(sourceId, config, ctx)
    expect(store.getSyncState(instanceId)).toMatchObject({ attemptCount: 1, nextRetryAt: now + 1000 })

    // Not due yet: a scheduled sync does not call the piece.
    expect((await engine.sync(sourceId, config, ctx)).errors[0]).toContain('Waiting until')
    expect(listCalls()).toBe(1)

    now += 1000
    await engine.sync(sourceId, config, ctx)
    expect(store.getSyncState(instanceId)).toMatchObject({ attemptCount: 2, nextRetryAt: now + 2000 })

    now += 2000
    const last = await engine.sync(sourceId, config, ctx)
    expect(last.errors[0]).toContain('moved to dead letters')
    expect(store.getSyncState(instanceId)).toMatchObject({ attemptCount: 0, nextRetryAt: null })
    const dead = store.listDeadLetters(instanceId)
    expect(dead).toHaveLength(1)
    expect(dead[0]).toMatchObject({ externalId: null, attempts: 3, payload: { operation: 'import' } })
  })

  it('persists attempt state across a restart', async () => {
    handlers['action:list_items'] = () => {
      throw new Error('{"response":{"status":502}}')
    }
    await makeEngine().sync(sourceId, config, ctx)
    const retryAt = store.getSyncState(instanceId)!.nextRetryAt!

    // "Restart": fresh store, client, engine and scheduler on the same database.
    store = new ConnectorStore(db)
    const engine = makeEngine()
    const runSource = vi.fn(async () => undefined)
    const scheduler = new BridgeScheduler({ db, store, isBusy: () => false, runSource, now: () => now })
    await scheduler.tick()
    expect(runSource).not.toHaveBeenCalled()
    expect((await engine.sync(sourceId, config, ctx)).errors[0]).toContain('Waiting until')

    now = retryAt
    await scheduler.tick()
    expect(runSource).toHaveBeenCalledWith(sourceId)
    await engine.sync(sourceId, config, ctx)
    expect(store.getSyncState(instanceId)?.attemptCount).toBe(2)
  })
})

// ── Redaction ───────────────────────────────────────────────────

describe('credential redaction', () => {
  it('keeps credentials out of errors, sync state, tasks and dead letters', async () => {
    remote = [
      { id: 'a', name: `Card for ${SECRET}`, desc: `token ${SECRET}` },
      { id: 'b', name: 'Bad', due: `never ${SECRET}` }
    ]
    const plugin = makePlugin()
    for (let i = 0; i < 3; i++) await plugin.importTasks(sourceId, config, ctx)
    const task = db.getTaskByExternalId(sourceId, 'a')!
    expect(task.title).not.toContain(SECRET)
    expect(task.description).not.toContain(SECRET)
    expect(JSON.stringify(store.listDeadLetters(instanceId))).not.toContain(SECRET)

    handlers['action:list_items'] = (_props, auth) => {
      throw new Error(`upstream said: bad token ${(auth as { secret_text: string }).secret_text}`)
    }
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await plugin.importTasks(sourceId, config, ctx)
    expect(result.errors.join('\n')).toContain('[REDACTED]')
    expect(result.errors.join('\n')).not.toContain(SECRET)
    expect(store.getSyncState(instanceId)?.lastError).not.toContain(SECRET)
    for (const call of log.mock.calls) expect(String(call.join(' '))).not.toContain(SECRET)
    log.mockRestore()
  })
})

// ── Round trip ──────────────────────────────────────────────────

describe('round trip', () => {
  it('completes an item at the source through the allowlisted update action', async () => {
    const plugin = makePlugin()
    await plugin.importTasks(sourceId, config, ctx)
    const task = db.getTaskByExternalId(sourceId, 'a')!
    const result = await plugin.executeAction(PluginActionId.Complete, task, undefined, config, ctx)
    expect(result).toEqual({ success: true, taskUpdate: { status: TaskStatus.Completed } })
    expect(calls.find((c) => c.key === 'action:update_item')?.props).toEqual({ item_id: 'a', closed: true })
  })

  it('pushes title and due date changes and ignores 21x-only workflow states', async () => {
    const plugin = makePlugin()
    await plugin.importTasks(sourceId, config, ctx)
    const task = db.getTaskByExternalId(sourceId, 'a')!
    await plugin.exportUpdate(task, { title: 'New title', due_date: '2026-12-24', status: TaskStatus.AgentWorking, labels: ['x'] }, config, ctx)
    const updates = calls.filter((c) => c.key === 'action:update_item')
    expect(updates).toHaveLength(1)
    expect(updates[0].props).toEqual({ item_id: 'a', name: 'New title', due: '2026-12-24T00:00:00.000Z' })

    await plugin.exportUpdate(task, { status: TaskStatus.ReadyForReview }, config, ctx)
    expect(calls.filter((c) => c.key === 'action:update_item')).toHaveLength(1)
  })

  it('queues a failed update, keeps the local value on import, and retries it', async () => {
    const plugin = makePlugin()
    await plugin.importTasks(sourceId, config, ctx)
    const task = db.getTaskByExternalId(sourceId, 'a')!
    db.updateTask(task.id, { title: 'Local title' })

    handlers['action:update_item'] = () => {
      throw new Error('{"response":{"status":500}}')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await plugin.exportUpdate(task, { title: 'Local title' }, config, ctx)
    warn.mockRestore()
    const pending = readCursor(store.getSyncState(instanceId)?.cursor).pending.a
    expect(pending).toMatchObject({ changed: { title: 'Local title' }, attempts: 1, nextRetryAt: now + 1000 })

    // The source still has the old title; the pending local change wins.
    handlers['action:update_item'] = () => ({ ok: true })
    await plugin.importTasks(sourceId, config, ctx)
    expect(db.getTaskByExternalId(sourceId, 'a')?.title).toBe('Local title')

    now += 1000
    await plugin.importTasks(sourceId, config, ctx)
    expect(calls.filter((c) => c.key === 'action:update_item').at(-1)?.props).toEqual({ item_id: 'a', name: 'Local title' })
    expect(readCursor(store.getSyncState(instanceId)?.cursor).pending).toEqual({})
  })
})

// ── Scheduler ───────────────────────────────────────────────────

describe('scheduler', () => {
  it('polls on the configured interval and skips manual-only sources', async () => {
    const plugin = makePlugin()
    const engine = plugin.engineFor(db)
    const runSource = vi.fn(async (id: string) => {
      await engine.sync(id, db.getTaskSource(id)!.config, { db, sourceId: id })
    })
    const scheduler = new BridgeScheduler({ db, store, isBusy: (id) => engine.isBusy(id), runSource, now: () => now })

    await scheduler.tick()
    expect(runSource).toHaveBeenCalledTimes(1)
    await scheduler.tick()
    expect(runSource).toHaveBeenCalledTimes(1)
    now += 10 * 60_000
    await scheduler.tick()
    expect(runSource).toHaveBeenCalledTimes(2)

    db.updateTaskSource(sourceId, { config: { ...config, poll_interval_minutes: 0 } })
    now += 60 * 60_000
    await scheduler.tick()
    expect(runSource).toHaveBeenCalledTimes(2)
  })
})
