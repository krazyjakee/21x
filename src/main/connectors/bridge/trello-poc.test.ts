import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTlsGuard } from '../piece-host/tls-guard'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { createTestDb } from '../../../../test/helpers/db-test-helper'
import type { DatabaseManager } from '../../database'
import { PluginActionId, TaskStatus } from '../../../shared/constants'
import { ConnectorBridgePlugin } from '../../plugins/connector-bridge-plugin'
import type { PluginContext } from '../../plugins/types'
import { CONNECTOR_PIECE_ALLOWLIST } from '../allowlist'
import { ConnectorStore } from '../connector-store'
import type { ConnectorCredentials } from '../credentials'
import { kvBackendFromConnectorStore, PieceHostClient, type PieceHostTransport } from '../piece-host/client'
import { PieceNotAllowedError } from '../piece-host/errors'
import { startPieceHost } from '../piece-host/host-runtime'
import { loadBundledPiece } from '../piece-host/piece-registry'
import type { HostInboundMessage, HostOutboundMessage } from '../piece-host/protocol'
import { ConnectorBridgeEngine, type BridgeRuntime } from './engine'
import { BRIDGE_MAX_ITEMS_PER_SYNC } from './mapping'
import { CONNECTOR_TASK_MAPPINGS } from './mappings'
import type { RetryPolicy } from './retry'
import { BridgeScheduler } from './scheduler'
import { readCursor } from './state'

/**
 * Trello proof of concept (issue #16, docs/connectors.md "Trello proof of concept").
 *
 * Runs the REAL pinned @activepieces/piece-trello bundle through the real
 * piece-host runtime (in-process, behind a fake transport instead of a
 * utilityProcess) and the connector bridge, against a fake Trello HTTP API.
 * pieces-common 0.12.5 sends every request through the global `fetch`, so the
 * fake API replaces `globalThis.fetch` for the duration of each test: nothing
 * touches the network. The piece code, the allowlist and the Trello task
 * mapping are the production ones.
 */

const PIECE = '@activepieces/piece-trello'
const VERSION = '0.6.0'
const API_KEY = 'k3y0123456789abcdef0123456789abcdef'
const TOKEN = 't0ken0123456789abcdef0123456789abcdef0123456789abcdef'
const CREDS: ConnectorCredentials = { type: 'basic', username: API_KEY, password: TOKEN }
const BOARD = '5f1a2b3c4d5e6f7a8b9c0d1e'
const LIST_TODO = 'list-todo-0000000000000001'
const LIST_DONE = 'list-done-0000000000000002'
const RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 60_000 }
const LONG = 30_000

// ── Fake Trello API ─────────────────────────────────────────────

interface TrelloLabel {
  id: string
  name: string
  color: string
}

/** The subset of a Trello card JSON the mapping reads, plus realistic noise. */
interface TrelloCard {
  id: string
  name: string
  desc: string
  due: string | null
  dueComplete: boolean
  closed: boolean
  idBoard: string
  idList: string
  url: string
  labels: TrelloLabel[]
  badges: { comments: number; attachments: number }
  dateLastActivity: string
}

interface ApiRequest {
  method: string
  url: URL
  body: Record<string, unknown> | null
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } })
}

function card(id: string, overrides: Partial<TrelloCard> = {}): TrelloCard {
  return {
    id,
    name: `Card ${id}`,
    desc: '',
    due: null,
    dueComplete: false,
    closed: false,
    idBoard: BOARD,
    idList: LIST_TODO,
    url: `https://trello.com/c/${id}/card-${id}`,
    labels: [],
    badges: { comments: 0, attachments: 0 },
    dateLastActivity: '2026-09-01T00:00:00.000Z',
    ...overrides
  }
}

type FetchInput = string | URL | { url: string }
type FetchInit = { method?: string; body?: unknown } | undefined

class FakeTrelloApi {
  readonly cards = new Map<string, TrelloCard>()
  readonly requests: ApiRequest[] = []
  /** The token Trello currently accepts; change it to "revoke" the stored one. */
  token = TOKEN
  /** Scripted responses, tried before the normal routes. Return undefined to fall through. */
  readonly overrides: ((req: ApiRequest) => Response | undefined)[] = []
  /** While set, every request waits here before it is answered (in-flight simulations). */
  gate: Deferred | null = null

  add(c: TrelloCard): TrelloCard {
    this.cards.set(c.id, c)
    return c
  }

  readonly fetch = async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(href)
    const method = (init?.method ?? 'GET').toUpperCase()
    const raw = init?.body
    const body = typeof raw === 'string' && raw ? (JSON.parse(raw) as Record<string, unknown>) : null
    const req: ApiRequest = { method, url, body }
    this.requests.push(req)
    if (this.gate) await this.gate.promise
    for (const override of this.overrides) {
      const res = override(req)
      if (res) return res
    }
    return this.route(req)
  }

  private route(req: ApiRequest): Response {
    if (req.url.host !== 'api.trello.com') return text(404, `unexpected host ${req.url.host}`)
    if (req.url.searchParams.get('key') !== API_KEY || req.url.searchParams.get('token') !== this.token) {
      return text(401, 'invalid token')
    }
    const boardCards = /^\/1\/boards\/([^/]+)\/cards$/.exec(req.url.pathname)
    if (req.method === 'GET' && boardCards) {
      if (boardCards[1] !== BOARD) return text(404, 'board not found')
      const filter = req.url.searchParams.get('filter') ?? 'visible'
      const cards = [...this.cards.values()].filter((c) => (filter === 'all' ? true : filter === 'closed' ? c.closed : !c.closed))
      return json(200, cards)
    }
    const single = /^\/1\/cards\/([^/]+)$/.exec(req.url.pathname)
    if (req.method === 'PUT' && single) {
      const existing = this.cards.get(single[1])
      if (!existing) return text(404, 'The requested resource was not found.')
      const b = req.body ?? {}
      if (typeof b.name === 'string') existing.name = b.name
      if (typeof b.desc === 'string') existing.desc = b.desc
      if (typeof b.due === 'string') existing.due = b.due
      if (typeof b.closed === 'boolean') existing.closed = b.closed
      if (typeof b.idList === 'string') existing.idList = b.idList
      return json(200, existing)
    }
    return text(404, `Cannot ${req.method} ${req.url.pathname}`)
  }
}

// ── In-process piece host ───────────────────────────────────────

/** The real host runtime and the real bundled-piece registry behind a fake utilityProcess. */
class FakeHostProcess implements PieceHostTransport {
  alive = true
  private readonly toHost: ((m: HostInboundMessage) => void)[] = []
  private readonly toMain: ((m: HostOutboundMessage) => void)[] = []
  private readonly exitHandlers: ((code: number | null) => void)[] = []

  constructor() {
    startPieceHost(
      {
        postMessage: (m) => {
          if (!this.alive) return
          const copy = structuredClone(m)
          setImmediate(() => this.alive && this.toMain.forEach((h) => h(copy)))
        },
        onMessage: (h) => this.toHost.push(h)
      },
      loadBundledPiece,
      {
        lookup: async () => {
          throw new Error('DNS lookups are disabled in this test')
        }
      }
    )
  }

  postMessage(m: HostInboundMessage): void {
    if (!this.alive) return
    const copy = structuredClone(m)
    setImmediate(() => this.alive && this.toHost.forEach((h) => h(copy)))
  }

  onMessage(h: (m: HostOutboundMessage) => void): void {
    this.toMain.push(h)
  }

  onExit(h: (code: number | null) => void): void {
    this.exitHandlers.push(h)
  }

  kill(): void {
    this.exit(null)
  }

  crash(code: number): void {
    this.exit(code)
  }

  private exit(code: number | null): void {
    if (!this.alive) return
    this.alive = false
    setImmediate(() => this.exitHandlers.forEach((h) => h(code)))
  }
}

interface Harness {
  store: ConnectorStore
  client: PieceHostClient
  processes: FakeHostProcess[]
  runtime: BridgeRuntime
}

// ── Test state ──────────────────────────────────────────────────

let db: DatabaseManager
let instanceId: string
let projectId: string
let sourceId: string
let config: Record<string, unknown>
let ctx: PluginContext
let now: number
let api: FakeTrelloApi
let harnesses: Harness[]
let realFetch: typeof globalThis.fetch
let tlsEnv: string | undefined
type ConsoleSpy = { mock: { calls: unknown[][] }; mockRestore(): void }
let consoleError: ConsoleSpy
let consoleWarn: ConsoleSpy

/** A fresh store, client and host factory on the shared database ("app run"). */
function makeHarness(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Harness {
  const store = new ConnectorStore(db)
  const processes: FakeHostProcess[] = []
  const credentials = { get: () => CREDS }
  const client = new PieceHostClient({
    createTransport: () => {
      const p = new FakeHostProcess()
      processes.push(p)
      return p
    },
    kv: kvBackendFromConnectorStore(store),
    credentials,
    defaultTimeoutMs: opts.timeoutMs ?? 5_000
  })
  const runtime: BridgeRuntime = {
    store,
    credentials,
    client: { call: (req) => client.call(opts.signal ? { ...req, signal: opts.signal } : req) }
  }
  const harness = { store, client, processes, runtime }
  harnesses.push(harness)
  return harness
}

const engineOptions = () => ({ retry: RETRY, itemMaxAttempts: 3, now: () => now, log: () => undefined })

function makeEngine(h: Harness = makeHarness()): ConnectorBridgeEngine {
  return new ConnectorBridgeEngine({ ...engineOptions(), runtime: h.runtime })
}

function makePlugin(h: Harness = makeHarness()): ConnectorBridgePlugin {
  return new ConnectorBridgePlugin({ runtime: () => h.runtime, engine: engineOptions() })
}

function tasks() {
  return db.getTasks({ projectId }).filter((t) => t.source_id === sourceId)
}

function snapshot() {
  return tasks().map((t) => ({ id: t.id, external_id: t.external_id, title: t.title, status: t.status, due_date: t.due_date }))
}

function listRequests(): ApiRequest[] {
  return api.requests.filter((r) => r.method === 'GET' && r.url.pathname === `/1/boards/${BOARD}/cards`)
}

function putRequests(): ApiRequest[] {
  return api.requests.filter((r) => r.method === 'PUT')
}

async function untilRequests(count: number): Promise<void> {
  for (let i = 0; i < 400 && api.requests.length < count; i++) await new Promise((r) => setTimeout(r, 5))
  expect(api.requests.length).toBeGreaterThanOrEqual(count)
}

function loggedText(): string {
  return [...consoleError.mock.calls, ...consoleWarn.mock.calls].map((c) => c.map((v) => String(v)).join(' ')).join('\n')
}

beforeEach(() => {
  ;({ db } = createTestDb())
  instanceId = new ConnectorStore(db).createInstance({ pieceName: PIECE, pieceVersion: VERSION }).id
  projectId = db.createProject({ name: 'Trello project' })!.id
  config = { piece_name: PIECE, connector_instance_id: instanceId, props: { board_id: BOARD }, poll_interval_minutes: 10 }
  sourceId = db.createTaskSource({ name: 'Trello', plugin_id: 'connector-bridge', mcp_server_id: null, project_id: projectId, config })!.id
  ctx = { db, sourceId }
  now = 1_700_000_000_000
  harnesses = []
  api = new FakeTrelloApi()
  realFetch = globalThis.fetch
  globalThis.fetch = api.fetch as unknown as typeof globalThis.fetch
  tlsEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  // pieces-common logs every failed request; keep the output quiet and inspectable.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  const gate = api.gate
  api.gate = null
  gate?.resolve()
  for (const h of harnesses) h.client.dispose()
  globalThis.fetch = realFetch
  if (tlsEnv === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsEnv
  consoleError.mockRestore()
  consoleWarn.mockRestore()
})

// ── Success criterion: allowlist entry + declarative mapping only ──

describe('Trello is only an allowlist entry and a declarative mapping', () => {
  it('mentions Trello in no connector source file except the allowlist, the mapping and the static registry', () => {
    const root = join(__dirname, '..')
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && /trello/i.test(readFileSync(path, 'utf8'))) {
          hits.push(relative(root, path))
        }
      }
    }
    walk(root)
    expect(hits.sort()).toEqual(['allowlist.ts', 'bridge/mappings.ts', 'piece-host/piece-registry.ts'])
  })

  it('has a mapping that is pure data and only names allowlisted operations that exist in the pinned piece', () => {
    const mapping = CONNECTOR_TASK_MAPPINGS[PIECE]
    expect(JSON.parse(JSON.stringify(mapping))).toEqual(mapping)
    expect(mapping.import.target).toEqual({ type: 'action', name: 'list_cards_in_board' })
    expect(mapping.update?.action).toBe('update_card')

    const loaded = loadBundledPiece(PIECE)!
    expect(loaded.version).toBe(VERSION)
    const piece = loaded.module.trello as {
      getAction(name: string): unknown
      getTrigger(name: string): { type?: string } | undefined
    }
    const entry = CONNECTOR_PIECE_ALLOWLIST.pieces[PIECE]
    for (const name of Object.keys(entry.actions)) expect(piece.getAction(name), name).toBeDefined()
    for (const name of Object.keys(entry.triggers)) expect(piece.getTrigger(name)?.type, name).toBe('POLLING')
  })

  it('refuses Trello operations outside the allowlist before a host is started', async () => {
    const h = makeHarness()
    const base = { instanceId, pieceName: PIECE, pieceVersion: VERSION }
    await expect(h.client.runAction({ ...base, actionName: 'delete_card', propsValue: { card_id: 'a' } })).rejects.toBeInstanceOf(PieceNotAllowedError)
    await expect(h.client.runAction({ ...base, actionName: 'custom_api_call' })).rejects.toBeInstanceOf(PieceNotAllowedError)
    await expect(h.client.runTrigger({ ...base, triggerName: 'new_card', hook: 'onEnable' })).rejects.toBeInstanceOf(PieceNotAllowedError)
    expect(h.processes).toHaveLength(0)
  })
})

// ── Import ──────────────────────────────────────────────────────

describe('import through the real list_cards_in_board action', () => {
  it('maps board cards to canonical task fields and never creates tasks for archived cards', async () => {
    api.add(
      card('a', {
        name: 'Fix the login bug',
        desc: 'Users see a blank page.',
        due: '2026-10-01T12:00:00.000Z',
        labels: [
          { id: 'l1', name: 'bug', color: 'red' },
          { id: 'l2', name: 'urgent', color: 'orange' }
        ]
      })
    )
    api.add(card('b', { name: 'No due date' }))
    api.add(card('c', { name: 'Archived long ago', closed: true }))

    const plugin = makePlugin()
    expect(await plugin.importTasks(sourceId, config, ctx)).toEqual({ imported: 2, updated: 0, errors: [] })

    const a = db.getTaskByExternalId(sourceId, 'a')!
    expect(a).toMatchObject({
      title: 'Fix the login bug',
      due_date: '2026-10-01T12:00:00.000Z',
      labels: ['bug', 'urgent'],
      status: TaskStatus.NotStarted,
      project_id: projectId,
      source: 'Trello'
    })
    expect(a.description).toBe('Users see a blank page.\n\n[Open in Trello](https://trello.com/c/a/card-a)')
    expect(db.getTaskByExternalId(sourceId, 'b')).toMatchObject({ title: 'No due date', due_date: null })
    expect(db.getTaskByExternalId(sourceId, 'c')).toBeUndefined()

    // The piece called Trello exactly as the mapping describes: key + token auth, filter=all.
    const [req] = listRequests()
    expect(listRequests()).toHaveLength(1)
    expect(req.url.origin).toBe('https://api.trello.com')
    expect(req.url.searchParams.get('filter')).toBe('all')
    expect(req.url.searchParams.get('key')).toBe(API_KEY)
    expect(req.url.searchParams.get('token')).toBe(TOKEN)
  })

  it('keeps certificate verification on although pieces-common switches it off per request', async () => {
    // pieces-common 0.12.5 (bundled in piece-trello 0.6.0) runs
    // `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` inside sendRequest().
    // host-entry installs the TLS guard first; this test installs it the same
    // way (the harness starts the runtime in-process) and checks it holds.
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    const seen: Array<string | undefined> = []
    const fake = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { seen.push(process.env.NODE_TLS_REJECT_UNAUTHORIZED); return fake(input, init) }) as typeof globalThis.fetch
    installTlsGuard()
    api.add(card('a'))
    await makePlugin().importTasks(sourceId, config, ctx)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((v) => v === undefined)).toBe(true)
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
  })

  it('upserts idempotently: duplicate cards in one response and across syncs yield one task', async () => {
    const a = api.add(card('a'))
    api.overrides.push((req) => (req.method === 'GET' ? json(200, [a, a, { ...a }]) : undefined))
    const plugin = makePlugin()
    const first = await plugin.importTasks(sourceId, config, ctx)
    expect(first.imported + first.updated).toBe(3)
    expect(first.imported).toBe(1)
    expect(tasks()).toHaveLength(1)

    a.name = 'Renamed at the source'
    const second = await plugin.importTasks(sourceId, config, ctx)
    expect(second).toEqual({ imported: 0, updated: 3, errors: [] })
    expect(tasks()).toHaveLength(1)
    expect(db.getTaskByExternalId(sourceId, 'a')?.title).toBe('Renamed at the source')
  })

  it(
    'pagination: the action returns the whole board in one response and the bridge caps a sync at 1000 items',
    async () => {
      for (let i = 1; i <= BRIDGE_MAX_ITEMS_PER_SYNC + 1; i++) api.add(card(`p${String(i).padStart(4, '0')}`))
      const result = await makePlugin().importTasks(sourceId, config, ctx)
      expect(result.imported).toBe(BRIDGE_MAX_ITEMS_PER_SYNC)
      expect(result.errors).toEqual([`Trello returned ${BRIDGE_MAX_ITEMS_PER_SYNC + 1} items; only the first ${BRIDGE_MAX_ITEMS_PER_SYNC} were imported.`])
      // The piece asked once, without a page cursor: pagination is not something it offers.
      expect(listRequests()).toHaveLength(1)
      expect([...listRequests()[0].url.searchParams.keys()].sort()).toEqual(['filter', 'key', 'token'])
    },
    LONG
  )

  it('completes a cached task when its card is archived; a list move alone is not mapped to a status', async () => {
    const a = api.add(card('a'))
    const b = api.add(card('b'))
    const plugin = makePlugin()
    await plugin.importTasks(sourceId, config, ctx)

    a.closed = true
    b.idList = LIST_DONE
    await plugin.importTasks(sourceId, config, ctx)
    expect(db.getTaskByExternalId(sourceId, 'a')?.status).toBe(TaskStatus.Completed)
    // Known gap (docs/connectors.md): the mapping has no list -> status rule.
    expect(db.getTaskByExternalId(sourceId, 'b')?.status).toBe(TaskStatus.NotStarted)

    a.closed = false
    await plugin.importTasks(sourceId, config, ctx)
    expect(db.getTaskByExternalId(sourceId, 'a')?.status).toBe(TaskStatus.NotStarted)
  })
})

// ── Round trip ──────────────────────────────────────────────────

describe('round trip through the real update_card action', () => {
  it('archives the card at the source before the task completes locally', async () => {
    const a = api.add(card('a'))
    const plugin = makePlugin()
    await plugin.importTasks(sourceId, config, ctx)
    const task = db.getTaskByExternalId(sourceId, 'a')!

    const result = await plugin.executeAction(PluginActionId.Complete, task, undefined, config, ctx)
    expect(result).toEqual({ success: true, taskUpdate: { status: TaskStatus.Completed } })
    expect(putRequests()).toHaveLength(1)
    expect(putRequests()[0].url.pathname).toBe('/1/cards/a')
    expect(putRequests()[0].body).toEqual({ closed: true })
    expect(a.closed).toBe(true)

    await plugin.importTasks(sourceId, config, ctx)
    expect(db.getTaskByExternalId(sourceId, 'a')?.status).toBe(TaskStatus.Completed)
  })

  it('pushes title, due date and reopen; 21x-only workflow states are never sent', async () => {
    const a = api.add(card('a', { due: '2026-10-01T12:00:00.000Z' }))
    const plugin = makePlugin()
    await plugin.importTasks(sourceId, config, ctx)
    const task = db.getTaskByExternalId(sourceId, 'a')!

    await plugin.exportUpdate(task, { title: 'Ship it', due_date: '2026-12-24', status: TaskStatus.AgentWorking, labels: ['x'] }, config, ctx)
    expect(putRequests()).toHaveLength(1)
    expect(putRequests()[0].body).toEqual({ name: 'Ship it', due: '2026-12-24T00:00:00.000Z' })
    expect(a).toMatchObject({ name: 'Ship it', due: '2026-12-24T00:00:00.000Z' })

    a.closed = true
    await plugin.exportUpdate(task, { status: TaskStatus.NotStarted }, config, ctx)
    expect(putRequests()[1].body).toEqual({ closed: false })
    expect(a.closed).toBe(false)

    await plugin.exportUpdate(task, { status: TaskStatus.ReadyForReview }, config, ctx)
    await plugin.exportUpdate(task, { description: 'not round-tripped' }, config, ctx)
    expect(putRequests()).toHaveLength(2)

    // The next import reads back exactly what was pushed.
    await plugin.importTasks(sourceId, config, ctx)
    expect(db.getTaskByExternalId(sourceId, 'a')).toMatchObject({ title: 'Ship it', due_date: '2026-12-24T00:00:00.000Z', status: TaskStatus.NotStarted })
  })

  it('queues an update that failed with 5xx, keeps the local value on import, and retries it', async () => {
    const a = api.add(card('a'))
    const h = makeHarness()
    const plugin = makePlugin(h)
    await plugin.importTasks(sourceId, config, ctx)
    const task = db.getTaskByExternalId(sourceId, 'a')!
    db.updateTask(task.id, { title: 'Local title' })

    let failuresLeft = 1
    api.overrides.push((req) => {
      if (req.method !== 'PUT' || failuresLeft === 0) return undefined
      failuresLeft--
      return text(503, 'Service Unavailable')
    })
    await plugin.exportUpdate(task, { title: 'Local title' }, config, ctx)
    const pending = readCursor(h.store.getSyncState(instanceId)?.cursor).pending.a
    expect(pending).toMatchObject({ changed: { title: 'Local title' }, attempts: 1, nextRetryAt: now + 1000, lastError: 'HTTP 503: Service Unavailable' })
    expect(a.name).toBe('Card a')

    await plugin.importTasks(sourceId, config, ctx)
    expect(db.getTaskByExternalId(sourceId, 'a')?.title).toBe('Local title')

    now += 1000
    await plugin.importTasks(sourceId, config, ctx)
    expect(a.name).toBe('Local title')
    expect(readCursor(h.store.getSyncState(instanceId)?.cursor).pending).toEqual({})
    expect(h.store.listDeadLetters(instanceId)).toEqual([])
  })
})

// ── Failure matrix ──────────────────────────────────────────────

describe('failure matrix', () => {
  it('401 (revoked token): a clear permanent error, no retries, no task changes, no leaked secrets', async () => {
    api.add(card('a'))
    api.add(card('b'))
    const h = makeHarness()
    const plugin = makePlugin(h)
    await plugin.importTasks(sourceId, config, ctx)
    const before = snapshot()

    api.token = 'a-new-token-after-revocation-0000000000'
    const result = await plugin.importTasks(sourceId, config, ctx)
    expect(result).toMatchObject({ imported: 0, updated: 0 })
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('Permission denied')
    expect(result.errors[0]).toContain('Existing tasks were kept')
    expect(h.store.getSyncState(instanceId)).toMatchObject({ attemptCount: 0, nextRetryAt: null })
    expect(h.store.getSyncState(instanceId)?.lastError).toContain('Permission denied')
    expect(h.store.listDeadLetters(instanceId)).toEqual([])
    expect(snapshot()).toEqual(before)

    // Cached tasks stay usable, and the completion gate fails cleanly instead of closing the task.
    const task = db.getTaskByExternalId(sourceId, 'a')!
    expect(db.updateTask(task.id, { title: 'Edited while disconnected' })?.title).toBe('Edited while disconnected')
    const action = await plugin.executeAction(PluginActionId.Complete, task, undefined, config, ctx)
    expect(action).toEqual({ success: false, error: 'HTTP 401: invalid token' })
    expect(db.getTaskByExternalId(sourceId, 'a')?.status).toBe(TaskStatus.NotStarted)

    for (const s of [JSON.stringify(result), JSON.stringify(action), h.store.getSyncState(instanceId)?.lastError ?? '', loggedText()]) {
      expect(s).not.toContain(TOKEN)
      expect(s).not.toContain(API_KEY)
    }
  })

  it('429: backs off, blocks even manual syncs for the window, then recovers', async () => {
    api.add(card('a'))
    let limited = true
    api.overrides.push((req) => (req.method === 'GET' && limited ? text(429, 'Rate limit exceeded', { 'retry-after': '120' }) : undefined))
    const h = makeHarness()
    const engine = makeEngine(h)

    const result = await engine.sync(sourceId, config, ctx, { manual: true })
    expect(result.errors[0]).toContain('attempt 1 of 3')
    expect(result.errors[0]).toContain('rate limit')
    const state = h.store.getSyncState(instanceId)!
    expect(state.attemptCount).toBe(1)
    // pieces-common drops response headers, so the 120 s Retry-After never
    // reaches the bridge: it falls back to its own backoff (1 s in this test).
    expect(state.nextRetryAt).toBe(now + 1000)
    expect(readCursor(state.cursor).rateLimitedUntil).toBe(now + 1000)

    const early = await engine.sync(sourceId, config, ctx, { manual: true })
    expect(early.errors[0]).toContain('slow down')
    expect(listRequests()).toHaveLength(1)

    limited = false
    now += 1000
    expect(await engine.sync(sourceId, config, ctx)).toEqual({ imported: 1, updated: 0, errors: [] })
    expect(h.store.getSyncState(instanceId)).toMatchObject({ attemptCount: 0, nextRetryAt: null, lastError: null })
  })

  it('5xx: exponential backoff, then a dead letter; cached tasks are untouched and editable throughout', async () => {
    api.add(card('a'))
    api.add(card('b'))
    const h = makeHarness()
    const engine = makeEngine(h)
    expect((await engine.sync(sourceId, config, ctx)).imported).toBe(2)
    const before = snapshot()

    api.overrides.push((req) => (req.method === 'GET' ? text(503, 'Service Unavailable') : undefined))
    await engine.sync(sourceId, config, ctx)
    expect(h.store.getSyncState(instanceId)).toMatchObject({ attemptCount: 1, nextRetryAt: now + 1000, lastError: 'HTTP 503: Service Unavailable' })

    expect((await engine.sync(sourceId, config, ctx)).errors[0]).toContain('Waiting until')
    expect(listRequests()).toHaveLength(2)

    now += 1000
    await engine.sync(sourceId, config, ctx)
    expect(h.store.getSyncState(instanceId)).toMatchObject({ attemptCount: 2, nextRetryAt: now + 2000 })

    now += 2000
    const last = await engine.sync(sourceId, config, ctx)
    expect(last.errors[0]).toContain('failed 3 times and was moved to dead letters: HTTP 503: Service Unavailable')
    expect(h.store.getSyncState(instanceId)).toMatchObject({ attemptCount: 0, nextRetryAt: null })
    expect(h.store.listDeadLetters(instanceId)).toMatchObject([{ externalId: null, attempts: 3, error: 'HTTP 503: Service Unavailable' }])

    expect(snapshot()).toEqual(before)
    const task = db.getTaskByExternalId(sourceId, 'a')!
    expect(db.updateTask(task.id, { title: 'Edited while Trello is down' })?.title).toBe('Edited while Trello is down')
  })

  it('cancellation mid-sync fails cleanly without backoff; the next sync starts a fresh host', async () => {
    api.add(card('a'))
    const controller = new AbortController()
    const h = makeHarness({ signal: controller.signal })
    const engine = makeEngine(h)
    await engine.sync(sourceId, config, ctx)
    const before = snapshot()

    const gate = deferred()
    api.gate = gate
    const pending = engine.sync(sourceId, config, ctx, { manual: true })
    await untilRequests(2)
    controller.abort()
    const result = await pending
    expect(result.errors[0]).toContain('cancelled')
    expect(result.errors[0]).toContain('Existing tasks were kept')
    expect(h.processes[0].alive).toBe(false)
    expect(h.store.getSyncState(instanceId)).toMatchObject({ attemptCount: 0, nextRetryAt: null })
    expect(snapshot()).toEqual(before)

    api.gate = null
    gate.resolve()
    const fresh = makeHarness()
    expect(await makeEngine(fresh).sync(sourceId, config, ctx)).toEqual({ imported: 0, updated: 1, errors: [] })
    expect(fresh.processes).toHaveLength(1)
  })

  it('piece host crash mid-sync is retried with backoff and the host is restarted', async () => {
    api.add(card('a'))
    const h = makeHarness()
    const engine = makeEngine(h)
    const gate = deferred()
    api.gate = gate
    const pending = engine.sync(sourceId, config, ctx)
    await untilRequests(1)
    h.processes[0].crash(134)
    const result = await pending
    expect(result.errors[0]).toContain('attempt 1 of 3')
    expect(result.errors[0]).toContain('stopped unexpectedly (exit code 134)')
    expect(h.store.getSyncState(instanceId)).toMatchObject({ attemptCount: 1, nextRetryAt: now + 1000 })
    expect(tasks()).toHaveLength(0)

    api.gate = null
    gate.resolve()
    now += 1000
    expect(await engine.sync(sourceId, config, ctx)).toEqual({ imported: 1, updated: 0, errors: [] })
    expect(h.client.starts).toBe(2)
    expect(h.processes).toHaveLength(2)
  })

  it('a hung piece call times out, the host is killed, and the sync fails cleanly', async () => {
    api.add(card('a'))
    const h = makeHarness({ timeoutMs: 500 })
    const engine = makeEngine(h)
    const gate = deferred()
    api.gate = gate
    const result = await engine.sync(sourceId, config, ctx)
    expect(result.errors[0]).toContain('did not finish within 500 ms')
    expect(result.errors[0]).toContain('attempt 1 of 3')
    expect(h.processes[0].alive).toBe(false)
    expect(h.store.getSyncState(instanceId)).toMatchObject({ attemptCount: 1, nextRetryAt: now + 1000 })

    api.gate = null
    gate.resolve()
    now += 1000
    expect(await engine.sync(sourceId, config, ctx)).toEqual({ imported: 1, updated: 0, errors: [] })
    expect(h.processes).toHaveLength(2)
  })

  it('an app restart during a failed sync resumes from the persisted attempt state', async () => {
    api.add(card('a'))
    api.add(card('b'))
    const first = makeHarness()
    expect((await makeEngine(first).sync(sourceId, config, ctx)).imported).toBe(2)
    let down = true
    api.overrides.push((req) => (req.method === 'GET' && down ? text(502, 'Bad Gateway') : undefined))
    await makeEngine(first).sync(sourceId, config, ctx)
    const retryAt = first.store.getSyncState(instanceId)!.nextRetryAt!
    first.client.dispose()

    // "Restart": a new store, client, engine and scheduler on the same database.
    const second = makeHarness()
    const engine = makeEngine(second)
    const runSource = vi.fn(async (id: string) => {
      await engine.sync(id, db.getTaskSource(id)!.config, { db, sourceId: id })
    })
    const scheduler = new BridgeScheduler({ db, store: second.store, isBusy: (id) => engine.isBusy(id), runSource, now: () => now })
    await scheduler.tick()
    expect(runSource).not.toHaveBeenCalled()
    expect(tasks()).toHaveLength(2)

    now = retryAt
    await scheduler.tick()
    expect(runSource).toHaveBeenCalledWith(sourceId)
    expect(second.store.getSyncState(instanceId)).toMatchObject({ attemptCount: 2, lastError: 'HTTP 502: Bad Gateway' })

    down = false
    now = second.store.getSyncState(instanceId)!.nextRetryAt!
    await scheduler.tick()
    expect(second.store.getSyncState(instanceId)).toMatchObject({ attemptCount: 0, nextRetryAt: null, lastError: null })
    expect(tasks()).toHaveLength(2)
  })

  it('an app restart while a sync is in flight leaves no partial state; both runs converge on the same tasks', async () => {
    api.add(card('a'))
    api.add(card('b'))
    const gate = deferred()
    api.gate = gate
    const orphan = makeHarness()
    const orphanSync = makeEngine(orphan).sync(sourceId, config, ctx, { manual: true })
    await untilRequests(1)
    // Nothing was written before the piece answered.
    expect(orphan.store.getSyncState(instanceId)).toBeNull()
    expect(tasks()).toHaveLength(0)

    api.gate = null
    const restarted = makeHarness()
    expect(await makeEngine(restarted).sync(sourceId, config, ctx, { manual: true })).toEqual({ imported: 2, updated: 0, errors: [] })

    gate.resolve()
    expect(await orphanSync).toEqual({ imported: 0, updated: 2, errors: [] })
    expect(tasks()).toHaveLength(2)
  })
})

// ── Polling trigger cursor ──────────────────────────────────────

describe('real deadline polling trigger', () => {
  it('keeps its poll cursor in connector_kv across an app restart', async () => {
    const base = { instanceId, pieceName: PIECE, pieceVersion: VERSION, triggerName: 'deadline' as const }
    const propsValue = { board_id: BOARD, time_before_due: 24, time_unit: 'hours' }
    const soon = api.add(card('soon', { due: new Date(Date.now() + 60 * 60_000).toISOString() }))
    api.add(card('far', { due: new Date(Date.now() + 72 * 60 * 60_000).toISOString() }))
    api.add(card('done', { due: soon.due, dueComplete: true }))

    const first = makeHarness()
    const enabledAt = Date.now()
    await first.client.runTrigger({ ...base, hook: 'onEnable', propsValue })
    expect(first.store.kvGet(instanceId, 'flow', 'lastPoll')).toBeGreaterThanOrEqual(enabledAt)
    const out = (await first.client.runTrigger({ ...base, hook: 'run', propsValue })) as TrelloCard[]
    expect(out.map((c) => c.id)).toEqual(['soon'])
    expect(first.store.kvGet(instanceId, 'flow', 'lastPoll')).toBe(Date.parse(soon.due!))
    first.client.dispose()

    const second = makeHarness()
    expect(await second.client.runTrigger({ ...base, hook: 'run', propsValue })).toEqual([])
    const later = api.add(card('later', { due: new Date(Date.now() + 2 * 60 * 60_000).toISOString() }))
    const next = (await second.client.runTrigger({ ...base, hook: 'run', propsValue })) as TrelloCard[]
    expect(next.map((c) => c.id)).toEqual(['later'])
    expect(second.store.kvGet(instanceId, 'flow', 'lastPoll')).toBe(Date.parse(later.due!))
  })
})

// ── 100 items ───────────────────────────────────────────────────

describe('100-item import and update', () => {
  it(
    'imports 100 cards, round-trips 100 updates, and reports every per-item failure by card id',
    async () => {
      for (let i = 1; i <= 100; i++) api.add(card(`c-${String(i).padStart(3, '0')}`, { due: `2026-11-${String((i % 28) + 1).padStart(2, '0')}T09:00:00.000Z` }))
      // One card the mapping cannot accept (Trello would not send this; it exercises the per-item path).
      api.cards.get('c-100')!.due = 'someday'

      const h = makeHarness()
      const plugin = makePlugin(h)
      const imported = await plugin.importTasks(sourceId, config, ctx)
      expect(imported.imported).toBe(99)
      expect(imported.errors).toEqual(['Trello item c-100: due date at "due" is not a valid date (attempt 1 of 3)'])
      expect(tasks()).toHaveLength(99)

      // c-007 was deleted in Trello; c-042 hits one transient 503.
      api.cards.delete('c-007')
      let transient = 1
      api.overrides.push((req) => {
        if (req.method === 'PUT' && req.url.pathname === '/1/cards/c-042' && transient > 0) {
          transient--
          return text(503, 'Service Unavailable')
        }
        return undefined
      })
      // As in the app: the local edit lands first, then the change is pushed to the source.
      for (const task of tasks()) {
        const title = `Renamed ${task.external_id}`
        db.updateTask(task.id, { title })
        await plugin.exportUpdate(task, { title }, config, ctx)
      }
      expect(putRequests()).toHaveLength(99)
      const renamed = [...api.cards.values()].filter((c) => c.name.startsWith('Renamed ')).map((c) => c.id)
      expect(renamed).toHaveLength(97)
      expect(renamed).not.toContain('c-042')

      const dead = h.store.listDeadLetters(instanceId)
      expect(dead).toHaveLength(1)
      expect(dead[0]).toMatchObject({ externalId: 'c-007', attempts: 1, error: 'HTTP 404: The requested resource was not found.' })
      expect(loggedText()).toContain('failed: HTTP 404: The requested resource was not found.')
      const cursor = readCursor(h.store.getSyncState(instanceId)?.cursor)
      expect(Object.keys(cursor.pending)).toEqual(['c-042'])
      expect(cursor.pending['c-042']).toMatchObject({ attempts: 1, lastError: 'HTTP 503: Service Unavailable' })

      // The next sync retries the queued update first, then imports the renamed titles.
      now += 1000
      const second = await plugin.importTasks(sourceId, config, ctx)
      expect(api.cards.get('c-042')?.name).toBe('Renamed c-042')
      expect(second.updated).toBe(98)
      expect(second.errors).toEqual(['Trello item c-100: due date at "due" is not a valid date (attempt 2 of 3)'])
      expect(readCursor(h.store.getSyncState(instanceId)?.cursor).pending).toEqual({})
      // The deleted card's task is kept; a failed sync or update never deletes tasks.
      expect(db.getTaskByExternalId(sourceId, 'c-007')?.title).toBe('Renamed c-007')
      for (const task of tasks()) expect(task.title).toBe(`Renamed ${task.external_id}`)
      expect(JSON.stringify(dead)).not.toContain(TOKEN)
    },
    LONG
  )
})
